---
name: upstream-sync
description: Selective cherry-pick sync from qwibitai/nanoclaw upstream for this heavily customized fork. Skips skills/refactors/styles/deps and picks only security + core bug fixes. Triggers on "sync upstream", "aggiorna upstream", "cherry-pick upstream", "upstream fixes", "upstream security".
---

# About

Questo fork è pesantemente customizzato. Un `git merge upstream/main` cieco esplode in conflitti ingestibili. Questa skill esegue una **sync selettiva**: triaggia gli N commit upstream, identifica solo quelli rilevanti (security + bug fix su file core), li cherry-picka uno a uno, e gestisce i conflitti mantenendo le customizzazioni del fork.

Storico sync e commit già valutati in `docs/UPSTREAM-SYNC.md`. **Leggi sempre quel file prima di partire** per evitare di rivalutare commit già decisi.

Run `/upstream-sync` in Claude Code.

---

# Preflight (step 0)

1. Tree pulito:
   ```bash
   git status --porcelain
   ```
   Se sporco: offri di stashare o committare. Non procedere sporco.

2. Branch `main`:
   ```bash
   git checkout main
   ```

3. Fetch upstream:
   ```bash
   git fetch upstream --prune
   ```

4. Leggi `docs/UPSTREAM-SYNC.md` per lo storico e la lista dei commit già valutati (sezione "Commit già valutati").

5. Conta il delta:
   ```bash
   git rev-list --count main..upstream/main
   ```
   Se < 20: probabilmente poco lavoro, procedi con triage leggero. Se > 100: triage completo via sub-agent.

# Branch di lavoro (step 1)

```bash
git checkout -b chore/upstream-cherry-picks-$(date +%Y%m%d)
```

# Triage via sub-agent (step 2)

Spawna un sub-agent (Agent tool, subagent_type `general-purpose`) con questo prompt:

> Triagia i commit upstream/main per questo fork NanoClaw.
>
> Working dir: /Users/magico/PROJECTS/PERSONAL/nanoclaw
> Upstream remote: qwibitai/nanoclaw (già fetchato)
>
> ## Cosa interessa al fork
> - Security fix (command injection, path traversal, auth bypass)
> - Bug fix su file core: `src/container-runner.ts`, `src/container-runtime.ts`, `src/ipc.ts`, `src/index.ts`, `src/db.ts`, `src/task-scheduler.ts`, `src/router.ts`, `src/config.ts`, `container/agent-runner/src/*`, `container/Dockerfile`
> - Fix Telegram (canale primario): `src/channels/telegram.ts`, `src/telegram-format.ts`
> - Fix Gmail/OneCLI/Docker se riguardano integrazioni esistenti
>
> ## Cosa NON interessa
> - Nuove skill o update skill non usate (wiki, ollama, apple-container, emacs, migrate-*, slack, x-integration, whatsapp, statusbar, ecc.)
> - Refactor/rename senza fix
> - Style/prettier/eslint-only
> - Version bumps (`chore: bump version`)
> - Docs/README/CHANGELOG
> - CI/workflow changes
> - Test-only
> - Nuove feature che non sono bug fix
> - Dep updates puri (gestiti separatamente con `npm audit fix`)
>
> ## Commit già valutati in sync precedenti (ignora)
> [INCOLLA QUI LA LISTA DA docs/UPSTREAM-SYNC.md SEZIONE "Commit già valutati"]
>
> ## Task
> 1. `BASE=$(git merge-base HEAD upstream/main)`
> 2. `git log --oneline --no-merges $BASE..upstream/main` — escludi i già valutati
> 3. Per ogni commit nuovo: `git show --stat --format="" <hash>` per vedere i file toccati
> 4. Classifica ogni commit in: **PICK** (security/bug su file core), **MAYBE** (rischio conflitto con customizzazioni), **SKIP** (non interessa)
>
> ## Output
> ```
> ## PICK (N commits)
> <hash> <subject>
>   Why: <motivo in una riga>
>   Files: <short list>
>
> ## MAYBE (N commits)
> <hash> <subject>
>   Why maybe: <motivo>
>
> ## SKIP summary
> - Skill additions: N
> - Version bumps: N
> - Docs/style/CI: N
> - Refactors without fixes: N
> ```
>
> Max 20 PICK, max 15 MAYBE. Non leggere file. Solo git log/show/stat. Report sotto 300 righe.

