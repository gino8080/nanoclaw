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

// Tool argument types
interface SendMessageArgs {
  text: string;
  sender?: string;
}

interface FilePathArgs {
  file_path: string;
  caption?: string;
  sender?: string;
}

type AspectRatio =
  | '1:1'
  | '2:3'
  | '3:2'
  | '3:4'
  | '4:3'
  | '4:5'
  | '5:4'
  | '9:16'
  | '16:9'
  | '21:9'
  | '1:4'
  | '4:1'
  | '1:8'
  | '8:1';

interface GenerateImageArgs {
  prompt: string;
  image_base64?: string;
  aspect_ratio?: AspectRatio;
  image_size?: '0.5K' | '1K' | '2K' | '4K';
  filename?: string;
}

interface ScheduleTaskArgs {
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  target_group_jid?: string;
}

interface TaskIdArgs {
  task_id: string;
}

interface RegisterGroupArgs {
  jid: string;
  name: string;
  folder: string;
  trigger: string;
}

interface ManageListArgs {
  action:
    | 'add'
    | 'update'
    | 'remove'
    | 'mark_bought'
    | 'unmark_bought'
    | 'add_note';
  list_type: 'todo' | 'shopping' | 'purchases' | 'ideas';
  item_data?: string;
  item_id?: string;
  note_text?: string;
}

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
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
  },
  async (args: SendMessageArgs) => {
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
  async (args: FilePathArgs) => {
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
        content: [{ type: 'text' as const, text: 'Image sent to chat.' }],
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
  async (args: FilePathArgs) => {
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
      .describe(
        'Text prompt describing the image to generate or how to modify it',
      ),
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
      .describe(
        'Output resolution (default: 1K). 0.5K=low-res/fast, 4K=high-res.',
      ),
    filename: z
      .string()
      .optional()
      .describe(
        'Output filename (default: generated-{timestamp}.png). Saved in the mounted data directory.',
      ),
  },
  async (args: GenerateImageArgs) => {
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
      const outName = args.filename || `generated-${Date.now()}.png`;
      const extraBase = '/workspace/extra';
      let outDir = '/workspace/group';
      if (fs.existsSync(extraBase)) {
        const dirs = fs
          .readdirSync(extraBase)
          .filter((d) => fs.statSync(path.join(extraBase, d)).isDirectory());
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
            text: `Image generated and sent to chat. Also saved to ${outPath} (${Math.round((result.image_base64.length * 0.75) / 1024)}KB).`,
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
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
  },
  async (args: ScheduleTaskArgs) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

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
      content: [
        {
          type: 'text' as const,
          text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
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
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args: TaskIdArgs) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args: TaskIdArgs) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args: TaskIdArgs) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args: RegisterGroupArgs) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
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
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

server.tool(
  'manage_list',
  `Manage shared lists (todo, shopping, ideas). Lists are shared across all groups.

Read current state from /workspace/ipc/current_lists.json before operating.

Actions: add, update, remove, mark_bought (shopping), unmark_bought (shopping), add_note (ideas).
See the lists skill documentation for item_data JSON formats and shopping categories.`,
  {
    action: z
      .enum([
        'add',
        'update',
        'remove',
        'mark_bought',
        'unmark_bought',
        'add_note',
      ])
      .describe('The operation to perform'),
    list_type: z
      .enum(['todo', 'shopping', 'purchases', 'ideas'])
      .describe(
        'Which list to operate on. shopping=groceries/food only, purchases=generic non-food items',
      ),
    item_data: z
      .string()
      .optional()
      .describe('JSON string with item fields (for add/update)'),
    item_id: z.string().optional().describe('ID of the item to update/remove'),
    note_text: z
      .string()
      .optional()
      .describe('Text of the note (for add_note on ideas)'),
  },
  async (args: ManageListArgs) => {
    // Validate required params per action
    if (args.action === 'add' && !args.item_data) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'item_data is required for add action.',
          },
        ],
        isError: true,
      };
    }
    if (
      ['update', 'remove', 'mark_bought', 'unmark_bought', 'add_note'].includes(
        args.action,
      ) &&
      !args.item_id
    ) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'item_id is required for this action.',
          },
        ],
        isError: true,
      };
    }
    if (args.action === 'add_note' && !args.note_text) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'note_text is required for add_note action.',
          },
        ],
        isError: true,
      };
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'manage_list',
      requestId,
      action: args.action,
      list_type: args.list_type,
      item_data: args.item_data,
      item_id: args.item_id,
      note_text: args.note_text,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    // Poll for response
    const responsePath = path.join(
      IPC_DIR,
      'list_responses',
      `${requestId}.json`,
    );
    const pollInterval = 200;
    const timeout = 5000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (fs.existsSync(responsePath)) {
        try {
          const result = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
          fs.unlinkSync(responsePath);
          return {
            content: [
              {
                type: 'text' as const,
                text: result.success
                  ? `${result.message}${result.item_id ? ` (ID: ${result.item_id})` : ''}`
                  : `Error: ${result.message}`,
              },
            ],
            isError: !result.success,
          };
        } catch {
          // File might be partially written, retry
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: 'List operation timed out waiting for host response.',
        },
      ],
      isError: true,
    };
  },
);

