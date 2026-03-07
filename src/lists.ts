import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';

const LISTS_FILE = path.join(DATA_DIR, 'lists.json');

// Also write to the public static files directory for web access
const PUBLIC_LISTS_DIR =
  process.env.STATIC_FILES_DIR ??
  '/Users/magico/PROJECTS/PERSONAL/NANO_CLAW_DATA/lists';
const PUBLIC_LISTS_FILE = path.join(PUBLIC_LISTS_DIR, 'lists.json');

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  priority?: 'low' | 'medium' | 'high';
  due_date?: string;
  reminder_task_id?: string;
  created_at: string;
  completed_at?: string;
  created_by: string;
}

export interface ShoppingItem {
  id: string;
  name: string;
  quantity?: string;
  category: string;
  status: 'to_buy' | 'bought';
  last_bought_at?: string;
  created_at: string;
  created_by: string;
}

export interface IdeaItem {
  id: string;
  title: string;
  description: string;
  status: 'draft' | 'active' | 'parked' | 'done';
  tags: string[];
  notes: { text: string; added_at: string; added_by: string }[];
  created_at: string;
  updated_at: string;
  created_by: string;
}

export interface PurchaseItem {
  id: string;
  name: string;
  quantity?: string;
  status: 'to_buy' | 'bought';
  last_bought_at?: string;
  created_at: string;
  created_by: string;
}

export interface ListsStore {
  version: 1;
  todo: TodoItem[];
  shopping: ShoppingItem[];
  purchases: PurchaseItem[];
  ideas: IdeaItem[];
}

export function readLists(): ListsStore {
  const empty: ListsStore = {
    version: 1,
    todo: [],
    shopping: [],
    purchases: [],
    ideas: [],
  };
  try {
    if (fs.existsSync(LISTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(LISTS_FILE, 'utf-8'));
      // Backfill missing fields from older versions
      return { ...empty, ...data };
    }
  } catch (err) {
    logger.error({ err }, 'Error reading lists.json, starting fresh');
  }
  return empty;
}

export function writeLists(store: ListsStore): void {
  fs.mkdirSync(path.dirname(LISTS_FILE), { recursive: true });
  const content = JSON.stringify(store, null, 2);
  const tmpPath = `${LISTS_FILE}.tmp`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, LISTS_FILE);

  // Mirror to public directory
  try {
    fs.mkdirSync(PUBLIC_LISTS_DIR, { recursive: true });
    const pubTmp = `${PUBLIC_LISTS_FILE}.tmp`;
    fs.writeFileSync(pubTmp, content);
    fs.renameSync(pubTmp, PUBLIC_LISTS_FILE);
  } catch (err) {
    logger.warn({ err }, 'Failed to write public lists copy');
  }
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface ListOperation {
  action: string;
  list_type: string;
  item_data?: string;
  item_id?: string;
  note_text?: string;
  source_group: string;
}

export interface ListOperationResult {
  success: boolean;
  message: string;
  item_id?: string;
}

export function processListOperation(op: ListOperation): ListOperationResult {
  const store = readLists();
  const now = new Date().toISOString();

  switch (op.list_type) {
    case 'todo':
      return processTodoOp(store, op, now);
    case 'shopping':
      return processShoppingOp(store, op, now);
    case 'purchases':
      return processPurchasesOp(store, op, now);
    case 'ideas':
      return processIdeasOp(store, op, now);
    default:
      return { success: false, message: `Unknown list_type: ${op.list_type}` };
  }
}

