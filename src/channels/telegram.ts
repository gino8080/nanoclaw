import fs from 'fs';
import path from 'path';

import { Api, Bot, InputFile } from 'grammy';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  PUBLIC_BASE_URL,
  TRIGGER_PATTERN,
} from '../config.js';
import { markdownToTelegramHtml } from '../telegram-format.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcription.js';
import { registerChannel, ChannelOpts, AdminCommands } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  adminCommands?: AdminCommands;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Link to file browser
    this.bot.command('files', (ctx) => {
      ctx.reply(`📂 <a href="${PUBLIC_BASE_URL}/files/">File Browser</a>`, {
        parse_mode: 'HTML',
      });
    });

    // Help — list available commands
    this.bot.command('help', (ctx) => {
      const lines = [
        `<b>${ASSISTANT_NAME} — Comandi</b>`,
        '',
        '/ping — Controlla se il bot è online',
        '/files — Apri il file browser',
        '/chatid — Mostra il Chat ID',
        '/reset — Reset sessione (nuova conversazione)',
        '/status — Stato del sistema',
        '/restart — Riavvia NanoClaw',
        '/help — Mostra questo messaggio',
      ];
      ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    });

    // Admin commands (only work in registered groups)
    if (this.opts.adminCommands) {
      const admin = this.opts.adminCommands;

      this.bot.command('reset', (ctx) => {
        const chatJid = `tg:${ctx.chat.id}`;
        const groups = this.opts.registeredGroups();
        // In private chats, fall back to main group
        const group =
          groups[chatJid] ||
          (ctx.chat.type === 'private'
            ? Object.values(groups).find((g) => g.isMain)
            : undefined);
        if (!group) {
          ctx.reply('⚠️ This chat is not a registered group.');
          return;
        }
        const result = admin.resetSession(group.folder);
        ctx.reply(result, { parse_mode: 'Markdown' });
      });

      this.bot.command('status', (ctx) => {
        ctx.reply(admin.getStatus(), { parse_mode: 'Markdown' });
      });

      this.bot.command('restart', (ctx) => {
        ctx.reply('♻️ Restarting NanoClaw...');
        setTimeout(() => admin.restart(), 500);
      });
    }

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption || '';

      // Download the highest-resolution photo
      try {
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1];
        const file = await ctx.api.getFile(largest.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const res = await fetch(fileUrl);
        const buffer = Buffer.from(await res.arrayBuffer());

        // Save to group's IPC media directory (container sees /workspace/ipc/media/)
        const mediaDir = path.join(DATA_DIR, 'ipc', group.folder, 'media');
        fs.mkdirSync(mediaDir, { recursive: true });
        const ext = file.file_path?.split('.').pop() || 'jpg';
        const filename = `photo-${Date.now()}.${ext}`;
        const filePath = path.join(mediaDir, filename);
        fs.writeFileSync(filePath, buffer);

        const containerPath = `/workspace/ipc/media/${filename}`;

        const isGroupChat =
          ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'telegram',
          isGroupChat,
        );

        // Include trigger prefix if bot is @mentioned in caption
        let content = caption;
        const botUsername = ctx.me?.username?.toLowerCase();
        if (botUsername) {
          const entities = ctx.message.caption_entities || [];
          const isBotMentioned = entities.some((entity) => {
            if (entity.type === 'mention') {
              const mentionText = (caption || '')
                .substring(entity.offset, entity.offset + entity.length)
                .toLowerCase();
              return mentionText === `@${botUsername}`;
            }
            return false;
          });
          if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }

        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content: `[Photo: ${containerPath}]${content ? ` ${content}` : ''}`,
          timestamp,
          is_from_me: false,
        });

        logger.info(
          { chatJid, filename, size: buffer.length },
          'Telegram photo downloaded and saved',
        );
      } catch (err) {
        logger.error({ chatJid, err }, 'Failed to download Telegram photo');
        storeNonText(ctx, '[Photo - download failed]');
      }
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';

      try {
        const voice = ctx.message.voice;
        const file = await ctx.api.getFile(voice.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const res = await fetch(fileUrl);
        const buffer = Buffer.from(await res.arrayBuffer());

        const transcript = await transcribeAudio(buffer);
        const content = transcript
          ? `[Voice: ${transcript}]`
          : '[Voice message - transcription unavailable]';

        const isGroupChat =
          ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'telegram',
          isGroupChat,
        );

        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });

        logger.info(
          { chatJid, size: buffer.length, transcribed: !!transcript },
          'Telegram voice message processed',
        );
      } catch (err) {
        logger.error({ chatJid, err }, 'Failed to download Telegram voice');
        storeNonText(ctx, '[Voice message - download failed]');
      }
    });
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Register bot commands menu
    const commands = [
      { command: 'help', description: 'Mostra i comandi disponibili' },
      { command: 'ping', description: 'Controlla se il bot è online' },
      { command: 'files', description: 'Apri il file browser' },
      { command: 'chatid', description: 'Mostra il Chat ID di questa chat' },
    ];
    if (this.opts.adminCommands) {
      commands.push(
        { command: 'reset', description: 'Reset sessione (nuova conversazione)' },
        { command: 'status', description: 'Stato del sistema' },
        { command: 'restart', description: 'Riavvia NanoClaw' },
      );
    }
    this.bot.api.setMyCommands(commands).catch((err) => {
      logger.warn({ err }, 'Failed to set bot commands menu');
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const html = markdownToTelegramHtml(text);
      const MAX_LENGTH = 4096;
      if (html.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, html, {
          parse_mode: 'HTML',
        });
      } else {
        for (let i = 0; i < html.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(
            numericId,
            html.slice(i, i + MAX_LENGTH),
            { parse_mode: 'HTML' },
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async sendPhoto(
    jid: string,
    photoBuffer: Buffer,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendPhoto(
        numericId,
        new InputFile(photoBuffer, 'image.png'),
        caption ? { caption } : undefined,
      );
      logger.info({ jid }, 'Telegram photo sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram photo');
    }
  }

  async sendDocument(
    jid: string,
    fileBuffer: Buffer,
    filename: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendDocument(
        numericId,
        new InputFile(fileBuffer, filename),
        caption ? { caption } : undefined,
      );
      logger.info({ jid, filename }, 'Telegram document sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram document');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) return;

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const html = markdownToTelegramHtml(text);
    const MAX_LENGTH = 4096;
    if (html.length <= MAX_LENGTH) {
      await api.sendMessage(numericId, html, { parse_mode: 'HTML' });
    } else {
      for (let i = 0; i < html.length; i += MAX_LENGTH) {
        await api.sendMessage(numericId, html.slice(i, i + MAX_LENGTH), {
          parse_mode: 'HTML',
        });
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

/**
 * Send a photo via a pool bot assigned to the given sender name.
 */
export async function sendPoolPhoto(
  chatId: string,
  photoBuffer: Buffer,
  sender: string,
  groupFolder: string,
  caption?: string,
): Promise<void> {
  if (poolApis.length === 0) return;

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
    } catch {
      // ignore rename failure
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    await api.sendPhoto(
      numericId,
      new InputFile(photoBuffer, 'image.png'),
      caption ? { caption } : undefined,
    );
    logger.info({ chatId, sender, poolIndex: idx }, 'Pool photo sent');
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool photo');
  }
}

/**
 * Send a document via a pool bot assigned to the given sender name.
 */
export async function sendPoolDocument(
  chatId: string,
  fileBuffer: Buffer,
  filename: string,
  sender: string,
  groupFolder: string,
  caption?: string,
): Promise<void> {
  if (poolApis.length === 0) return;

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
    } catch {
      // ignore rename failure
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    await api.sendDocument(
      numericId,
      new InputFile(fileBuffer, filename),
      caption ? { caption } : undefined,
    );
    logger.info(
      { chatId, sender, poolIndex: idx, filename },
      'Pool document sent',
    );
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool document');
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
