# Long-Term Memory System — Dettagli

## Architettura a 3 tier

### Tier 1: Workspace Manifest (file discovery)
- `writeWorkspaceManifest()` in `src/container-runner.ts`, chiamata prima dello spawn
- Scrive `{ipcDir}/workspace_manifest.json` con lista file del gruppo (cap 50, sort by modified DESC)
- Estrae heading (prima riga) per file .md

### Tier 2: FTS5 sui messaggi
- Virtual table `messages_fts` content-sync con `messages`
- Trigger INSERT/DELETE/UPDATE per sync automatico
- `searchMessagesFts()` con BM25 (peso 10 content, 1 sender_name)
- Fallback a LIKE se la query FTS fallisce
- **IMPORTANTE**: content-sync FTS5 va ricostruita con `INSERT INTO fts(fts) VALUES('rebuild')`, NON con INSERT...SELECT
- Migrazione tracciata in tabella `_migrations` (chiave `fts_rebuild_v1`)

### Tier 3: Knowledge Store
- Tabella `knowledge` con FTS5 (`knowledge_fts`)
- **Non partizionato per gruppo** — un utente, una memoria condivisa
- UPSERT per `key` sola (indice UNIQUE su `key`)
- Campi: category, confidence (1.0=esplicito, 0.6=inferenza), last_accessed_at, expires_at
- Se FTS non trova nulla, fallback: restituisce tutti gli entry (knowledge store piccolo)

### MCP Tools (container side)
File: `container/agent-runner/src/ipc-mcp-stdio.ts`
- `memory_search` — cerca knowledge + messaggi, NO chatJid filter (cross-chat)
- `memory_store` — UPSERT, ritorna inserted/updated
- `memory_list` — filtri category/prefix/only_expired
- `memory_delete` — delete per key

### IPC Handlers (host side)
File: `src/ipc.ts` — case `memory_search`, `memory_store`, `memory_list`, `memory_delete`
Risposte in `data/ipc/{group}/memory_responses/{requestId}.json`

### Salvataggio risposte bot
File: `src/index.ts`
- Output agente (streaming callback) → `storeMessage()` con `is_bot_message: true`
- IPC `send_message` → stesso trattamento
- Rende le risposte del bot cercabili via FTS

## File modificati

| File | Cosa |
|------|------|
| `src/db.ts` | FTS5 tables, triggers, knowledge CRUD, `migrateFts()` |
| `src/ipc.ts` | 4 handler IPC per memory tools |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | 4 MCP tools + `pollMemoryResponse()` |
| `container/agent-runner/src/index.ts` | `additionalDirectories` per global CLAUDE.md |
| `src/container-runner.ts` | `writeWorkspaceManifest()` |
| `src/index.ts` | Salvataggio risposte bot, `/reset` con `stopGroup()` |
| `src/group-queue.ts` | `stopGroup()` per killare container |
| `groups/global/CLAUDE.md` | Istruzioni memoria 3-tier + key discipline |

## Fasi future

### Fase 3 — Librarian Agent (scheduled task)
Task schedulato notturno (cron 0 3 * * *) che:
- Cerca entry duplicate/obsolete nel knowledge store → merge/delete
- Estrae fatti dalle conversazioni recenti → memory_store
- Verifica CLAUDE.md non superi 200 righe
- Prompt restrittivo: no delete senza motivo, confidence < 1.0 per inferenze, preferire update a delete+recreate

### Fase 4 — Vectorizzazione semantica
Obiettivo: risolvere il gap lessicale (query ≠ termini nel documento).
Esempio: "quanti anni ho" non matcha "user_birthdate: 13 luglio 1980" via FTS.

Approccio coerente con la filosofia NanoClaw (no servizi esterni):
- **sqlite-vss** per vector storage in SQLite (stessa infrastruttura)
- **Ollama** per embedding model locale (skill già disponibile `add-ollama-tool`)
  - Modello: `nomic-embed-text` o `mxbai-embed-large` (leggeri, buoni per italiano)
- Hybrid ranking: FTS5 BM25 + cosine similarity, merge pesato
- Indicizzare solo il knowledge store (piccolo, alta qualità) — non tutti i messaggi
- Trigger: embedding calcolato ad ogni `memory_store`, non ad ogni messaggio
- Fallback: se Ollama non è disponibile, usare FTS puro (graceful degradation)

Attivare quando:
- Knowledge store supera ~200 entry (fallback "dump all" diventa costoso in token)
- O gap lessicale diventa un problema ricorrente nonostante key discipline

Trade-off accettati:
- Latenza ~100ms per embedding (accettabile, non real-time)
- Ollama deve essere in esecuzione sul host (già richiesto se si usa add-ollama-tool)
- sqlite-vss è una C extension — richiede build nativo
