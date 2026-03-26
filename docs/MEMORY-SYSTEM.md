# Memory System

## Architecture

3 livelli di memoria, confini chiari:

| Livello | Storage | Scope | Cosa ci va |
|---------|---------|-------|------------|
| **Knowledge Store** | SQLite `knowledge` + FTS5 | Cross-group, condiviso | Fatti atomici: preferenze, persone, date, relazioni |
| **Vault** | File `.md` in Obsidian | Globale (montato) | Documenti strutturati: piani, analisi, meeting notes |
| **Procedural Skills** | File `.md` in `global/skills/` | Globale (tutti leggono, main scrive) | Procedure riutilizzabili per task complessi |

Infrastruttura (non direttamente usata dall'utente):
- **Messages FTS5**: cronologia messaggi, full-text search con BM25
- **Workspace Manifest**: file discovery all'avvio del container
- **Memory Summarizer**: sintesi LLM (Haiku) quando >=5 risultati di ricerca
- **Context Primer**: ultimi 10 messaggi iniettati al restart del container per continuita'
- **Claude Auto-Memory**: memoria built-in di Claude Code (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=0`)

## Knowledge Store

- Tabella `knowledge` con FTS5 (`knowledge_fts`)
- Non partizionato per gruppo — un utente, una memoria condivisa
- UPSERT per `key` sola (indice UNIQUE su `key`)
- Campi: category, confidence (1.0=esplicito, 0.6=inferenza), last_accessed_at, expires_at
- Se FTS non trova nulla, fallback: restituisce tutti gli entry

### MCP Tools
- `memory_search` — cerca knowledge + messaggi, cross-chat
- `memory_store` — UPSERT, ritorna inserted/updated
- `memory_list` — filtri category/prefix/only_expired
- `memory_delete` — delete per key

## Messages FTS5

- Virtual table `messages_fts` content-sync con `messages`
- Trigger INSERT/DELETE/UPDATE per sync automatico
- `searchMessagesFts()` con BM25 (peso 10 content, 1 sender_name)
- Fallback a LIKE se la query FTS fallisce
- Content-sync FTS5 va ricostruita con `INSERT INTO fts(fts) VALUES('rebuild')`

## Context Primer

Quando un nuovo container viene spawnato (non quando si pipano messaggi a uno gia' attivo),
gli ultimi 10 messaggi della chat vengono inclusi come contesto nel prompt, indipendentemente
dal cursore. Questo garantisce continuita' conversazionale dopo restart del container.

- Implementato in `src/index.ts` (`processMessages()`)
- Usa `getRecentMessages()` da `src/db.ts`
- Include sia messaggi user che bot
- Deduplicato: messaggi gia' in `missedMessages` non vengono ripetuti
- Tag: `<recent_context>` nel prompt

## Memory Summarizer

- `src/memory-summarizer.ts` — chiamata non-bloccante con graceful degradation
- Modello: `claude-haiku-4-5-20251001` via HTTPS API (no SDK)
- Trigger: >=5 risultati da `memory_search` o `search_messages`
- Timeout: 5s, poi restituisce risultati raw
- Integrato in `src/ipc.ts` (case `search_messages` e `memory_search`)
- Container-side: summary mostrato in testa ai risultati

## Procedural Skills

- Path: `groups/global/skills/{skill-name}.md`
- Tutti i gruppi leggono, solo main scrive (mount read-only per non-main)
- L'agente crea skill dopo task complessi (3+ step), le consulta prima di task simili
- Formato: When to Use, Procedure, Notes, Version tracking

## File chiave

| File | Cosa |
|------|------|
| `src/db.ts` | FTS5, knowledge CRUD, `getRecentMessages()` |
| `src/ipc.ts` | IPC handlers per memory tools + summarizer integration |
| `src/memory-summarizer.ts` | LLM summarization layer |
| `src/index.ts` | Context primer, salvataggio risposte bot |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP tool definitions |
| `groups/global/CLAUDE.md` | Istruzioni agente per tutti i sistemi |

## Fasi future

### Librarian Agent (scheduled task)
Task schedulato notturno che:
- Cerca entry duplicate/obsolete nel knowledge store
- Estrae fatti dalle conversazioni recenti
- Prompt restrittivo: no delete senza motivo, confidence < 1.0 per inferenze

### Vectorizzazione semantica
Per risolvere il gap lessicale (query != termini nel documento):
- sqlite-vss per vector storage
- Ollama per embedding locale (`nomic-embed-text`)
- Hybrid ranking: FTS5 BM25 + cosine similarity
- Solo knowledge store (piccolo, alta qualita')
- Attivare quando knowledge store supera ~200 entry
