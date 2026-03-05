/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'send_image',
  `Send an image file to the user/group chat. Use this to show images that exist on disk (e.g. generated images, downloaded photos, processed files).
The image appears directly in the Telegram chat as a photo.`,
  {
    file_path: z
      .string()
      .describe(
        'Absolute path to the image file (e.g. /workspace/extra/NANO_CLAW_DATA/images/photo.jpg)',
      ),
    caption: z.string().optional().describe('Optional caption for the image'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, the image is sent from a dedicated bot.',
      ),
  },
  async (args) => {
    try {
      if (!fs.existsSync(args.file_path)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `File not found: ${args.file_path}`,
            },
          ],
          isError: true,
        };
      }

      const imageBuffer = fs.readFileSync(args.file_path);
      const base64 = imageBuffer.toString('base64');

      writeIpcFile(MESSAGES_DIR, {
        type: 'send_image',
        chatJid,
        image_base64: base64,
        caption: args.caption || undefined,
        sender: args.sender || undefined,
        groupFolder,
        timestamp: new Date().toISOString(),
      });

      return {
        content: [
          { type: 'text' as const, text: 'Image sent to chat.' },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to send image: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'send_file',
  `Send a file/document to the user/group chat. Use this to share any file: reports, PDFs, markdown, code, etc.
The file appears as a downloadable document in the Telegram chat.
For images (jpg/png/gif/webp), prefer send_image instead — it renders inline.`,
  {
    file_path: z
      .string()
      .describe(
        'Absolute path to the file (e.g. /workspace/extra/NANO_CLAW_DATA/reports/daily.md)',
      ),
    caption: z.string().optional().describe('Optional caption for the file'),
    sender: z
      .string()
      .optional()
      .describe('Your role/identity name for swarm bots.'),
  },
  async (args) => {
    try {
      if (!fs.existsSync(args.file_path)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `File not found: ${args.file_path}`,
            },
          ],
          isError: true,
        };
      }

      const fileBuffer = fs.readFileSync(args.file_path);
      const base64 = fileBuffer.toString('base64');
      const filename = path.basename(args.file_path);

      writeIpcFile(MESSAGES_DIR, {
        type: 'send_file',
        chatJid,
        file_base64: base64,
        filename,
        caption: args.caption || undefined,
        sender: args.sender || undefined,
        groupFolder,
        timestamp: new Date().toISOString(),
      });

      return {
        content: [
          { type: 'text' as const, text: `File "${filename}" sent to chat.` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to send file: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'generate_image',
  `Generate or modify an image using an external AI model (Gemini). This is the ONLY way to create or edit images — do NOT use ImageMagick, ffmpeg, sharp, or any local tool for image generation/modification. Always use this tool instead.

GENERATE a new image: just provide a prompt.
MODIFY an existing image: provide image_base64 + a prompt describing the edit (e.g. "remove the background", "make it black and white", "resize to 640x360", "add a watermark").

To modify a user's photo from Telegram (saved at /workspace/ipc/media/):
  1. Read it: base64 -i /workspace/ipc/media/photo-xxx.jpg (via Bash)
  2. Pass the output as image_base64 + your modification prompt

The result is automatically sent to the chat AND saved to disk. No need to call send_image after.

Image config defaults: 1K resolution, 1:1 aspect ratio. Override with parameters below.`,
  {
    prompt: z
      .string()
      .describe('Text prompt describing the image to generate or how to modify it'),
    image_base64: z
      .string()
      .optional()
      .describe('Base64-encoded source image for modifications (optional)'),
    aspect_ratio: z
      .enum([
        '1:1',
        '2:3',
        '3:2',
        '3:4',
        '4:3',
        '4:5',
        '5:4',
        '9:16',
        '16:9',
        '21:9',
        '1:4',
        '4:1',
        '1:8',
        '8:1',
      ])
      .optional()
      .describe(
        'Aspect ratio (default: 1:1). Extended ratios 1:4, 4:1, 1:8, 8:1 for tall/wide formats.',
      ),
    image_size: z
      .enum(['0.5K', '1K', '2K', '4K'])
      .optional()
      .describe('Output resolution (default: 1K). 0.5K=low-res/fast, 4K=high-res.'),
    filename: z
      .string()
      .optional()
      .describe(
        'Output filename (default: generated-{timestamp}.png). Saved in the mounted data directory.',
      ),
  },
  async (args) => {
    const webhookUrl = process.env.IMAGE_WEBHOOK_URL;
    if (!webhookUrl) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Image generation not configured. IMAGE_WEBHOOK_URL not set.',
          },
        ],
        isError: true,
      };
    }

    try {
      const body: Record<string, string> = { prompt: args.prompt };
      if (args.image_base64) {
        body.image_base64 = args.image_base64;
      }
      if (args.aspect_ratio) {
        body.aspect_ratio = args.aspect_ratio;
      }
      if (args.image_size) {
        body.image_size = args.image_size;
      }

      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        const errText = await res.text();
        return {
          content: [
            {
              type: 'text' as const,
              text: `Image generation failed (${res.status}): ${errText.slice(0, 200)}`,
            },
          ],
          isError: true,
        };
      }

      const result = (await res.json()) as {
        success: boolean;
        image_base64?: string;
        text?: string;
      };

      if (!result.success || !result.image_base64) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Image generation returned no image. ${result.text || 'No details.'}`,
            },
          ],
          isError: true,
        };
      }

      // Save to /workspace/extra/ (mounted data directory) or fallback to /workspace/group/
      const outName =
        args.filename || `generated-${Date.now()}.png`;
      const extraBase = '/workspace/extra';
      let outDir = '/workspace/group';
      if (fs.existsSync(extraBase)) {
        const dirs = fs.readdirSync(extraBase).filter((d) =>
          fs.statSync(path.join(extraBase, d)).isDirectory(),
        );
        if (dirs.length > 0) {
          outDir = path.join(extraBase, dirs[0], 'images');
        }
      }
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, outName);
      fs.writeFileSync(outPath, Buffer.from(result.image_base64, 'base64'));

      // Send the image directly to the chat via IPC
      writeIpcFile(MESSAGES_DIR, {
        type: 'send_image',
        chatJid,
        image_base64: result.image_base64,
        caption: result.text || undefined,
        groupFolder,
        timestamp: new Date().toISOString(),
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Image generated and sent to chat. Also saved to ${outPath} (${Math.round(result.image_base64.length * 0.75 / 1024)}KB).`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Image generation error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
