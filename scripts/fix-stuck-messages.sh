#!/bin/bash
# fix-stuck-messages.sh — Stops NanoClaw, cleans stuck HTTP messages from DB,
# resets broken session, advances message cursor, then restarts.

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DB="$PROJECT_DIR/store/messages.db"

echo "=== NanoClaw: Fix stuck messages ==="
echo ""

# 1. Stop NanoClaw
echo "[1/4] Stopping NanoClaw..."
launchctl bootout "gui/$(id -u)/com.nanoclaw" 2>/dev/null && echo "      Stopped." || echo "      (was not running)"
sleep 1

# 2. Show what's stuck
echo ""
echo "[2/4] Checking DB for stuck messages..."
sqlite3 "$DB" "SELECT id, content, timestamp FROM messages WHERE id LIKE 'http-%';"

# 3. Clean up
echo ""
echo "[3/4] Cleaning up..."

# Delete HTTP-injected messages
DELETED=$(sqlite3 "$DB" "DELETE FROM messages WHERE id LIKE 'http-%'; SELECT changes();")
echo "      Deleted $DELETED stuck message(s)"

# Advance cursor past stuck timestamps
sqlite3 "$DB" <<'SQL'
UPDATE router_state
SET value = json_set(
  value,
  '$."tg:292955429"',
  strftime('%Y-%m-%dT%H:%M:%S.000Z', 'now')
)
WHERE key = 'last_agent_timestamp';
SQL
echo "      Advanced message cursor to now"

# Reset broken session
sqlite3 "$DB" "DELETE FROM sessions WHERE group_folder = 'telegram_main';"
echo "      Reset telegram_main session"

# 4. Rebuild and restart
echo ""
echo "[4/4] Rebuilding and restarting..."
cd "$PROJECT_DIR"
npm run build
launchctl kickstart -k "gui/$(id -u)/com.nanoclaw" 2>/dev/null || \
  launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null || \
  echo "      Could not restart — run 'npm run reload' manually"

echo ""
echo "✓ Done. NanoClaw is clean and running."