interface SearchMessagesArgs {
  query: string;
  chat_jid?: string;
  channel?: string;
  sender_name?: string;
  limit?: number;
}

server.tool(
  'search_messages',
  `Search through stored messages across all channels. Main group only.
Use this to find past messages by keyword, optionally filtering by chat or channel.
Results are ordered by most recent first.`,
  {
    query: z.string().describe('Text to search for in message content'),
    chat_jid: z.string().optional().describe('Filter by specific chat JID'),
    channel: z
      .string()
      .optional()
      .describe('Filter by channel name (e.g., "whatsapp", "telegram")'),
    limit: z
      .number()
      .optional()
      .describe('Max results to return (default: 20)'),
    sender_name: z
      .string()
      .optional()
      .describe('Filter by sender name (partial match)'),
  },
  async (args: SearchMessagesArgs) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can search messages.',
          },
        ],
        isError: true,
      };
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(TASKS_DIR, {
      type: 'search_messages',
      requestId,
      query: args.query,
      chatJid: args.chat_jid,
      channel: args.channel,
      limit: args.limit,
      senderName: args.sender_name,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    // Poll for response
    const responsePath = path.join(
      IPC_DIR,
      'search_responses',
      `${requestId}.json`,
    );
    const pollInterval = 200;
    const timeout = 10000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (fs.existsSync(responsePath)) {
        try {
          const result = JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as {
            success: boolean;
            results: Array<{
              chat_jid: string;
              sender_name: string;
              content: string;
              timestamp: string;
            }>;
          };
          fs.unlinkSync(responsePath);

          if (!result.success || result.results.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'No messages found matching your query.',
                },
              ],
            };
          }

          const formatted = result.results
            .map(
              (m) =>
                `[${m.timestamp}] ${m.chat_jid} | ${m.sender_name}: ${m.content}`,
            )
            .join('\n\n');

          return {
            content: [
              {
                type: 'text' as const,
                text: `Found ${result.results.length} messages:\n\n${formatted}`,
              },
            ],
          };
        } catch {
          // File might be partially written, retry
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: 'Search timed out waiting for host response.',
        },
      ],
      isError: true,
    };
  },
);

// --- Memory tools ---

async function pollMemoryResponse(
  requestId: string,
  timeoutMs = 10000,
): Promise<unknown> {
  const responsePath = path.join(
    IPC_DIR,
    'memory_responses',
    `${requestId}.json`,
  );
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(responsePath)) {
      try {
        const result = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        fs.unlinkSync(responsePath);
        return result;
      } catch {
        // File might be partially written, retry
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

server.tool(
  'memory_search',
  `Search long-term memory. Searches both stored knowledge (facts, preferences) and message history using full-text search with ranking.
Knowledge results (distilled facts) are returned first, followed by raw message matches.
Use this when you need to recall past conversations, user preferences, or stored facts.
Tip: use word stems for better Italian recall (e.g. "compra" instead of "comprato").`,
  {
    query: z
      .string()
      .describe('Search query (supports FTS5: "exact phrase", word1 word2)'),
    scope: z
      .enum(['all', 'messages', 'knowledge'])
      .optional()
      .default('all')
      .describe(
        'Search scope: all (default), messages only, or knowledge only',
      ),
    category: z
      .string()
      .optional()
      .describe(
        'Filter knowledge by category: fact, preference, person, event',
      ),
    limit: z.number().optional().default(20).describe('Max results per scope'),
  },
  async (args: {
    query: string;
    scope?: 'all' | 'messages' | 'knowledge';
    category?: string;
    limit?: number;
  }) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(TASKS_DIR, {
      type: 'memory_search',
      requestId,
      query: args.query,
      scope: args.scope || 'all',
      category: args.category,
      limit: args.limit,
      // No chatJid — memory search should be cross-chat
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const result = (await pollMemoryResponse(requestId)) as {
      success: boolean;
      knowledge: Array<{
        key: string;
        value: string;
        category: string;
        confidence: number;
        updated_at: string;
      }>;
      messages: Array<{
        sender_name: string;
        content: string;
        timestamp: string;
        chat_jid: string;
      }>;
    } | null;

    if (!result) {
      return {
        content: [{ type: 'text' as const, text: 'Memory search timed out.' }],
        isError: true,
      };
    }

    const parts: string[] = [];

    if (result.knowledge?.length > 0) {
      parts.push('## Knowledge Store');
      for (const k of result.knowledge) {
        parts.push(
          `- **${k.key}** [${k.category}] (confidence: ${k.confidence}): ${k.value} _(${k.updated_at})_`,
        );
      }
    }

    if (result.messages?.length > 0) {
      parts.push('## Message History');
      for (const m of result.messages) {
        parts.push(`- [${m.timestamp}] ${m.sender_name}: ${m.content}`);
      }
    }

    if (parts.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'No results found.' }],
      };
    }

    return {
      content: [{ type: 'text' as const, text: parts.join('\n') }],
    };
  },
);

