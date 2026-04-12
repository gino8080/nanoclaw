# Upstream Sync Playbook

Questo documento è il **pattern riutilizzabile** per sincronizzare periodicamente questo fork con `upstream/main` (qwibitai/nanoclaw) senza merge di massa.

**Regola d'oro**: non fare `git merge upstream/main`. Il fork è troppo customizzato — un merge cieco esplode in conflitti. Invece, **cherry-pick selettivo** dei soli commit rilevanti.

**Cadenza consigliata**: ogni 2 mesi circa. Più frequente = meno lavoro per sessione.

---

## Cosa ci interessa dall'upstream

Da triagiare sempre:
- **Security fix** (command injection, path traversal, auth bypass, ecc.)
- **Crash/bug fix** sui file core che usi: `src/container-runner.ts`, `src/container-runtime.ts`, `src/ipc.ts`, `src/index.ts`, `src/db.ts`, `src/task-scheduler.ts`, `src/router.ts`, `src/config.ts`, `container/agent-runner/src/*`, `container/Dockerfile`
- **Fix Telegram** (canale primario): `src/channels/telegram.ts`, `src/telegram-format.ts`
- **Fix Gmail/OneCLI/Docker**: se riguardano integrazioni che usi
- **Security/dependency update**: `package.json`, `package-lock.json` — gestiti separatamente via `npm audit fix`

## Cosa NON ci interessa (skip immediato)

- Nuove skill (`.claude/skills/new-skill-x/SKILL.md`) — hai il tuo set custom
- Update di skill che non usi: wiki, ollama, apple-container, emacs, migrate-*, slack, x-integration, whatsapp, statusbar
- Pure refactor/rename senza fix
- Style/prettier/eslint-only
- Version bumps (`chore: bump version`)
- Docs/README/CHANGELOG
- CI/workflow changes
- Test-only
- Nuove feature non richieste (es. task-script feature series)

---

## Procedura (rieseguibile)

### 0. Preflight

```bash
cd /Users/magico/PROJECTS/PERSONAL/nanoclaw
git status                    # deve essere pulito
git checkout main
git fetch upstream --prune
git rev-list --count main..upstream/main   # commit dietro
```

Crea il branch di lavoro:
```bash
git checkout -b chore/upstream-cherry-picks-$(date +%Y%m%d)
```

### 1. Triage automatizzato

Dai a Claude il prompt sotto (copia-incolla integrale). Il sub-agent produce una lista `PICK` / `MAYBE` / `SKIP` in ~60 secondi.

**Prompt di triage** (incolla a Claude):

```
Triagia i commit upstream/main per questo fork NanoClaw.

Working dir: /Users/magico/PROJECTS/PERSONAL/nanoclaw
Upstream remote: qwibitai/nanoclaw (già fetchato)

Cosa interessa al fork:
- Bug fix e security fix su: src/container-runner.ts, src/container-runtime.ts,
  src/ipc.ts, src/index.ts, src/db.ts, src/task-scheduler.ts, src/router.ts,
  src/config.ts, container/agent-runner/src/*, container/Dockerfile
- Fix Telegram (canale primario)
- Fix Gmail/OneCLI se riguardano integrazioni esistenti
- Docker runtime fix

Cosa NON interessa:
- Nuove skill o update skill che non usa
- Refactor/rename senza fix
- Style, docs, CI, version bumps, test-only
- Nuove feature (non bugfix)
- Dep updates puri (gestiti con npm audit fix)

Task:
1. BASE=$(git merge-base HEAD upstream/main); git log --oneline --no-merges $BASE..upstream/main
2. Per ogni commit: git show --stat --format="" <hash>
3. Classifica PICK (security/bug su file core) / MAYBE (rischio conflitto con customizzazioni) / SKIP
4. Output: hash + subject + motivo (una riga), max 20 PICK, 15 MAYBE

Non leggere file. Solo git log/show/stat. Report sotto 300 righe.
```

### 2. Applicazione dei PICK

