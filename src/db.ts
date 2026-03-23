import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // --- FTS5 on messages ---
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content, sender_name,
      content='messages', content_rowid='rowid'
    );
  `);
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content, sender_name)
      VALUES (new.rowid, new.content, new.sender_name);
    END;
  `);
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, sender_name)
      VALUES ('delete', old.rowid, old.content, old.sender_name);
    END;
  `);
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, sender_name)
      VALUES ('delete', old.rowid, old.content, old.sender_name);
      INSERT INTO messages_fts(rowid, content, sender_name)
      VALUES (new.rowid, new.content, new.sender_name);
    END;
  `);

  // --- Knowledge store ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      source TEXT,
      confidence REAL DEFAULT 1.0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_accessed_at TEXT,
      expires_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_key
      ON knowledge(key);
    CREATE INDEX IF NOT EXISTS idx_knowledge_category
      ON knowledge(category);
  `);
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      key, value, category,
      content='knowledge', content_rowid='id'
    );
  `);
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS knowledge_fts_ai AFTER INSERT ON knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, key, value, category)
      VALUES (new.id, new.key, new.value, new.category);
    END;
  `);
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS knowledge_fts_ad AFTER DELETE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, key, value, category)
      VALUES ('delete', old.id, old.key, old.value, old.category);
    END;
  `);
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS knowledge_fts_au AFTER UPDATE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, key, value, category)
      VALUES ('delete', old.id, old.key, old.value, old.category);
      INSERT INTO knowledge_fts(rowid, key, value, category)
      VALUES (new.id, new.key, new.value, new.category);
    END;
  `);

  // Backfill FTS index from existing messages (one-time migration)
  migrateFts(database);
}

function migrateFts(database: Database.Database): void {
  // Content-sync FTS5 tables must use 'rebuild' command to populate the index.
  // Direct INSERT into content-sync tables creates rows but doesn't build the
  // inverted index, making MATCH queries fail on backfilled data.
  // We track rebuild state via a simple metadata table to avoid re-running on every startup.

  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      key TEXT PRIMARY KEY,
      done_at TEXT NOT NULL
    )
  `);

  const ftsRebuilt = database
    .prepare("SELECT 1 FROM _migrations WHERE key = 'fts_rebuild_v1'")
    .get();
  if (ftsRebuilt) return;

  const msgCount = database
    .prepare('SELECT COUNT(*) as c FROM messages WHERE content IS NOT NULL')
    .get() as { c: number };
  if (msgCount.c > 0) {
    logger.info({ messages: msgCount.c }, 'Rebuilding messages FTS index');
    database.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  }

  const kCount = database
    .prepare('SELECT COUNT(*) as c FROM knowledge')
    .get() as { c: number };
  if (kCount.c > 0) {
    logger.info({ entries: kCount.c }, 'Rebuilding knowledge FTS index');
    database.exec("INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')");
  }

  database
    .prepare(
      "INSERT INTO _migrations (key, done_at) VALUES ('fts_rebuild_v1', ?)",
    )
    .run(new Date().toISOString());
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

export function searchMessages(
  query: string,
  chatJid?: string,
  channel?: string,
  limit = 20,
  senderName?: string,
): NewMessage[] {
  const conditions = [`content LIKE ?`];
  const params: unknown[] = [`%${query}%`];

  if (chatJid) {
    conditions.push(`chat_jid = ?`);
    params.push(chatJid);
  }

  if (channel) {
    conditions.push(`chat_jid IN (SELECT jid FROM chats WHERE channel = ?)`);
    params.push(channel);
  }

  if (senderName) {
    conditions.push(`sender_name LIKE ?`);
    params.push(`%${senderName}%`);
  }

  params.push(limit);

  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
    FROM messages
    WHERE ${conditions.join(' AND ')}
    ORDER BY timestamp DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(...params) as NewMessage[];
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
    useHostRunner: row.container_config
      ? JSON.parse(row.container_config).useHostRunner === true
      : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig || group.useHostRunner
      ? JSON.stringify({
          ...group.containerConfig,
          ...(group.useHostRunner ? { useHostRunner: true } : {}),
        })
      : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function deleteRegisteredGroup(jid: string): boolean {
  const result = db
    .prepare('DELETE FROM registered_groups WHERE jid = ?')
    .run(jid);
  return result.changes > 0;
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    const parsedConfig = row.container_config
      ? JSON.parse(row.container_config)
      : undefined;
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: parsedConfig,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
      useHostRunner: parsedConfig?.useHostRunner === true ? true : undefined,
    };
  }
  return result;
}

// --- FTS5 search ---

