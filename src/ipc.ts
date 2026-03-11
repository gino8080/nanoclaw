import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  sendPoolDocument,
  sendPoolMessage,
  sendPoolPhoto,
} from './channels/telegram.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteTask,
  deleteKnowledge,
  getTaskById,
  listKnowledge,
  searchKnowledge,
  searchMessages,
  searchMessagesFts,
  updateTask,
  upsertKnowledge,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { processListOperation } from './lists.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

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
        JSON.stringify({ success: true, results: searchResults }),
      );
      fs.renameSync(searchTmpPath, searchResponsePath);

      logger.info(
        {
          requestId: data.requestId,
          query: data.query,
          resultCount: searchResults.length,
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

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
