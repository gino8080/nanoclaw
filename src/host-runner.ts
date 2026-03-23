/**
 * Host Runner — executes Claude Code directly on the host via Agent SDK.
 *
 * Used for Discord project channels where sessions should live in the
 * project's own .claude/ directory, enabling `claude --resume` from terminal.
 *
 * Same interface as container-runner but no container isolation.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { query, renameSession } from '@anthropic-ai/claude-agent-sdk';

import { ContainerInput, ContainerOutput } from './container-runner.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

/**
 * Extract a clean session title from the raw prompt.
 * NanoClaw wraps messages in XML: <messages><message sender="..." time="...">text</message>...
 * Extract the actual user text for a readable session name.
 */
function extractSessionTitle(prompt: string, groupName: string): string {
  // Extract last message content from XML wrapping
  const msgMatch = prompt.match(
    /<message[^>]*>([^<]+)<\/message>\s*<\/messages>/,
  );
  if (msgMatch) {
    const text = msgMatch[1].trim();
    const truncated = text.length > 80 ? text.slice(0, 77) + '...' : text;
    return `[${groupName}] ${truncated}`;
  }
  // Fallback: use first 80 chars of prompt
  const clean = prompt.replace(/<[^>]+>/g, '').trim();
  const truncated = clean.length > 80 ? clean.slice(0, 77) + '...' : clean;
  return `[${groupName}] ${truncated}`;
}

/**
 * Resolve the claude binary path — needed by the Agent SDK.
 * Checks common locations since launchd PATH may differ from shell.
 */
function resolveClaudeBinary(): string {
  const candidates = [
    process.env.CLAUDE_CODE_CLI,
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'claude'; // fallback to PATH
}

/**
 * Determine the project working directory from the group's additionalMounts.
 * Falls back to the group folder if no mounts configured.
 */
function resolveProjectCwd(group: RegisteredGroup): string {
  const mounts = group.containerConfig?.additionalMounts;
  if (mounts && mounts.length > 0) {
    const hostPath = mounts[0].hostPath;
    // Expand ~ to home directory
    if (hostPath.startsWith('~/')) {
      return path.join(os.homedir(), hostPath.slice(2));
    }
    return path.resolve(hostPath);
  }
  return resolveGroupFolderPath(group.folder);
}

export async function runHostAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: null, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const projectCwd = resolveProjectCwd(group);
  const groupDir = resolveGroupFolderPath(group.folder);

  const agentName = `nanoclaw-host-${group.folder}-${Date.now()}`;
  logger.info(
    {
      group: group.name,
      cwd: projectCwd,
      agentName,
      sessionId: input.sessionId || 'new',
    },
    'Spawning host agent',
  );

  // Register a null process — host runner doesn't have a ChildProcess
  // but the queue needs to know it's active
  onProcess(null, agentName);

  // Build environment from .env (same secrets the container gets)
  const envKeys = [
    'OPENAI_API_KEY',
    'IMAGE_WEBHOOK_URL',
    'GOOGLE_MAPS_API_KEY',
    'NANOCLAW_CALENDAR_ID',
    'FIRECRAWL_API_KEY',
  ];
  const envVars = readEnvFile(envKeys);

  // Additional directories for CLAUDE.md loading
  const additionalDirs: string[] = [];
  const globalDir = path.join(process.cwd(), 'groups', 'global');
  if (fs.existsSync(globalDir)) {
    additionalDirs.push(globalDir);
  }
  if (fs.existsSync(groupDir)) {
    additionalDirs.push(groupDir);
  }

  let sessionId: string | undefined;
  let lastResult: string | null = null;

  try {
    for await (const message of query({
      prompt: input.prompt,
      options: {
        cwd: projectCwd,
        additionalDirectories:
          additionalDirs.length > 0 ? additionalDirs : undefined,
        resume: input.sessionId,
        allowedTools: [
          'Bash',
          'Read',
          'Write',
          'Edit',
          'Glob',
          'Grep',
          'WebSearch',
          'WebFetch',
          'Task',
          'TaskOutput',
          'TaskStop',
          'TeamCreate',
          'TeamDelete',
          'SendMessage',
          'TodoWrite',
          'ToolSearch',
          'Skill',
          'NotebookEdit',
        ],
        env: {
          ...process.env,
          ...envVars,
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
        },
        pathToClaudeCodeExecutable: resolveClaudeBinary(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
      },
    })) {
      // Track session ID from init message
      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = (message as { session_id: string }).session_id;
        logger.info(
          { sessionId, cwd: projectCwd },
          'Host agent session initialized',
        );
      }

      // Stream results back via callback
      if (message.type === 'result') {
        const resultMsg = message as {
          subtype: string;
          result?: string;
          is_error?: boolean;
        };
        lastResult = resultMsg.result || null;

        const output: ContainerOutput = {
          status: resultMsg.is_error ? 'error' : 'success',
          result: lastResult,
          newSessionId: sessionId,
        };

        if (onOutput) {
          await onOutput(output);
        }
      }
    }

    // Rename session for readable /resume listing
    if (sessionId && !input.sessionId) {
      try {
        const title = extractSessionTitle(input.prompt, group.name);
        await renameSession(sessionId, title, { dir: projectCwd });
      } catch (renameErr) {
        logger.debug({ renameErr }, 'Failed to rename session (non-critical)');
      }
    }

    const finalOutput: ContainerOutput = {
      status: 'success',
      result: lastResult,
      newSessionId: sessionId,
    };

    logger.info(
      { group: group.name, sessionId, cwd: projectCwd },
      'Host agent completed',
    );

    return finalOutput;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ group: group.name, err: errorMessage }, 'Host agent error');

    return {
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    };
  }
}