export function searchMessagesFts(
  query: string,
  chatJid?: string,
  channel?: string,
  limit = 20,
  senderName?: string,
): NewMessage[] {
  // Escape FTS5 special characters for safe querying
  const safeQuery = query.replace(/['"*()]/g, ' ').trim();
  if (!safeQuery) return [];

  const conditions = ['messages_fts MATCH ?'];
  const params: unknown[] = [`"${safeQuery}"`];

  if (chatJid) {
    conditions.push('m.chat_jid = ?');
    params.push(chatJid);
  }
  if (channel) {
    conditions.push('m.chat_jid IN (SELECT jid FROM chats WHERE channel = ?)');
    params.push(channel);
  }
  if (senderName) {
    conditions.push('m.sender_name LIKE ?');
    params.push(`%${senderName}%`);
  }

  params.push(limit);

  const sql = `
    SELECT m.id, m.chat_jid, m.sender, m.sender_name, m.content,
           m.timestamp, m.is_from_me
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    WHERE ${conditions.join(' AND ')}
    ORDER BY bm25(messages_fts, 10.0, 1.0)
    LIMIT ?
  `;

  try {
    return db.prepare(sql).all(...params) as NewMessage[];
  } catch (err) {
    // Fallback to LIKE search if FTS query syntax is invalid
    logger.warn({ query, err }, 'FTS5 query failed, falling back to LIKE');
    return searchMessages(query, chatJid, channel, limit, senderName);
  }
}

// --- Knowledge store ---

export interface KnowledgeEntry {
  id: number;
  group_folder: string;
  category: string;
  key: string;
  value: string;
  source: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  expires_at: string | null;
}

export function upsertKnowledge(
  groupFolder: string,
  key: string,
  value: string,
  category: string,
  source?: string,
  confidence?: number,
  expiresAt?: string,
): { action: 'inserted' | 'updated'; previous_value?: string } {
  const now = new Date().toISOString();

  // Knowledge is not partitioned — UPSERT by key only
  const existing = db
    .prepare('SELECT value FROM knowledge WHERE key = ?')
    .get(key) as { value: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE knowledge
       SET value = ?, category = ?, source = ?, confidence = ?,
           updated_at = ?, expires_at = ?, group_folder = ?
       WHERE key = ?`,
    ).run(
      value,
      category,
      source ?? null,
      confidence ?? 1.0,
      now,
      expiresAt ?? null,
      groupFolder,
      key,
    );
    return { action: 'updated', previous_value: existing.value };
  }

  db.prepare(
    `INSERT INTO knowledge
     (group_folder, category, key, value, source, confidence, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    groupFolder,
    category,
    key,
    value,
    source ?? null,
    confidence ?? 1.0,
    now,
    now,
    expiresAt ?? null,
  );
  return { action: 'inserted' };
}

export function searchKnowledge(
  _groupFolder: string,
  query: string,
  category?: string,
  limit = 20,
): KnowledgeEntry[] {
  const safeQuery = query.replace(/['"*()]/g, ' ').trim();
  if (!safeQuery) return [];

  // Knowledge is not partitioned — one user, one memory across all groups
  const conditions = ['knowledge_fts MATCH ?'];
  const params: unknown[] = [`"${safeQuery}"`];

  if (category) {
    conditions.push('k.category = ?');
    params.push(category);
  }

  params.push(limit);

  const sql = `
    SELECT k.*
    FROM knowledge_fts
    JOIN knowledge k ON k.id = knowledge_fts.rowid
    WHERE ${conditions.join(' AND ')}
    ORDER BY bm25(knowledge_fts, 5.0, 10.0, 1.0)
    LIMIT ?
  `;

  try {
    let results = db.prepare(sql).all(...params) as KnowledgeEntry[];

    // If FTS found nothing, return all knowledge entries as fallback.
    // The store is small (<100 entries) so the token cost is negligible,
    // and this lets the agent reason about what it knows even when the
    // query terms don't match (e.g. "quanti anni ho" vs key "user_birthdate").
    if (results.length === 0) {
      const fallbackConditions: string[] = [];
      const fallbackParams: unknown[] = [];
      if (category) {
        fallbackConditions.push('category = ?');
        fallbackParams.push(category);
      }
      fallbackParams.push(limit);
      const whereClause =
        fallbackConditions.length > 0
          ? `WHERE ${fallbackConditions.join(' AND ')}`
          : '';
      results = db
        .prepare(
          `SELECT * FROM knowledge ${whereClause} ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(...fallbackParams) as KnowledgeEntry[];
    }

    // Update last_accessed_at for returned entries
    if (results.length > 0) {
      const now = new Date().toISOString();
      const ids = results.map((r) => r.id);
      db.prepare(
        `UPDATE knowledge SET last_accessed_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
      ).run(now, ...ids);
    }
    return results;
  } catch (err) {
    logger.warn({ query, err }, 'Knowledge FTS query failed');
    return [];
  }
}

export function listKnowledge(
  _groupFolder: string,
  category?: string,
  prefix?: string,
  onlyExpired?: boolean,
  limit = 50,
): KnowledgeEntry[] {
  // Knowledge is not partitioned — one user, one memory across all groups
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }
  if (prefix) {
    conditions.push('key LIKE ?');
    params.push(`${prefix}%`);
  }
  if (onlyExpired) {
    conditions.push('expires_at IS NOT NULL AND expires_at <= ?');
    params.push(new Date().toISOString());
  }

  params.push(limit);

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT * FROM knowledge ${whereClause}
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...params) as KnowledgeEntry[];
}

export function deleteKnowledge(_groupFolder: string, key: string): boolean {
  // Knowledge is not partitioned — delete by key only
  const result = db.prepare('DELETE FROM knowledge WHERE key = ?').run(key);
  return result.changes > 0;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