server.tool(
  'memory_store',
  `Store a fact, preference, or piece of knowledge for long-term recall across sessions.
Returns whether it inserted a new entry or updated an existing one (with the previous value).
If a key already exists for this group, it will be updated (UPSERT).

Key conventions (MUST follow):
- snake_case, English
- Prefixes: user_, trip_, project_, person_, place_
- Examples: user_milk_preference, trip_valencia_2026, person_mario_rossi
- BEFORE creating a new key, use memory_list to check if one already exists for the same concept
- Keep value brief and atomic for simple preferences. Use full sentences only for complex facts.`,
  {
    key: z
      .string()
      .describe(
        'Stable identifier in snake_case (e.g. user_milk_preference, trip_valencia_2026)',
      ),
    value: z
      .string()
      .describe(
        'The information to remember. Brief and atomic for preferences, descriptive for complex facts.',
      ),
    category: z
      .enum(['fact', 'preference', 'person', 'event'])
      .describe('Type of knowledge'),
    source: z
      .string()
      .optional()
      .describe(
        'Where you learned this (e.g. "user stated", "conversation:2026-03-10")',
      ),
    confidence: z
      .number()
      .optional()
      .default(1.0)
      .describe(
        '1.0=explicitly stated by user, 0.6=inferred, 0.3=hypothesis. Use 1.0 ONLY for facts the user explicitly said.',
      ),
    expires_at: z
      .string()
      .optional()
      .describe('ISO timestamp when this becomes stale (optional)'),
  },
  async (args: {
    key: string;
    value: string;
    category: string;
    source?: string;
    confidence?: number;
    expires_at?: string;
  }) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(TASKS_DIR, {
      type: 'memory_store',
      requestId,
      key: args.key,
      value: args.value,
      category: args.category,
      source: args.source,
      confidence: args.confidence,
      expiresAt: args.expires_at,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const result = (await pollMemoryResponse(requestId)) as {
      success: boolean;
      action: 'inserted' | 'updated';
      previous_value?: string;
    } | null;

    if (!result) {
      return {
        content: [{ type: 'text' as const, text: 'Memory store timed out.' }],
        isError: true,
      };
    }

    const msg =
      result.action === 'updated'
        ? `Key "${args.key}" updated (was: "${result.previous_value}")`
        : `Key "${args.key}" stored`;

    return {
      content: [{ type: 'text' as const, text: msg }],
    };
  },
);

server.tool(
  'memory_list',
  `List stored knowledge entries. Use to see what you remember about a topic or category.
Use this BEFORE memory_store to check if a key already exists.`,
  {
    category: z
      .string()
      .optional()
      .describe('Filter by category: fact, preference, person, event'),
    prefix: z
      .string()
      .optional()
      .describe(
        'Filter keys starting with this prefix (e.g. "user_", "trip_")',
      ),
    only_expired: z
      .boolean()
      .optional()
      .default(false)
      .describe('Only show entries past their expires_at date (for cleanup)'),
    limit: z.number().optional().default(50).describe('Max entries to return'),
  },
  async (args: {
    category?: string;
    prefix?: string;
    only_expired?: boolean;
    limit?: number;
  }) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(TASKS_DIR, {
      type: 'memory_list',
      requestId,
      category: args.category,
      prefix: args.prefix,
      onlyExpired: args.only_expired,
      limit: args.limit,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const result = (await pollMemoryResponse(requestId)) as {
      success: boolean;
      entries: Array<{
        key: string;
        value: string;
        category: string;
        confidence: number;
        updated_at: string;
        expires_at: string | null;
      }>;
    } | null;

    if (!result) {
      return {
        content: [{ type: 'text' as const, text: 'Memory list timed out.' }],
        isError: true,
      };
    }

    if (!result.entries || result.entries.length === 0) {
      return {
        content: [
          { type: 'text' as const, text: 'No knowledge entries found.' },
        ],
      };
    }

    const formatted = result.entries
      .map(
        (e) =>
          `- **${e.key}** [${e.category}] (confidence: ${e.confidence}): ${e.value}${e.expires_at ? ` (expires: ${e.expires_at})` : ''}`,
      )
      .join('\n');

    return {
      content: [
        {
          type: 'text' as const,
          text: `${result.entries.length} entries:\n${formatted}`,
        },
      ],
    };
  },
);

server.tool(
  'memory_delete',
  'Delete a knowledge entry by key. Use for cleanup of obsolete or incorrect facts.',
  {
    key: z.string().describe('The key to delete'),
  },
  async (args: { key: string }) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(TASKS_DIR, {
      type: 'memory_delete',
      requestId,
      key: args.key,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const result = (await pollMemoryResponse(requestId)) as {
      success: boolean;
      deleted: boolean;
    } | null;

    if (!result) {
      return {
        content: [{ type: 'text' as const, text: 'Memory delete timed out.' }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: result.deleted
            ? `Key "${args.key}" deleted.`
            : `Key "${args.key}" not found.`,
        },
      ],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
