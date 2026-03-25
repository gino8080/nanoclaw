import fs from 'fs';
import os from 'os';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IPC_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import {
  sendPoolDocument,
  sendPoolMessage,
  sendPoolPhoto,
} from './channels/telegram.js';
import { AvailableGroup } from './container-runner.js';
import { readEnvFile } from './env.js';
import {
  createTask,
  deleteRegisteredGroup,
  deleteTask,
  deleteKnowledge,
  getRegisteredGroup,
  getTaskById,
  listKnowledge,
  searchKnowledge,
  searchMessages,
  searchMessagesFts,
  setRegisteredGroup,
  updateTask,
  upsertKnowledge,
} from './db.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { processListOperation } from './lists.js';
import { logger } from './logger.js';
import { summarizeSearchResults } from './memory-summarizer.js';
import { validateMount } from './mount-security.js';
import { AdditionalMount, RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendPhoto: (jid: string, photo: Buffer, caption?: string) => Promise<void>;
  sendDocument: (
    jid: string,
    file: Buffer,
    filename: string,
    caption?: string,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  stopGroup?: (groupJid: string) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  if (data.sender && data.chatJid.startsWith('tg:')) {
                    await sendPoolMessage(
                      data.chatJid,
                      data.text,
                      data.sender,
                      sourceGroup,
                    );
                  } else {
                    await deps.sendMessage(data.chatJid, data.text);
                  }
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      sourceGroup,
                      sender: data.sender || undefined,
                      viaPool: !!(
                        data.sender && data.chatJid.startsWith('tg:')
                      ),
                    },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (
                data.type === 'send_image' &&
                data.chatJid &&
                data.image_base64
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  const photoBuffer = Buffer.from(data.image_base64, 'base64');
                  if (data.sender && data.chatJid.startsWith('tg:')) {
                    await sendPoolPhoto(
                      data.chatJid,
                      photoBuffer,
                      data.sender,
                      sourceGroup,
                      data.caption,
                    );
                  } else if (data.chatJid.startsWith('tg:')) {
                    await deps.sendPhoto(
                      data.chatJid,
                      photoBuffer,
                      data.caption,
                    );
                  }
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      sourceGroup,
                      sender: data.sender || undefined,
                      size: photoBuffer.length,
                    },
                    'IPC image sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC image attempt blocked',
                  );
                }
              } else if (
                data.type === 'send_file' &&
                data.chatJid &&
                data.file_base64 &&
                data.filename
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  const fileBuffer = Buffer.from(data.file_base64, 'base64');
                  if (data.sender && data.chatJid.startsWith('tg:')) {
                    await sendPoolDocument(
                      data.chatJid,
                      fileBuffer,
                      data.filename,
                      data.sender,
                      sourceGroup,
                      data.caption,
                    );
                  } else if (data.chatJid.startsWith('tg:')) {
                    await deps.sendDocument(
                      data.chatJid,
                      fileBuffer,
                      data.filename,
                      data.caption,
                    );
                  }
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      sourceGroup,
                      filename: data.filename,
                      size: fileBuffer.length,
                    },
                    'IPC file sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC file attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

/**
 * Write an IPC response file for the container to poll.
 */
