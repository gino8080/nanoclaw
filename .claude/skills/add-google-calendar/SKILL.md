---
name: add-google-calendar
description: Add Google Calendar integration to NanoClaw. Read access to all calendars, write access only to a dedicated JARVIS calendar. Guides through GCP OAuth setup.
---

# Add Google Calendar Integration

This skill adds Google Calendar support to NanoClaw — read all calendars, write only to JARVIS.

## Phase 1: Pre-flight

### Check if already applied

Check if `container/agent-runner/src/gcalendar-mcp.ts` exists AND `NANOCLAW_CALENDAR_ID` is set in `.env`. If both exist, skip to Phase 3 (Setup verification).

Check if the code changes are in place:

```bash
grep -q 'gcalendar' container/agent-runner/src/index.ts && echo "Code changes present" || echo "Code changes missing"
grep -q 'gcalendar-mcp' src/container-runner.ts && echo "Mount present" || echo "Mount missing"
```

If code changes are present, skip to Phase 3.

## Phase 2: Code Changes

The code changes should already be in the codebase. If not, apply them:

1. **`container/agent-runner/src/gcalendar-mcp.ts`** — MCP server with 7 tools (calendar_list, calendar_get_events, calendar_search_events, calendar_freebusy, calendar_create_event, calendar_update_event, calendar_delete_event)
2. **`container/agent-runner/src/index.ts`** — Add `'mcp__gcalendar__*'` to allowedTools and gcalendar MCP server config
3. **`src/container-runner.ts`** — Add `~/.gcalendar-mcp` mount and `NANOCLAW_CALENDAR_ID` to readSecrets
4. **`groups/global/CLAUDE.md`** — Add Google Calendar section with rules and tool docs

## Phase 3: Setup

### Check existing credentials

```bash
ls -la ~/.gcalendar-mcp/ 2>/dev/null || echo "No Google Calendar config found"
```

If `credentials.json` already exists, skip to "Create JARVIS calendar" below.

### GCP Project Setup

Tell the user:

> I need Google Calendar API enabled in your GCP project (you can use the same project as Gmail):
>
> 1. Open https://console.cloud.google.com — select your existing project (or create one)
> 2. Go to **APIs & Services > Library**, search "Google Calendar API", click **Enable**
> 3. If you already have OAuth credentials from Gmail setup, we can reuse those — just copy the keys file:
>
> ```bash
> mkdir -p ~/.gcalendar-mcp
> cp ~/.gmail-mcp/gcp-oauth.keys.json ~/.gcalendar-mcp/gcp-oauth.keys.json
> ```
>
> If you don't have existing credentials, go to **APIs & Services > Credentials**, click **+ CREATE CREDENTIALS > OAuth client ID** (Desktop app), download JSON and tell me the path.

If user provides a path, copy it:

```bash
mkdir -p ~/.gcalendar-mcp
cp "/path/user/provided/gcp-oauth.keys.json" ~/.gcalendar-mcp/gcp-oauth.keys.json
```

If user pastes JSON content, write it to `~/.gcalendar-mcp/gcp-oauth.keys.json`.

### OAuth Authorization

Tell the user:

> I'm going to run Calendar authorization. A browser window will open — sign in and grant access. If you see an "app isn't verified" warning, click "Advanced" then "Go to [app name] (unsafe)" — this is normal for personal OAuth apps.

Build the MCP server first, then run auth:

```bash
cd /Users/magico/PROJECTS/PERSONAL/nanoclaw/container/agent-runner
npx tsc src/gcalendar-mcp.ts --outDir dist --module nodenext --moduleResolution nodenext --target es2022 --esModuleInterop --skipLibCheck 2>/dev/null || true
node dist/gcalendar-mcp.js auth
```

If that doesn't work, try compiling from the container build context:

```bash
cd /Users/magico/PROJECTS/PERSONAL/nanoclaw
npx tsx container/agent-runner/src/gcalendar-mcp.ts auth
```

Verify: `ls ~/.gcalendar-mcp/credentials.json`

### Create JARVIS calendar

After auth succeeds, create the JARVIS calendar programmatically:

```bash
# Get access token
TOKEN=$(node -e "const c=JSON.parse(require('fs').readFileSync(process.env.HOME+'/.gcalendar-mcp/credentials.json','utf8')); console.log(c.access_token)")

# Create calendar
RESPONSE=$(curl -s -X POST 'https://www.googleapis.com/calendar/v3/calendars' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"summary": "JARVIS", "description": "NanoClaw managed calendar", "timeZone": "Europe/Rome"}')

echo "$RESPONSE"
CALENDAR_ID=$(echo "$RESPONSE" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
echo "Calendar ID: $CALENDAR_ID"
```

If a JARVIS calendar already exists (check with `calendar_list`), use its ID instead.

Add the calendar ID to `.env`:

```bash
echo "NANOCLAW_CALENDAR_ID=$CALENDAR_ID" >> /Users/magico/PROJECTS/PERSONAL/nanoclaw/.env
```

### Clear stale agent-runner copies

```bash
rm -r /Users/magico/PROJECTS/PERSONAL/nanoclaw/data/sessions/*/agent-runner-src 2>/dev/null || true
```

### Build and restart

Rebuild container (agent-runner changed):

```bash
cd /Users/magico/PROJECTS/PERSONAL/nanoclaw/container && ./build.sh
```

Compile and restart:

```bash
cd /Users/magico/PROJECTS/PERSONAL/nanoclaw
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test tool access

Tell the user:

> Google Calendar is connected! Send this in your main channel:
>
> `@Jarvis lista i miei calendari`
> `@Jarvis cosa ho in agenda domani?`
> `@Jarvis crea evento "Test JARVIS" domani alle 15:00 per 1 ora`

### Check logs if needed

```bash
tail -f /Users/magico/PROJECTS/PERSONAL/nanoclaw/logs/nanoclaw.log
```

## Troubleshooting

### OAuth token expired

Re-authorize:

```bash
rm ~/.gcalendar-mcp/credentials.json
npx tsx /Users/magico/PROJECTS/PERSONAL/nanoclaw/container/agent-runner/src/gcalendar-mcp.ts auth
```

### Container can't access Calendar

- Verify `~/.gcalendar-mcp` is mounted: check `src/container-runner.ts` for the `.gcalendar-mcp` mount
- Verify `NANOCLAW_CALENDAR_ID` is in `.env`
- Check container logs: `cat groups/main/logs/container-*.log | tail -50`

### Calendar not showing in Apple Calendar

Events created via Google Calendar API sync to Apple Calendar via Google account sync. Latency: 15-30 minutes. Force refresh: Settings > Calendar > Accounts > Fetch.

## Removal

1. Remove `gcalendar` MCP server block and `'mcp__gcalendar__*'` from `container/agent-runner/src/index.ts`
2. Remove `~/.gcalendar-mcp` mount from `src/container-runner.ts`
3. Remove `NANOCLAW_CALENDAR_ID` from `readSecrets` in `src/container-runner.ts`
4. Remove Google Calendar section from `groups/global/CLAUDE.md`
5. Delete `container/agent-runner/src/gcalendar-mcp.ts`
6. Remove `NANOCLAW_CALENDAR_ID` from `.env`
7. Clear stale copies: `rm -r data/sessions/*/agent-runner-src 2>/dev/null || true`
8. Rebuild: `cd container && ./build.sh && cd .. && npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
