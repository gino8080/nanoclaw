#!/bin/bash
# NanoClaw Log Viewer
# Usage:
#   ./scripts/logs.sh          # Follow all logs live
#   ./scripts/logs.sh status   # Quick status snapshot
#   ./scripts/logs.sh host     # Only host logs
#   ./scripts/logs.sh agents   # Only container agent logs
#   ./scripts/logs.sh pool     # Only swarm pool bot activity
#   ./scripts/logs.sh errors   # Only errors/warnings

set -euo pipefail
cd "$(dirname "$0")/.."

BOLD='\033[1m'
DIM='\033[2m'
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
BLUE='\033[34m'
MAGENTA='\033[35m'
CYAN='\033[36m'
RESET='\033[0m'

header() {
  echo ""
  echo -e "${BOLD}${BLUE}═══ $1 ═══${RESET}"
  echo ""
}

MODE="${1:-live}"

case "$MODE" in

  status)
    header "SERVICE"
    if launchctl list 2>/dev/null | grep -q nanoclaw; then
      PID=$(launchctl list | grep nanoclaw | awk '{print $1}')
      echo -e "  ${GREEN}● Running${RESET} (PID: $PID)"
    else
      echo -e "  ${RED}● Stopped${RESET}"
    fi

    header "CONTAINERS"
    CONTAINERS=$(docker ps --filter "name=nanoclaw" --format "{{.Names}}\t{{.Status}}" 2>/dev/null)
    if [ -z "$CONTAINERS" ]; then
      echo -e "  ${DIM}No active containers${RESET}"
    else
      echo "$CONTAINERS" | while IFS=$'\t' read -r name status; do
        echo -e "  ${GREEN}●${RESET} $name ${DIM}($status)${RESET}"
      done
    fi

    header "REGISTERED GROUPS"
    node -e "
      const Database = require('better-sqlite3');
      const db = new Database('store/messages.db');
      const rows = db.prepare('SELECT jid, name, folder, is_main, requires_trigger FROM registered_groups').all();
      rows.forEach(r => {
        const flags = [r.is_main ? 'main' : '', !r.requires_trigger ? 'no-trigger' : 'trigger'].filter(Boolean).join(', ');
        console.log('  ' + r.name + ' (' + r.jid + ') [' + flags + ']');
      });
      db.close();
    " 2>/dev/null || echo "  (DB not available)"

    header "RECENT ACTIVITY (last 10 lines)"
    tail -10 logs/nanoclaw.log 2>/dev/null | sed 's/^/  /' || echo "  (no logs)"

    header "POOL BOT ACTIVITY"
    grep -i "pool" logs/nanoclaw.log 2>/dev/null | tail -5 | sed 's/^/  /' || echo "  (no pool activity)"
    echo ""
    ;;

  host)
    header "HOST LOGS (live)"
    tail -f logs/nanoclaw.log
    ;;

  agents)
    header "AGENT CONTAINER LOGS (live)"
    # Find all container log files across groups and follow them
    LOG_FILES=$(find groups/*/logs -name 'container-*.log' -newer logs/nanoclaw.log 2>/dev/null | head -10)
    if [ -z "$LOG_FILES" ]; then
      LOG_FILES=$(find groups/*/logs -name 'container-*.log' 2>/dev/null | sort -r | head -5)
    fi
    if [ -z "$LOG_FILES" ]; then
      echo "No container logs found. Falling back to docker logs..."
      CONTAINER=$(docker ps --filter "name=nanoclaw" --format "{{.Names}}" 2>/dev/null | head -1)
      if [ -n "$CONTAINER" ]; then
        docker logs -f "$CONTAINER"
      else
        echo "No active containers."
      fi
    else
      echo -e "${DIM}Following: $LOG_FILES${RESET}"
      echo ""
      tail -f $LOG_FILES
    fi
    ;;

  pool)
    header "SWARM POOL BOT ACTIVITY (live)"
    tail -f logs/nanoclaw.log | grep --line-buffered -iE "pool|swarm|sender|renamed"
    ;;

  errors)
    header "ERRORS & WARNINGS (live)"
    tail -f logs/nanoclaw.log | grep --line-buffered -iE "ERROR|WARN|FATAL|fail|crash"
    ;;

  live|*)
    header "ALL LOGS (live) — Ctrl+C to stop"
    echo -e "  ${CYAN}[host]${RESET}    = NanoClaw host process"
    echo -e "  ${MAGENTA}[agent]${RESET}   = Container agent output"
    echo -e "  ${YELLOW}[pool]${RESET}    = Swarm pool bot messages"
    echo ""

    # Collect all log files to follow
    ALL_LOGS="logs/nanoclaw.log"
    AGENT_LOGS=$(find groups/*/logs -name 'container-*.log' 2>/dev/null | sort -r | head -10)
    if [ -n "$AGENT_LOGS" ]; then
      ALL_LOGS="$ALL_LOGS $AGENT_LOGS"
    fi

    tail -f $ALL_LOGS | while IFS= read -r line; do
      if echo "$line" | grep -qi "pool\|swarm\|renamed"; then
        echo -e "${YELLOW}[pool]${RESET}  $line"
      elif echo "$line" | grep -qi "ERROR\|FATAL\|fail"; then
        echo -e "${RED}[error]${RESET} $line"
      elif echo "$line" | grep -qi "WARN"; then
        echo -e "${YELLOW}[warn]${RESET}  $line"
      elif echo "$line" | grep -qi "==>.*container"; then
        echo -e "${MAGENTA}[agent]${RESET} $line"
      elif echo "$line" | grep -qi "Agent output\|Spawning container\|container agent"; then
        echo -e "${MAGENTA}[agent]${RESET} $line"
      else
        echo -e "${CYAN}[host]${RESET}  $line"
      fi
    done
    ;;

esac
