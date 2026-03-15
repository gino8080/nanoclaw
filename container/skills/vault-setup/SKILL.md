---
name: vault-setup
description: Interactive Obsidian vault configurator. Asks the user about themselves, then builds a personalized vault structure with CLAUDE.md and slash commands.
---

# Vault Setup — Obsidian Configurator

The vault is mounted at `/workspace/extra/vault/`.

## STEP 1 — One question, free text

Display this message exactly, then wait for their response:

---

**Tell me about yourself in a few sentences so I can build your vault.**

Answer these in whatever order feels natural:

- What do you do for work?
- What falls through the cracks most — what do you wish you tracked better?
- Work only, or personal life too?
- Do you have existing files to import? (PDFs, docs, slides)

No need to be formal. A few sentences is enough.

---

## STEP 2 — Infer and preview, don't ask more questions

From their free-text answer, infer:
- Their role (business owner / developer / consultant / creator / student)
- Their primary pain point
- Scope (work only / work + personal / full life OS)
- Whether they have existing files

Then show a vault preview. Do NOT ask clarifying questions. Make smart inferences.

```
Here's your vault — ready to build when you are.

📁 vault
├── inbox/          Drop zone — everything new lands here first
├── daily/          Daily brain dumps and quick captures
├── work/
│   ├── projects/   Active projects with status and next actions
│   ├── clients/    Client notes and context
│   ├── decisions/  Decision log with rationale
│   └── meetings/   Meeting notes
├── personal/       [if scope includes personal]
│   ├── goals/      Objectives and tracking
│   ├── health/     Health and fitness
│   ├── finance/    Budget and expenses
│   └── travel/     Trip planning
├── people/         People notes (work + personal)
├── research/       Articles, ideas, learning
├── archive/        Completed work — never deleted, just moved
└── scripts/        Gemini processing scripts

Slash commands:
  /daily    — start your day with vault context
  /tldr     — save any session to the right folder
  /file-intel — analyze a document

Type "build it" to create this, or tell me what to change.
```

Adapt the folder structure based on their role. Wait for confirmation before building.

## STEP 3 — Build after confirmation

Once they confirm ("build it", "yes", "go", "looks good", or similar):

### Create any missing folders

Check which folders already exist under `/workspace/extra/vault/` and only create missing ones:

```bash
mkdir -p /workspace/extra/vault/{inbox,daily,work/{projects,clients,decisions,meetings},personal/{goals,health,finance,travel},people,research,archive,scripts}
```

Adjust based on the preview shown in Step 2.

### Write CLAUDE.md

Write directly to `/workspace/extra/vault/CLAUDE.md`:

```markdown
# Second Brain — [inferred role]

## Who I Am
[2-3 sentences based on what they told you — specific, personal, written as Claude describing its owner]

## Vault Structure
[folder tree with one-line purpose per folder]

## How I Work
[3-4 bullet points inferred from their answers — capture style, main pain point, scope]

## Context Rules
- Decision mentioned → check work/decisions/ first
- Person/client mentioned → look in people/ or work/clients/
- Writing content → read recent daily/ notes to match voice
- New file in inbox/ → ask if it should be sorted
- Important fact → save to both vault AND memory_store (vault = truth, knowledge store = cache)

## Conventions
- Use Obsidian markdown: wikilinks [[note]], tags #tag, frontmatter, callouts
- Frontmatter on every note: title, date, tags at minimum
- Link related notes with wikilinks
```

### Write memory.md

```markdown
# Memory

## Session Log
[Updated by Claude after each session via /tldr]

## Preferences
[Added as Claude learns them]
```

## STEP 4 — Final output

```
Done. Your vault is ready.

Slash commands available:
  /daily      — run this every morning
  /tldr       — run at the end of any session
  /file-intel — analyze documents

Have files to import?
  Drop them in a folder and run on the host:
  cd ~/obsidian-vault/scripts && source .venv/bin/activate
  python process_docs.py ~/path/to/files/
  Then tell me: "Sort everything in inbox/"
```
