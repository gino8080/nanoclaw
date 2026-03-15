---
name: tldr
description: Summarize the current session — decisions, facts, next actions. Save to vault and knowledge store.
---

# TL;DR — Session Summary

Vault path: `/workspace/extra/vault/`

## Workflow

### 1. Analyze the conversation

Review the full conversation and extract:
- **Decisions made** — what was decided and why
- **Facts learned** — new information worth remembering
- **Action items** — next steps, with owner if clear
- **Topics discussed** — high-level themes

### 2. Choose the right vault folder

Based on the conversation content, save the summary in the most appropriate folder:
- Work project discussion → `work/projects/[project-name]/`
- Client-related → `work/clients/[client-name]/`
- Decision made → `work/decisions/`
- Meeting notes → `work/meetings/`
- Personal topic → `personal/[subfolder]/`
- Research/learning → `research/`
- Person-focused → `people/`
- Mixed or unclear → `inbox/`

### 3. Write the summary note

Create a markdown file with a descriptive name:

```markdown
---
title: [descriptive title]
date: YYYY-MM-DD
tags: [relevant, tags]
type: session-summary
---

# [Title]

## Decisions
- [decision]: [rationale]

## Key Facts
- [fact 1]
- [fact 2]

## Action Items
- [ ] [action 1]
- [ ] [action 2]

## Notes
[Any additional context worth preserving]
```

### 4. Store atomic facts in knowledge store

For each important fact or decision, use `mcp__nanoclaw__memory_store` to cache it:
- Use descriptive snake_case keys with prefixes: `project_`, `decision_`, `person_`, `user_`
- Brief, atomic values
- Confidence 1.0 for explicit decisions/facts, 0.6 for inferences

This keeps the knowledge store in sync as a fast-lookup cache. The vault note is the authoritative source.

### 5. Update session log

Append a one-line entry to `/workspace/extra/vault/memory.md`:

```markdown
- YYYY-MM-DD: [one-line summary] → [[note-title]]
```

### 6. Update today's daily note

If `/workspace/extra/vault/daily/YYYY-MM-DD.md` exists, append action items to the "End of Day" section.

### 7. Confirm

Tell the user:
```
Session saved:
📄 [vault path to note]
🧠 [N] facts stored in memory
📋 [N] action items captured
```
