---
name: file-intel
description: Analyze documents and save structured insights to the vault. Single files via Claude, batch via Gemini script.
---

# File Intel — Document Analysis

Vault path: `/workspace/extra/vault/`

## Single File Analysis

For individual files (PDF, images, text documents) accessible in the workspace:

### 1. Read the file

Use the Read tool directly — Claude can handle PDFs and images natively.

### 2. Analyze and extract

From the document, extract:
- **Title** and document type
- **Key insights** — the most important points (3-7 bullets)
- **Context** — what this document is about, who created it, why it matters
- **Action items** — anything requiring follow-up
- **Related topics** — connections to existing vault content

### 3. Save to vault

Choose the most appropriate folder based on content:
- Work document → `work/projects/` or `work/clients/`
- Research paper/article → `research/`
- Personal document → `personal/[subfolder]/`
- Unclear → `inbox/`

Write as markdown:

```markdown
---
title: [document title]
source: [original filename]
date: YYYY-MM-DD
type: [pdf/image/document]
tags: [relevant, tags]
---

# [Title]

## Key Insights
- [insight 1]
- [insight 2]

## Context
[What this document is about and why it matters]

## Action Items
- [ ] [action if any]

## Notes
[Additional observations or extracted details]
```

### 4. Store key facts

Use `mcp__nanoclaw__memory_store` for atomic facts worth quick retrieval.

### 5. Link to related notes

Search the vault with Grep/Glob for related content and add wikilinks where relevant.

## Batch Processing (Large Document Sets)

For processing many documents at once, instruct the user to use the Gemini script on the host:

```
For batch processing, run this on your Mac:

cd ~/obsidian-vault/scripts
source .venv/bin/activate
python process_docs.py ~/path/to/documents/

Output lands in vault/inbox/. Then tell me "sort inbox" and I'll organize everything.
```

The Gemini script is more cost-effective for large batches (1M+ context window, lower cost per token).

## Post-Processing

After batch processing, when the user asks to sort inbox:
1. Read each file in `inbox/`
2. Move to the most appropriate folder
3. Add wikilinks to related existing notes
4. Store key facts in knowledge store
