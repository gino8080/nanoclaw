# Scripts

## logs.sh — Log Viewer

Visualizzatore di log unificato per NanoClaw. Mostra log del servizio host, container agent e pool bot swarm con colori e filtri.

### Uso

```bash
# Direttamente
./scripts/logs.sh [mode]

# Oppure via npm
npm run logs            # Tutti i log live (colorati per tipo)
npm run logs:status     # Snapshot rapido dello stato
npm run logs:host       # Solo log del processo host
npm run logs:agents     # Solo log dei container agent
npm run logs:pool       # Solo attivita swarm pool bot
npm run logs:errors     # Solo errori e warning
```

### Modi

| Comando | Descrizione |
|---------|-------------|
| `logs` (default) | Segue tutti i log in tempo reale, colorati per tipo: `[host]`, `[agent]`, `[pool]`, `[error]` |
| `status` | Snapshot non-interattivo: stato servizio, container attivi, gruppi registrati, attivita recente |
| `host` | Solo `logs/nanoclaw.log` in tempo reale |
| `agents` | Log dei container agent (`groups/*/logs/container-*.log`). Fallback su `docker logs` se non trova file |
| `pool` | Filtra solo attivita dei pool bot swarm (sender, rename, assegnamento) |
| `errors` | Filtra solo ERROR, WARN, FATAL |

### Esempio output `status`

```
═══ SERVICE ═══
  ● Running (PID: 12345)

═══ CONTAINERS ═══
  ● nanoclaw-telegram-main-123456 (Up 5 minutes)
  ● nanoclaw-telegram-swarm-789012 (Up 2 minutes)

═══ REGISTERED GROUPS ═══
  Telegram Main (tg:123456) [main, no-trigger]
  Telegram Swarm (tg:-100789) [no-trigger]

═══ RECENT ACTIVITY (last 10 lines) ═══
  ...

═══ POOL BOT ACTIVITY ═══
  ...
```

### Tips

- `Ctrl+C` per fermare i modi live
- I modi live usano `tail -f` con filtri `grep --line-buffered`
- Lo `status` mode e utile per check rapidi senza bloccare il terminale