# Applicazione PICK (step 3)

Mostra all'utente la lista PICK e MAYBE. Chiedi conferma o modifica via `AskUserQuestion` (opzioni: procedi con PICK, includi MAYBE selezionati, solo security, abort).

Per ogni commit confermato, in ordine cronologico upstream:

```bash
git cherry-pick -x <hash>
```

## Casi di risoluzione conflitti

| Situazione | Azione |
|------------|--------|
| `nothing to commit` (empty) | `git cherry-pick --skip` — già presente nel fork |
| File custom con modifiche aggiunte dall'upstream (import, helper) | Merge: tieni entrambi |
| Upstream rimuove un simbolo custom (export, env var, settings) | Tieni HEAD |
| Upstream ha implementazione più semplice di funzione custom del fork | Tieni HEAD (il nostro è un superset) |
| Solo formattazione prettier diversa | Tieni HEAD |
| Conflitto su `package.json`/`package-lock.json` | **Abort** cherry-pick, gestisci con `npm audit fix` a fine |
| Conflitto grosso su SDK upgrade (es. tocca molti file e cambia API) | **Abort**, segnala all'utente, da gestire a mano |
| Commit tocca sia file custom che file core | Risolvi a mano solo le parti rilevanti, tieni HEAD sul resto |

**Regola guida**: il nostro codice è spesso già un superset o una versione più conservativa. Default bias: tieni HEAD. Prendi upstream solo se porta qualcosa di genuinamente nuovo (nuovo handler, nuova validation, nuovo mount).

Dopo ogni risoluzione:
1. `npx tsc --noEmit` per verificare typecheck
2. `git add -u && git cherry-pick --continue --no-edit` oppure `git cherry-pick --skip` se il risultato è empty

# Dependency audit (step 4)

Indipendente dai cherry-pick. Esegui sempre:

```bash
cd /Users/magico/PROJECTS/PERSONAL/nanoclaw
npm audit fix
npm --prefix container/agent-runner audit fix
```

Se `npm audit fix` non basta e `npm audit` riporta ancora vuln, valuta caso per caso. **Non** usare `--force` senza leggere le breaking changes.

# Build, deploy, test (step 5)

```bash
npx tsc --noEmit
svc d
```

Aspetta 2 secondi, poi leggi `logs/nanoclaw.log`: verifica che lo scheduler loop sia partito e che i canali siano connessi. Se appaiono errori, rollback:

```bash
git reset --hard main@{1}   # oppure il commit pre-cherry-pick
```

Chiedi all'utente di mandare un messaggio di test da Telegram.

# Merge + push + log storico (step 6)

Dopo conferma che funziona:

```bash
git checkout main
git merge chore/upstream-cherry-picks-$(date +%Y%m%d) --no-ff \
  -m "merge: cherry-pick upstream fixes $(date +%Y-%m)"
git push origin main
```

Poi aggiorna `docs/UPSTREAM-SYNC.md`:
1. Aggiungi entry in "Storico sync" con data, hash upstream/main del momento, PICK applicati vs proposti, note
2. Appendi i nuovi commit-hash valutati alla lista "Commit già valutati"
3. Commit: `chore: update upstream-sync log after <date>`

# Regole di disciplina

- **Non fare mai** `git merge upstream/main` cieco. Sempre cherry-pick.
- **Non pickare** nuove skill o feature. Solo fix.
- **Non toccare** package-lock nei cherry-pick. Sempre a fine con `npm audit fix`.
- **Default bias conservativo**: se dubbi su un commit, mettilo in MAYBE e chiedi all'utente.
- **Documenta**: ogni commit valutato va nel log storico, non vanno mai rivalutati la volta dopo.
- **Cadenza consigliata**: ogni 2 mesi. Più frequente = meno lavoro per sessione.

# Quando NON usare questa skill

Se la divergenza diventa ingestibile (>500 commit upstream E molti fix rilevanti accumulati) valuta di:
1. Fare un refactor per isolare le customizzazioni in file separati (vedi discussione architetturale in chat)
2. Usare `/migrate-nanoclaw` per estrarre le customizzazioni come intent e riapplicare su upstream pulito

Ma sconsigliato: finché `/upstream-sync` eseguito con cadenza regolare tiene il debito sotto controllo, non serve refactorare.