function writeIpcResponse(
  sourceGroup: string,
  responseType: string,
  requestId: string,
  data: unknown,
): void {
  const responseDir = path.join(DATA_DIR, 'ipc', sourceGroup, responseType);
  fs.mkdirSync(responseDir, { recursive: true });
  const responsePath = path.join(responseDir, `${requestId}.json`);
  const tmpPath = `${responsePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data));
  fs.renameSync(tmpPath, responsePath);
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For manage_list
    requestId?: string;
    action?: string;
    list_type?: string;
    item_data?: string;
    item_id?: string;
    note_text?: string;
    // For search_messages / memory_search
    query?: string;
    limit?: number;
    channel?: string;
    senderName?: string;
    scope?: 'all' | 'messages' | 'knowledge';
    // For memory_store
    key?: string;
    value?: string;
    category?: string;
    source?: string;
    confidence?: number;
    expiresAt?: string;
    // For memory_list
    prefix?: string;
    onlyExpired?: boolean;
    // For mount_project / unmount_project
    projectPath?: string;
    containerPath?: string;
    readonly?: boolean;
    groupJid?: string;
    // For list_projects
    rootPath?: string;
    // For register_discord_project / unregister_discord_project
    guildId?: string;
    channelName?: string;
    discordChannelId?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'manage_list': {
      if (!data.requestId || !data.action || !data.list_type) {
        logger.warn({ data }, 'Invalid manage_list request');
        break;
      }
      const result = processListOperation({
        action: data.action,
        list_type: data.list_type,
        item_data: data.item_data,
        item_id: data.item_id,
        note_text: data.note_text,
        source_group: sourceGroup,
      });

      // Write response for the container to poll
      const responseDir = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup,
        'list_responses',
      );
      fs.mkdirSync(responseDir, { recursive: true });
      const responsePath = path.join(responseDir, `${data.requestId}.json`);
      const tmpPath = `${responsePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(result));
      fs.renameSync(tmpPath, responsePath);

      logger.info(
        {
          requestId: data.requestId,
          action: data.action,
          list_type: data.list_type,
          success: result.success,
          sourceGroup,
        },
        'List operation processed',
      );
      break;
    }

    case 'search_messages': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized search_messages attempt blocked',
        );
        break;
      }
      if (!data.requestId || !data.query) {
        logger.warn({ data }, 'Invalid search_messages request');
        break;
      }
      const searchResults = searchMessagesFts(
        data.query,
        data.chatJid,
        data.channel,
        data.limit,
        data.senderName,
      );

      // Summarize results with LLM (non-blocking, graceful degradation)
      const searchSummary = await summarizeSearchResults(
        data.query,
        searchResults,
      );

      const searchResponseDir = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup,
        'search_responses',
      );
      fs.mkdirSync(searchResponseDir, { recursive: true });
      const searchResponsePath = path.join(
        searchResponseDir,
        `${data.requestId}.json`,
      );
      const searchTmpPath = `${searchResponsePath}.tmp`;
      fs.writeFileSync(
        searchTmpPath,
        JSON.stringify({
          success: true,
          results: searchResults,
          ...(searchSummary.summary && { summary: searchSummary.summary }),
        }),
      );
      fs.renameSync(searchTmpPath, searchResponsePath);

      logger.info(
        {
          requestId: data.requestId,
          query: data.query,
          resultCount: searchResults.length,
          hasSummary: !!searchSummary.summary,
          sourceGroup,
        },
        'Search messages processed',
      );
      break;
    }

    case 'memory_search': {
      if (!data.requestId || !data.query) {
        logger.warn({ data }, 'Invalid memory_search request');
        break;
      }
      const scope = data.scope || 'all';
      const groupFolder = isMain
        ? data.groupFolder || sourceGroup
        : sourceGroup;
      const memLimit = data.limit || 20;

      let knowledgeResults: unknown[] = [];
      let messageResults: unknown[] = [];

      if (scope === 'all' || scope === 'knowledge') {
        knowledgeResults = searchKnowledge(
          groupFolder,
          data.query,
          data.category,
          memLimit,
        );
      }
      if (scope === 'all' || scope === 'messages') {
        messageResults = searchMessagesFts(
          data.query,
          data.chatJid,
          data.channel,
          memLimit,
          data.senderName,
        );
      }

      // Summarize combined results with LLM
      const allMemResults = [...knowledgeResults, ...messageResults];
      const memSummary = await summarizeSearchResults(
        data.query,
        allMemResults,
      );

      const memResponseDir = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup,
        'memory_responses',
      );
      fs.mkdirSync(memResponseDir, { recursive: true });
      const memResponsePath = path.join(
        memResponseDir,
        `${data.requestId}.json`,
      );
      const memTmpPath = `${memResponsePath}.tmp`;
      fs.writeFileSync(
        memTmpPath,
        JSON.stringify({
          success: true,
          knowledge: knowledgeResults,
          messages: messageResults,
          ...(memSummary.summary && { summary: memSummary.summary }),
        }),
      );
      fs.renameSync(memTmpPath, memResponsePath);

      logger.info(
        {
          requestId: data.requestId,
          query: data.query,
          scope,
          knowledgeCount: knowledgeResults.length,
          messageCount: messageResults.length,
          hasSummary: !!memSummary.summary,
          sourceGroup,
        },
        'Memory search processed',
      );
      break;
    }

    case 'memory_store': {
      if (!data.requestId || !data.key || !data.value || !data.category) {
        logger.warn({ data }, 'Invalid memory_store request');
        break;
      }
      const storeGroup = isMain ? data.groupFolder || sourceGroup : sourceGroup;
      const storeResult = upsertKnowledge(
        storeGroup,
        data.key,
        data.value,
        data.category,
        data.source,
        data.confidence,
        data.expiresAt,
      );

      const storeResponseDir = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup,
        'memory_responses',
      );
      fs.mkdirSync(storeResponseDir, { recursive: true });
      const storeResponsePath = path.join(
        storeResponseDir,
        `${data.requestId}.json`,
      );
      const storeTmpPath = `${storeResponsePath}.tmp`;
      fs.writeFileSync(
        storeTmpPath,
        JSON.stringify({ success: true, ...storeResult }),
      );
      fs.renameSync(storeTmpPath, storeResponsePath);

      logger.info(
        {
          requestId: data.requestId,
          key: data.key,
          action: storeResult.action,
          sourceGroup,
        },
        'Memory store processed',
      );
      break;
    }

    case 'memory_list': {
      if (!data.requestId) {
        logger.warn({ data }, 'Invalid memory_list request');
        break;
      }
      const listGroup = isMain ? data.groupFolder || sourceGroup : sourceGroup;
      const listResults = listKnowledge(
        listGroup,
        data.category,
        data.prefix,
        data.onlyExpired,
        data.limit,
      );

      const listResponseDir = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup,
        'memory_responses',
      );
      fs.mkdirSync(listResponseDir, { recursive: true });
      const listResponsePath = path.join(
        listResponseDir,
        `${data.requestId}.json`,
      );
      const listTmpPath = `${listResponsePath}.tmp`;
      fs.writeFileSync(
        listTmpPath,
        JSON.stringify({ success: true, entries: listResults }),
      );
      fs.renameSync(listTmpPath, listResponsePath);

      logger.info(
        {
          requestId: data.requestId,
          count: listResults.length,
          sourceGroup,
        },
        'Memory list processed',
      );
      break;
    }

    case 'memory_delete': {
      if (!data.requestId || !data.key) {
        logger.warn({ data }, 'Invalid memory_delete request');
        break;
      }
      const delGroup = isMain ? data.groupFolder || sourceGroup : sourceGroup;
      const deleted = deleteKnowledge(delGroup, data.key);

      const delResponseDir = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup,
        'memory_responses',
      );
      fs.mkdirSync(delResponseDir, { recursive: true });
      const delResponsePath = path.join(
        delResponseDir,
        `${data.requestId}.json`,
      );
      const delTmpPath = `${delResponsePath}.tmp`;
      fs.writeFileSync(delTmpPath, JSON.stringify({ success: true, deleted }));
      fs.renameSync(delTmpPath, delResponsePath);

      logger.info(
        {
          requestId: data.requestId,
          key: data.key,
          deleted,
          sourceGroup,
        },
        'Memory delete processed',
      );
      break;
    }

    case 'mount_project': {
      if (!data.requestId || !data.projectPath) {
        logger.warn({ data }, 'Invalid mount_project request');
        break;
      }

      // Determine the target group JID for mount modification
      const mountTargetJid = data.groupJid || data.chatJid;
      if (!mountTargetJid) {
        writeIpcResponse(sourceGroup, 'mount_responses', data.requestId, {
          success: false,
          error: 'No target group JID specified',
        });
        break;
      }

      // Authorization: non-main can only mount for themselves
      const mountTargetGroup = registeredGroups[mountTargetJid];
      if (!mountTargetGroup) {
        writeIpcResponse(sourceGroup, 'mount_responses', data.requestId, {
          success: false,
          error: 'Target group not registered',
        });
        break;
      }
      if (!isMain && mountTargetGroup.folder !== sourceGroup) {
        writeIpcResponse(sourceGroup, 'mount_responses', data.requestId, {
          success: false,
          error: 'Unauthorized: can only mount for own group',
        });
        break;
      }

      const mountDef: AdditionalMount = {
        hostPath: data.projectPath,
        containerPath: data.containerPath,
        readonly: data.readonly ?? false,
      };

      // Validate against allowlist
      const mountResult = validateMount(
        mountDef,
        mountTargetGroup.isMain ?? false,
      );
      if (!mountResult.allowed) {
        writeIpcResponse(sourceGroup, 'mount_responses', data.requestId, {
          success: false,
          error: mountResult.reason,
        });
        break;
      }

      // Update containerConfig in DB
      const existingGroup = getRegisteredGroup(mountTargetJid);
      if (!existingGroup) {
        writeIpcResponse(sourceGroup, 'mount_responses', data.requestId, {
          success: false,
          error: 'Group not found in DB',
        });
        break;
      }

      const existingMounts =
        existingGroup.containerConfig?.additionalMounts || [];

      // Check if already mounted at this container path
      const resolvedCp = mountResult.resolvedContainerPath!;
      const alreadyMounted = existingMounts.some(
        (m) => (m.containerPath || path.basename(m.hostPath)) === resolvedCp,
      );
      if (alreadyMounted) {
        writeIpcResponse(sourceGroup, 'mount_responses', data.requestId, {
          success: false,
          error: `Already mounted at /workspace/extra/${resolvedCp}`,
        });
        break;
      }

      const updatedMounts = [...existingMounts, mountDef];
      setRegisteredGroup(mountTargetJid, {
        ...existingGroup,
        containerConfig: {
          ...existingGroup.containerConfig,
          additionalMounts: updatedMounts,
        },
      });

      // Stop the container so next query recreates it with new mounts
      if (deps.stopGroup) {
        deps.stopGroup(mountTargetJid);
      }

      writeIpcResponse(sourceGroup, 'mount_responses', data.requestId, {
        success: true,
        containerPath: `/workspace/extra/${resolvedCp}`,
        readonly: mountResult.effectiveReadonly,
      });

      logger.info(
        {
          sourceGroup,
          targetJid: mountTargetJid,
          projectPath: data.projectPath,
          containerPath: resolvedCp,
        },
        'Project mounted via IPC',
      );
      break;
    }

    case 'unmount_project': {
      if (!data.requestId || !data.containerPath) {
        logger.warn({ data }, 'Invalid unmount_project request');
        break;
      }

      const unmountTargetJid = data.groupJid || data.chatJid;
      if (!unmountTargetJid) {
        writeIpcResponse(sourceGroup, 'unmount_responses', data.requestId, {
          success: false,
          error: 'No target group JID specified',
        });
        break;
      }

      const unmountTargetGroup = registeredGroups[unmountTargetJid];
      if (!unmountTargetGroup) {
        writeIpcResponse(sourceGroup, 'unmount_responses', data.requestId, {
          success: false,
          error: 'Target group not registered',
        });
        break;
      }
      if (!isMain && unmountTargetGroup.folder !== sourceGroup) {
        writeIpcResponse(sourceGroup, 'unmount_responses', data.requestId, {
          success: false,
          error: 'Unauthorized: can only unmount from own group',
        });
        break;
      }

      const unmountExisting = getRegisteredGroup(unmountTargetJid);
      if (!unmountExisting) {
        writeIpcResponse(sourceGroup, 'unmount_responses', data.requestId, {
          success: false,
          error: 'Group not found in DB',
        });
        break;
      }

      const currentMounts =
        unmountExisting.containerConfig?.additionalMounts || [];
      const targetCp = data.containerPath;
      const filtered = currentMounts.filter(
        (m) => (m.containerPath || path.basename(m.hostPath)) !== targetCp,
      );

      if (filtered.length === currentMounts.length) {
        writeIpcResponse(sourceGroup, 'unmount_responses', data.requestId, {
          success: false,
          error: `No mount found with containerPath "${targetCp}"`,
        });
        break;
      }

      setRegisteredGroup(unmountTargetJid, {
        ...unmountExisting,
        containerConfig: {
          ...unmountExisting.containerConfig,
          additionalMounts: filtered,
        },
      });

      if (deps.stopGroup) {
        deps.stopGroup(unmountTargetJid);
      }

      writeIpcResponse(sourceGroup, 'unmount_responses', data.requestId, {
        success: true,
        removed: targetCp,
      });

      logger.info(
        { sourceGroup, targetJid: unmountTargetJid, containerPath: targetCp },
        'Project unmounted via IPC',
      );
      break;
    }

    case 'spawn_claude_session': {
      if (!data.requestId || !data.projectPath) {
        logger.warn({ data }, 'Invalid spawn_claude_session request');
        break;
      }

      // Validate the project path against allowlist
      const sessionMount: AdditionalMount = {
        hostPath: data.projectPath,
        readonly: true,
      };
      const sessionCheck = validateMount(sessionMount, isMain);
      if (!sessionCheck.allowed) {
        writeIpcResponse(sourceGroup, 'session_responses', data.requestId, {
          success: false,
          error: `Path not allowed: ${sessionCheck.reason}`,
        });
        break;
      }

      // Expand ~ for the actual spawn
      const sessionProjectPath = data.projectPath.startsWith('~/')
        ? path.join(process.env.HOME || os.homedir(), data.projectPath.slice(2))
        : data.projectPath;

      try {
        const { spawn: spawnProcess } = await import('child_process');
        const sessionName =
          data.name ||
          `nanoclaw-${path.basename(sessionProjectPath)}-${Date.now()}`;

        const ccProcess = spawnProcess(
          'claude',
          ['--dangerously-skip-permissions'],
          {
            cwd: sessionProjectPath,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true,
            env: {
              ...process.env,
              CLAUDE_CODE_SESSION_NAME: sessionName,
            },
          },
        );

        // Detach so the process survives NanoClaw restarts
        ccProcess.unref();

        // Give it a moment to start, then capture the PID
        const pid = ccProcess.pid;

        writeIpcResponse(sourceGroup, 'session_responses', data.requestId, {
          success: true,
          pid,
          sessionName,
          projectPath: sessionProjectPath,
          message: `Claude Code session started (PID: ${pid}) in ${sessionProjectPath}`,
        });

        logger.info(
          {
            sourceGroup,
            pid,
            sessionName,
            projectPath: sessionProjectPath,
          },
          'Claude Code session spawned via IPC',
        );
      } catch (err) {
        writeIpcResponse(sourceGroup, 'session_responses', data.requestId, {
          success: false,
          error: `Failed to spawn session: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      break;
    }

    case 'list_projects': {
      if (!data.requestId) {
        logger.warn({ data }, 'Invalid list_projects request');
        break;
      }

      const rootPath = data.rootPath || '~/PROJECTS';
      const expandedRoot = rootPath.startsWith('~/')
        ? path.join(process.env.HOME || os.homedir(), rootPath.slice(2))
        : rootPath;

      // Validate root is in allowlist
      const testMount: AdditionalMount = {
        hostPath: expandedRoot,
        readonly: true,
      };
      const rootCheck = validateMount(testMount, isMain);
      if (!rootCheck.allowed) {
        writeIpcResponse(sourceGroup, 'project_responses', data.requestId, {
          success: false,
          error: `Root path not allowed: ${rootCheck.reason}`,
        });
        break;
      }

      const projects: Array<{
        name: string;
        path: string;
        hasGit: boolean;
        hasClaude: boolean;
        lastCommit?: string;
      }> = [];

      try {
        // Scan subdirectories recursively (2 levels: category/project)
        const categories = fs.readdirSync(expandedRoot).filter((f) => {
          try {
            return (
              !f.startsWith('.') &&
              fs.statSync(path.join(expandedRoot, f)).isDirectory()
            );
          } catch {
            return false;
          }
        });

        for (const category of categories) {
          const categoryPath = path.join(expandedRoot, category);
          let entries: string[];
          try {
            entries = fs.readdirSync(categoryPath);
          } catch {
            continue;
          }

          for (const entry of entries) {
            if (entry.startsWith('.')) continue;
            const entryPath = path.join(categoryPath, entry);
            try {
              if (!fs.statSync(entryPath).isDirectory()) continue;
            } catch {
              continue;
            }

            const hasGit = fs.existsSync(path.join(entryPath, '.git'));
            const hasClaude = fs.existsSync(path.join(entryPath, 'CLAUDE.md'));

            const project: (typeof projects)[number] = {
              name: `${category}/${entry}`,
              path: entryPath,
              hasGit,
              hasClaude,
            };

            // Get last commit date if git repo
            if (hasGit) {
              try {
                const { execSync } = await import('child_process');
                const lastCommit = execSync(
                  'git log -1 --format=%ci 2>/dev/null || echo ""',
                  { cwd: entryPath, timeout: 5000 },
                )
                  .toString()
                  .trim();
                if (lastCommit) project.lastCommit = lastCommit;
              } catch {
                // Ignore git errors
              }
            }

            projects.push(project);
          }
        }
      } catch (err) {
        writeIpcResponse(sourceGroup, 'project_responses', data.requestId, {
          success: false,
          error: `Failed to scan projects: ${err instanceof Error ? err.message : String(err)}`,
        });
        break;
      }

      writeIpcResponse(sourceGroup, 'project_responses', data.requestId, {
        success: true,
        root: expandedRoot,
        projects,
      });

      logger.info(
        {
          sourceGroup,
          rootPath: expandedRoot,
          projectCount: projects.length,
        },
        'Project list generated via IPC',
      );
      break;
    }

    case 'register_discord_project': {
      if (!isMain) {
        writeIpcResponse(
          sourceGroup,
          'project_responses',
          data.requestId || '',
          { success: false, error: 'Only main group can register projects' },
        );
        break;
      }
      if (!data.requestId || !data.projectPath) {
        logger.warn({ data }, 'Invalid register_discord_project request');
        break;
      }

      const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
      const botToken =
        process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
      if (!botToken) {
        writeIpcResponse(sourceGroup, 'project_responses', data.requestId, {
          success: false,
          error: 'DISCORD_BOT_TOKEN not configured',
        });
        break;
      }

      const envVarsGuild = readEnvFile(['DISCORD_GUILD_ID']);
      const regGuildId =
        data.guildId ||
        process.env.DISCORD_GUILD_ID ||
        envVarsGuild.DISCORD_GUILD_ID ||
        '';
      if (!regGuildId) {
        writeIpcResponse(sourceGroup, 'project_responses', data.requestId, {
          success: false,
          error:
            'guildId is required. Set DISCORD_GUILD_ID in .env or pass it explicitly.',
        });
        break;
      }

      // Validate the project path is in the allowlist
      const regMountDef: AdditionalMount = {
        hostPath: data.projectPath,
        readonly: false,
      };
      const regMountCheck = validateMount(regMountDef, true);
      if (!regMountCheck.allowed) {
        writeIpcResponse(sourceGroup, 'project_responses', data.requestId, {
          success: false,
          error: `Path not allowed: ${regMountCheck.reason}`,
        });
        break;
      }

      // Derive names from the project path
      const projectBasename = path.basename(data.projectPath);
      const discordChannelName =
        data.channelName ||
        projectBasename.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const groupFolder = `discord_${discordChannelName.replace(/-/g, '_')}`;

      // Check if folder already registered
      const existingFolders = new Set(
        Object.values(registeredGroups).map((g) => g.folder),
      );
      if (existingFolders.has(groupFolder)) {
        writeIpcResponse(sourceGroup, 'project_responses', data.requestId, {
          success: false,
          error: `Group folder '${groupFolder}' already exists`,
        });
        break;
      }

      try {
        // Create Discord channel via REST API
        const createRes = await fetch(
          `https://discord.com/api/v10/guilds/${regGuildId}/channels`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bot ${botToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: discordChannelName,
              type: 0, // GUILD_TEXT
              topic: `NanoClaw project: ${data.projectPath}`,
            }),
          },
        );

        if (!createRes.ok) {
          const errBody = await createRes.text();
          writeIpcResponse(sourceGroup, 'project_responses', data.requestId, {
            success: false,
            error: `Discord API error ${createRes.status}: ${errBody}`,
          });
          break;
        }

        const channelData = (await createRes.json()) as {
          id: string;
          name: string;
        };
        const newJid = `dc:${channelData.id}`;

        // Register the group in NanoClaw
        const newGroup: RegisteredGroup = {
          name: `Discord #${channelData.name}`,
          folder: groupFolder,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
          isMain: false,
          useHostRunner: true,
          containerConfig: {
            additionalMounts: [
              {
                hostPath: data.projectPath,
                containerPath: projectBasename,
                readonly: false,
              },
            ],
          },
        };
        deps.registerGroup(newJid, newGroup);

        // Create CLAUDE.md from template
        const groupDir = resolveGroupFolderPath(groupFolder);
        const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
        if (!fs.existsSync(claudeMdPath)) {
          const template = generateDiscordProjectClaudeMd(
            projectBasename,
            data.projectPath,
          );
          fs.writeFileSync(claudeMdPath, template, 'utf-8');
        }

        writeIpcResponse(sourceGroup, 'project_responses', data.requestId, {
          success: true,
          channelId: channelData.id,
          channelName: channelData.name,
          jid: newJid,
          folder: groupFolder,
          containerPath: `/workspace/extra/${projectBasename}`,
        });

        logger.info(
          {
            sourceGroup,
            projectPath: data.projectPath,
            discordChannel: channelData.name,
            jid: newJid,
            folder: groupFolder,
          },
          'Discord project registered via IPC',
        );
      } catch (err) {
        writeIpcResponse(sourceGroup, 'project_responses', data.requestId, {
          success: false,
          error: `Failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      break;
    }

    case 'unregister_discord_project': {
      if (!isMain) {
        writeIpcResponse(
          sourceGroup,
          'project_responses',
          data.requestId || '',
          { success: false, error: 'Only main group can unregister projects' },
        );
        break;
      }
      if (!data.requestId || !data.discordChannelId) {
        logger.warn({ data }, 'Invalid unregister_discord_project request');
        break;
      }

      const unregJid = `dc:${data.discordChannelId}`;
      const unregGroup = registeredGroups[unregJid];
      if (!unregGroup) {
        writeIpcResponse(sourceGroup, 'project_responses', data.requestId, {
          success: false,
          error: `No group registered for ${unregJid}`,
        });
        break;
      }

      // Stop any running container
      if (deps.stopGroup) {
        deps.stopGroup(unregJid);
      }

      // Remove from DB and in-memory state
      try {
        deleteRegisteredGroup(unregJid);
        delete registeredGroups[unregJid];
      } catch (err) {
        logger.error({ err, jid: unregJid }, 'Failed to delete group from DB');
      }

      writeIpcResponse(sourceGroup, 'project_responses', data.requestId, {
        success: true,
        jid: unregJid,
        folder: unregGroup.folder,
        note: 'Group unregistered. Discord channel NOT deleted — remove it manually if needed.',
      });

      logger.info(
        { jid: unregJid, folder: unregGroup.folder },
        'Discord project unregistered via IPC',
      );
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

function generateDiscordProjectClaudeMd(
  projectName: string,
  projectPath: string,
): string {
  return `# Discord Project Agent — ${projectName}

You are a development agent for the **${projectName}** project, accessed via Discord. Direct, precise, no bullshit.

Generic rules (communication, workspace, memory, formatting) are in \`/workspace/global/CLAUDE.md\`. This file only contains project-specific overrides.

## Project

The project is mounted at \`/workspace/extra/${projectName}\`. Always \`cd\` there before working.

## Personality

- Technical, concise, zero sarcasm. Output is code-focused.
- No emoji. No filler. Report what you did, what changed, what failed.
- When asked to do a task, do it. Don't ask for confirmation unless the plan explicitly requires it (e.g., before pushing).

## Message Formatting

Use standard Markdown (Discord renders it natively):
- **bold** for emphasis
- \\\`backticks\\\` for inline code
- \\\`\\\`\\\`triple backticks\\\`\\\`\\\` for code blocks (with language tag)
- Keep messages under 1900 chars when possible (Discord limit is 2000)

## Regole di sicurezza (NON NEGOZIABILI)

1. MAI committare o pushare su main/master. SEMPRE branch dedicato.
2. Nome branch: \`nanoclaw/{descrizione-breve}\`
3. SEMPRE crea una PR. Mai push diretto su branch protetti.
4. PRIMA di pushare, chiedi conferma in chat. Mostra:
   - Branch name
   - File modificati (lista)
   - Diff riassuntivo (max 20 righe)
   - Attendi "ok" o "push" esplicito dall'utente
5. Commit message: descrittivo, in inglese.

## Workflow codice

1. \`cd /workspace/extra/${projectName}\`
2. \`git fetch origin && git checkout -b nanoclaw/{task} origin/main\`
3. Fai le modifiche
4. \`git add\` (file specifici, mai \`-A\`) + \`git commit\`
5. Mostra diff e chiedi conferma
6. Solo dopo conferma: \`git push -u origin nanoclaw/{task}\` + \`gh pr create\`
7. Condividi link PR in chat
`;
}