function processTodoOp(
  store: ListsStore,
  op: ListOperation,
  now: string,
): ListOperationResult {
  switch (op.action) {
    case 'add': {
      const data = JSON.parse(op.item_data || '{}');
      const item: TodoItem = {
        id: generateId('todo'),
        text: data.text || '',
        done: false,
        priority: data.priority,
        due_date: data.due_date,
        reminder_task_id: data.reminder_task_id,
        created_at: now,
        created_by: op.source_group,
      };
      store.todo.push(item);
      writeLists(store);
      return { success: true, message: 'Todo added', item_id: item.id };
    }
    case 'update': {
      const idx = store.todo.findIndex((t) => t.id === op.item_id);
      if (idx === -1)
        return { success: false, message: `Todo not found: ${op.item_id}` };
      const data = JSON.parse(op.item_data || '{}');
      Object.assign(store.todo[idx], data);
      if (data.done === true && !store.todo[idx].completed_at) {
        store.todo[idx].completed_at = now;
      }
      writeLists(store);
      return { success: true, message: 'Todo updated', item_id: op.item_id };
    }
    case 'remove': {
      const idx = store.todo.findIndex((t) => t.id === op.item_id);
      if (idx === -1)
        return { success: false, message: `Todo not found: ${op.item_id}` };
      store.todo.splice(idx, 1);
      writeLists(store);
      return { success: true, message: 'Todo removed', item_id: op.item_id };
    }
    default:
      return {
        success: false,
        message: `Unknown action for todo: ${op.action}`,
      };
  }
}

function processShoppingOp(
  store: ListsStore,
  op: ListOperation,
  now: string,
): ListOperationResult {
  switch (op.action) {
    case 'add': {
      const data = JSON.parse(op.item_data || '{}');
      const item: ShoppingItem = {
        id: generateId('shop'),
        name: data.name || '',
        quantity: data.quantity,
        category: data.category || 'Altro',
        status: 'to_buy',
        created_at: now,
        created_by: op.source_group,
      };
      store.shopping.push(item);
      writeLists(store);
      return { success: true, message: 'Shopping item added', item_id: item.id };
    }
    case 'update': {
      const idx = store.shopping.findIndex((s) => s.id === op.item_id);
      if (idx === -1)
        return {
          success: false,
          message: `Shopping item not found: ${op.item_id}`,
        };
      const data = JSON.parse(op.item_data || '{}');
      Object.assign(store.shopping[idx], data);
      writeLists(store);
      return {
        success: true,
        message: 'Shopping item updated',
        item_id: op.item_id,
      };
    }
    case 'remove': {
      const idx = store.shopping.findIndex((s) => s.id === op.item_id);
      if (idx === -1)
        return {
          success: false,
          message: `Shopping item not found: ${op.item_id}`,
        };
      store.shopping.splice(idx, 1);
      writeLists(store);
      return {
        success: true,
        message: 'Shopping item removed',
        item_id: op.item_id,
      };
    }
    case 'mark_bought': {
      const idx = store.shopping.findIndex((s) => s.id === op.item_id);
      if (idx === -1)
        return {
          success: false,
          message: `Shopping item not found: ${op.item_id}`,
        };
      store.shopping[idx].status = 'bought';
      store.shopping[idx].last_bought_at = now;
      writeLists(store);
      return {
        success: true,
        message: 'Marked as bought',
        item_id: op.item_id,
      };
    }
    case 'unmark_bought': {
      const idx = store.shopping.findIndex((s) => s.id === op.item_id);
      if (idx === -1)
        return {
          success: false,
          message: `Shopping item not found: ${op.item_id}`,
        };
      store.shopping[idx].status = 'to_buy';
      writeLists(store);
      return {
        success: true,
        message: 'Marked as to_buy',
        item_id: op.item_id,
      };
    }
    default:
      return {
        success: false,
        message: `Unknown action for shopping: ${op.action}`,
      };
  }
}

