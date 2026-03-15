---
name: obsidian-markdown
description: Obsidian-flavored markdown conventions for writing notes in the vault
---

# Obsidian Markdown

The vault is mounted at `/workspace/extra/vault/`. All notes use Obsidian-flavored markdown.

## Frontmatter / Properties

Every note should start with a YAML frontmatter block:

```markdown
---
title: 'Note Title'
tags: [topic, subtopic/detail]
date: '2026-03-15'
aliases: ['alternate name']
cssclasses: []
---
```

- Wrap string values in single quotes.
- `tags` is an array. Use it instead of (or alongside) inline tags.
- `aliases` lets the note be found by alternate names in wikilinks.
- `date` uses ISO 8601 format.

## Wikilinks

Internal links between notes. Always prefer wikilinks over standard markdown links for vault-internal references.

| Syntax | Result |
|--------|--------|
| `[[Note Name]]` | Link to note |
| `[[Note Name\|display text]]` | Link with custom display text |
| `[[Note Name#Heading]]` | Link to a specific heading |
| `[[Note Name#^block-id]]` | Link to a specific block |
| `[[Folder/Note Name]]` | Link to note in subfolder |

Best practices:
- Use the shortest unambiguous name. If `Meeting Notes` is unique, prefer `[[Meeting Notes]]` over `[[work/meetings/Meeting Notes]]`.
- When renaming would break links, add an `aliases` entry in frontmatter instead.
- Link generously. Connections between notes are the point.

## Tags

```markdown
Inline tag: #project/nanoclaw
Nested tag: #status/in-progress
```

- Tags in frontmatter `tags: [tag1, tag2]` are equivalent to inline tags.
- Use `/` for hierarchy: `#dev/typescript`, `#dev/python`.
- Keep tags lowercase, use hyphens for multi-word: `#long-term-memory`.
- Do not duplicate: if a tag is in frontmatter, do not repeat it inline.

## Callouts

Block-level emphasis using blockquote syntax:

```markdown
> [!tip] Optional Title
> Callout body text here.

> [!warning]
> Something to watch out for.

> [!info]
> Contextual information.

> [!note]
> General note.

> [!example]
> Concrete example.

> [!question]
> Open question to investigate.

> [!danger]
> Critical warning.

> [!success]
> Confirmed working / resolved.

> [!failure]
> Known broken / failed.

> [!bug]
> Bug report.
```

- Foldable callout: `> [!tip]-` (collapsed by default) or `> [!tip]+` (expanded by default).
- Callouts can be nested.

## Embeds

Embed content from other notes or files inline:

```markdown
![[Other Note]]              # Embed entire note
![[Other Note#Heading]]      # Embed specific section
![[image.png]]               # Embed image
![[image.png|300]]           # Embed image with width
![[document.pdf]]            # Embed PDF
```

- Embedded notes render their content directly in the parent note.
- Use embeds for reusable content blocks (templates, references).

## Highlighting

```markdown
This is ==highlighted text== in a sentence.
```

## Comments

```markdown
%%This text is hidden in reading view and preview.%%

%%
Multi-line comment.
Also hidden.
%%
```

- Use comments for author notes, TODOs, or context that should not appear in rendered output.

## Footnotes

```markdown
This claim needs a source[^1] and another[^ref-name].

[^1]: Source citation or explanation.
[^ref-name]: Named footnotes work the same way.
```

- Footnote definitions can go anywhere in the file; Obsidian renders them at the bottom.
- Use descriptive names for footnotes when there are many: `[^smith2024]`.

## Task Lists

```markdown
- [ ] Open task
- [x] Completed task
- [/] In progress
- [-] Cancelled
```

- Tasks are queryable by plugins (Dataview, Tasks).
- Add metadata inline if needed: `- [ ] Fix bug #dev 📅 2026-03-20`.

## File Organization

- Save new notes in the folder most relevant to their content.
- If unsure, use `inbox/` as a landing zone.
- Use consistent naming: lowercase with hyphens or title case, match the vault's existing convention.
- Check existing folder structure before creating new folders.
