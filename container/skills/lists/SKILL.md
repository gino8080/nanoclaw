---
name: lists
description: Manage shared lists (todo, shopping, purchases, ideas). Use for ANY request about shopping lists, to-do lists, reminders, ideas, buying things, or anything involving adding/removing/checking items from a list. NEVER create markdown files for lists — always use this skill.
allowed-tools: mcp__nanoclaw__manage_list, Read(/workspace/ipc/current_lists.json)
---

# Lists — Shared Lists Management

You have access to four shared lists via the `mcp__nanoclaw__manage_list` MCP tool. These lists are shared across all groups and persistent.

CRITICAL: NEVER create markdown files, text files, or any other files to manage lists. ALWAYS use `mcp__nanoclaw__manage_list`.

## List Types

| list_type | What it's for | When to use |
|-----------|---------------|-------------|
| `shopping` | Grocery/food shopping | User says "lista della spesa", "al supermercato", "da comprare al super", or the item is clearly food/grocery |
| `purchases` | Generic non-food purchases | User says "devo comprare X", "aggiungi X" without mentioning "spesa"/"supermercato", or the item is non-food (batteries, cables, clothes, etc.) |
| `todo` | Tasks, reminders, things to do | User says "devo fare", "ricordami di", "da fare" |
| `ideas` | Ideas, projects, brainstorming | User says "ho un'idea", "progetto", "potremmo fare" |

IMPORTANT: If the user does NOT explicitly say "spesa", "supermercato", "al super" or similar grocery-related words, use `purchases` — NOT `shopping`.

## Reading Lists

Before any list operation, read the current state from `/workspace/ipc/current_lists.json`. This snapshot is refreshed before each agent session.

## Tool: mcp__nanoclaw__manage_list

| action | list_type | required params | description |
|--------|-----------|----------------|-------------|
| `add` | `todo` | `item_data` (JSON: `{"text":"...", "priority":"low/medium/high", "due_date":"..."}`) | Add a todo/reminder |
| `add` | `shopping` | `item_data` (JSON: `{"name":"...", "quantity":"...", "category":"..."}`) | Add a grocery item |
| `add` | `purchases` | `item_data` (JSON: `{"name":"...", "quantity":"..."}`) | Add a generic purchase |
| `add` | `ideas` | `item_data` (JSON: `{"title":"...", "description":"...", "tags":["..."]}`) | Add an idea |
| `update` | any | `item_id` + `item_data` (partial JSON) | Update fields on an item |
| `remove` | any | `item_id` | Delete an item |
| `mark_bought` | `shopping`/`purchases` | `item_id` | Mark an item as bought |
| `unmark_bought` | `shopping`/`purchases` | `item_id` | Move a bought item back to to_buy |
| `add_note` | `ideas` | `item_id` + `note_text` | Append a note to an idea |

## Shopping Categories (only for `shopping` list)

When adding grocery items, assign one of these categories:
- Frutta e Verdura
- Latticini
- Carne e Pesce
- Pane e Cereali
- Bevande
- Surgelati
- Condimenti e Spezie
- Snack e Dolci
- Igiene e Casa
- Altro

## Reminders (Todo + Scheduled Task)

When the user asks for a reminder with a specific time:
1. Add a todo item with `due_date`
2. Create a `schedule_task` (type: `once`) at the reminder time with a prompt like "Ricorda all'utente: {text}"
3. Update the todo item with `reminder_task_id` pointing to the scheduled task

## Natural Language Examples

- "aggiungi latte alla lista della spesa" -> `shopping` (explicit "della spesa")
- "devo comprare delle batterie" -> `purchases` (no "spesa" mentioned, non-food)
- "aggiungi cavo USB" -> `purchases` (generic item, no grocery context)
- "prendi il pane al supermercato" -> `shopping` (explicit "supermercato")
- "cosa devo comprare?" -> show BOTH shopping AND purchases items with status "to_buy"
- "ho comprato il pane" -> find item in shopping or purchases, then `mark_bought`
- "ricordami di chiamare Mario domani alle 10" -> `todo` + schedule_task
- "ho un'idea per un'app di ricette" -> `ideas`