Per ogni commit nella lista PICK, in ordine cronologico upstream:

```bash
git cherry-pick -x <hash>
```

- **Commit vuoto** (`nothing to commit`): `git cherry-pick --skip` — già presente sul tuo ramo.
- **Conflitto**: apri i file, risolvi. **Tieni HEAD** se il tuo codice è superset/superiore. **Mergia** se il fix upstream è legittimamente aggiuntivo.
- **Conflitto su `package.json`/`package-lock.json`**: abort del cherry-pick, gestisci separatamente con `npm audit fix` alla fine.
- **Conflitto grosso su SDK upgrade** (es. `db3440f` upgrade agent SDK): abort, gestisci manualmente quando aggiorni le deps del container.

### 3. Dependency audit (sempre dopo i cherry-pick)

```bash
# Root
npm audit fix
# Agent-runner container
npm --prefix container/agent-runner audit fix
```

Se `npm audit fix` non basta, prova `npm audit fix --force` **solo** dopo aver letto le breaking changes. Altrimenti rimanda.

### 4. Build + deploy

```bash
npx tsc --noEmit        # verifica compili
svc d                    # build + kill container + restart
```

### 5. Merge in main + push

```bash
git checkout main
git merge chore/upstream-cherry-picks-$(date +%Y%m%d) --no-ff \
  -m "merge: cherry-pick upstream fixes $(date +%Y-%m)"
git push origin main
```

### 6. Registra nel log storico

Aggiorna la sezione "Storico sync" sotto con:
- Data
- Hash upstream/main del momento (per non rivalutare quei commit la prossima volta)
- Numero di PICK applicati vs trovati
- Note su ciò che hai saltato e perché

---

## Storico sync

### 2026-04-12

- `upstream/main` a quel momento: `934f063 update deps`
- Dietro: 304 commit
- PICK proposti: 18. **Applicati: 2** (`a4fd4f2` security stopContainer, `d000acc` Telegram https.globalAgent)
- Skip: `cb20038` (nostro handling più completo), `11847a1` (timezone fix già presente), `db3440f` (SDK upgrade invasivo — rimandato)
- Vuln risolte: `npm audit fix` ha sistemato 10 vuln root + 8 container (undici, vite, yaml, hono, path-to-regexp, qs). 0 vuln rimanenti.
- Già presenti sul fork (skip conflict-free): 10 commit assorbiti da merge upstream precedenti.

**Lezione**: il fork è meno indietro di quanto i 304 commit lasciassero pensare. I merge upstream precedenti hanno assorbito la maggior parte. Il vero delta era su 2-3 file specifici.

---

## Pattern dei conflitti tipici

Dalla sessione 2026-04-12, i casi ricorrenti:

| Situazione | Risoluzione |
|------------|-------------|
| Upstream aggiunge un import, noi abbiamo già import custom adiacenti | Merge: tieni entrambi |
| Upstream rimuove un simbolo custom dal `readEnvFile`/config | Tieni HEAD |
| Upstream ha una implementazione più semplice di una nostra funzione custom | Tieni HEAD (il nostro è un superset) |
| Upstream cambia solo formattazione prettier | Tieni HEAD (prettier nostro già OK) |
| Upstream cambia default value o modello SDK | **Leggi attentamente**, spesso va tenuto HEAD |
| Conflitto su `package.json`/`package-lock.json` | Abort, usa `npm audit fix` |
| Commit tocca sia file custom che file core | Risolvi a mano solo le parti rilevanti |

---

## Commit già valutati (da non rivalutare)

Prossima volta, passa questa lista al sub-agent di triage come "commit già noti" così non li rianalizza:

```
a4fd4f2 0f01fe2 f537597 c98205c 474346e 001ee6e 38009be 0015931
d05a8de 00ff0e0 d000acc cb20038 11847a1 d675859 8f01a9a 934f063
6c289c3 db3440f
```

Aggiorna questa lista dopo ogni sync con i nuovi hash valutati.