function processPurchasesOp(
  store: ListsStore,
  op: ListOperation,
  now: string,
): ListOperationResult {
  switch (op.action) {
    case 'add': {
      const data = JSON.parse(op.item_data || '{}');
      const item: PurchaseItem = {
        id: generateId('purch'),
        name: data.name || '',
        quantity: data.quantity,
        status: 'to_buy',
        created_at: now,
        created_by: op.source_group,
      };
      store.purchases.push(item);
      writeLists(store);
      return { success: true, message: 'Purchase added', item_id: item.id };
    }
    case 'update': {
      const idx = store.purchases.findIndex((p) => p.id === op.item_id);
      if (idx === -1)
        return { success: false, message: `Purchase not found: ${op.item_id}` };
      const data = JSON.parse(op.item_data || '{}');
      Object.assign(store.purchases[idx], data);
      writeLists(store);
      return { success: true, message: 'Purchase updated', item_id: op.item_id };
    }
    case 'remove': {
      const idx = store.purchases.findIndex((p) => p.id === op.item_id);
      if (idx === -1)
        return { success: false, message: `Purchase not found: ${op.item_id}` };
      store.purchases.splice(idx, 1);
      writeLists(store);
      return { success: true, message: 'Purchase removed', item_id: op.item_id };
    }
    case 'mark_bought': {
      const idx = store.purchases.findIndex((p) => p.id === op.item_id);
      if (idx === -1)
        return { success: false, message: `Purchase not found: ${op.item_id}` };
      store.purchases[idx].status = 'bought';
      store.purchases[idx].last_bought_at = now;
      writeLists(store);
      return { success: true, message: 'Marked as bought', item_id: op.item_id };
    }
    case 'unmark_bought': {
      const idx = store.purchases.findIndex((p) => p.id === op.item_id);
      if (idx === -1)
        return { success: false, message: `Purchase not found: ${op.item_id}` };
      store.purchases[idx].status = 'to_buy';
      writeLists(store);
      return { success: true, message: 'Marked as to_buy', item_id: op.item_id };
    }
    default:
      return {
        success: false,
        message: `Unknown action for purchases: ${op.action}`,
      };
  }
}

function processIdeasOp(
  store: ListsStore,
  op: ListOperation,
  now: string,
): ListOperationResult {
  switch (op.action) {
    case 'add': {
      const data = JSON.parse(op.item_data || '{}');
      const item: IdeaItem = {
        id: generateId('idea'),
        title: data.title || '',
        description: data.description || '',
        status: data.status || 'draft',
        tags: data.tags || [],
        notes: [],
        created_at: now,
        updated_at: now,
        created_by: op.source_group,
      };
      store.ideas.push(item);
      writeLists(store);
      return { success: true, message: 'Idea added', item_id: item.id };
    }
    case 'update': {
      const idx = store.ideas.findIndex((i) => i.id === op.item_id);
      if (idx === -1)
        return { success: false, message: `Idea not found: ${op.item_id}` };
      const data = JSON.parse(op.item_data || '{}');
      const { notes: _ignoreNotes, ...rest } = data;
      Object.assign(store.ideas[idx], rest);
      store.ideas[idx].updated_at = now;
      writeLists(store);
      return { success: true, message: 'Idea updated', item_id: op.item_id };
    }
    case 'remove': {
      const idx = store.ideas.findIndex((i) => i.id === op.item_id);
      if (idx === -1)
        return { success: false, message: `Idea not found: ${op.item_id}` };
      store.ideas.splice(idx, 1);
      writeLists(store);
      return { success: true, message: 'Idea removed', item_id: op.item_id };
    }
    case 'add_note': {
      const idx = store.ideas.findIndex((i) => i.id === op.item_id);
      if (idx === -1)
        return { success: false, message: `Idea not found: ${op.item_id}` };
      store.ideas[idx].notes.push({
        text: op.note_text || '',
        added_at: now,
        added_by: op.source_group,
      });
      store.ideas[idx].updated_at = now;
      writeLists(store);
      return { success: true, message: 'Note added', item_id: op.item_id };
    }
    default:
      return {
        success: false,
        message: `Unknown action for ideas: ${op.action}`,
      };
  }
}

export function writeListsSnapshot(groupFolder: string): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const store = readLists();
  const snapshotFile = path.join(groupIpcDir, 'current_lists.json');
  fs.writeFileSync(snapshotFile, JSON.stringify(store, null, 2));
}
