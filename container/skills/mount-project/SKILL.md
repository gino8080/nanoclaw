---
name: mount-project
description: Mount a development project into the container for code work
allowed-tools: Bash(git:*), Bash(ls:*), Bash(gh:*)
---

# /mount-project

Interactive workflow to mount a development project into the container.

## Steps

1. **List available projects**: Call `mcp__nanoclaw__list_available_projects` to show what's available under `~/PROJECTS`.

2. **Show the list to the user**: Format as a numbered list with git status indicators:

   ```
   Progetti disponibili:
   1. PERSONAL/my-app [git] [CLAUDE.md] (last: 2026-03-15)
   2. WORK/client-api [git] (last: 2026-03-14)
   3. PERSONAL/scripts
   ```

3. **User chooses**: Wait for the user to pick a project (by number or name).

4. **Ask access mode**: "Read-only o read-write? (default: read-write)"

5. **Mount**: Call `mcp__nanoclaw__mount_project` with the chosen project path and access mode.

6. **Confirm**: The container restarts automatically. On the next message, confirm:
   "Progetto montato in /workspace/extra/{nome}. Pronto a lavorare."

7. **Vault note** (if vault is mounted at `/workspace/extra/vault/`):
   - Check if `work/projects/{nome}.md` exists in the vault
   - If the vault is read-only, inform the user: "Nota progetto nel vault: aggiorna `work/projects/{nome}.md` con il mount path."
   - If writable, create/update the note with this template:

```yaml
---
title: { Project Name }
date: { YYYY-MM-DD }
tags: [project]
mount: /workspace/extra/{nome}
host_path: { full host path }
---
```

## Unmount

To unmount: `mcp__nanoclaw__unmount_project` with the container path name.

## Notes

- Projects are mounted at `/workspace/extra/{basename}`.
- The container STOPS after mount/unmount — the new mount takes effect on next query.
- Safety: all mounts are validated against the host allowlist. Blocked paths (`.ssh`, `.env`, credentials) are rejected.
