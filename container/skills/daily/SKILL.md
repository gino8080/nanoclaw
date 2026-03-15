---
name: daily
description: Daily review and planning. Reads or creates today's daily note, checks inbox, surfaces priorities.
---

# Daily Review

Vault path: `/workspace/extra/vault/`

## Workflow

### 1. Load today's daily note

```bash
DATE=$(date +%Y-%m-%d)
FILE="/workspace/extra/vault/daily/$DATE.md"
```

If the file exists, read it. If not, create it with this template:

```markdown
---
title: Daily — YYYY-MM-DD
date: YYYY-MM-DD
tags: [daily]
---

# YYYY-MM-DD

## Top of Mind


## Today's Focus


## Notes


## End of Day

```

### 2. Check inbox

Look for unprocessed files in `/workspace/extra/vault/inbox/`. List any files found with a one-line summary of each.

### 3. Surface recent context

Use `mcp__nanoclaw__memory_search` to find facts stored in the last few days. Summarize anything relevant.

Check recent daily notes (last 2-3 days) for ongoing threads or unfinished items.

### 4. Present the briefing

Format as a concise briefing:

```
*Daily Review — [date]*

📥 *Inbox:* [count] items waiting
[list if any]

🔄 *Ongoing:*
[threads from recent days]

🧠 *Recent memory:*
[relevant facts from knowledge store]

What are we working on today?
```

Wait for the user's response, then update the "Today's Focus" section in the daily note.
