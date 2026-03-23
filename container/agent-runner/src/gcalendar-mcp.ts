/**
 * Stdio MCP Server for Google Calendar API
 * Provides read access to all calendars and write access ONLY to the JARVIS calendar.
 * OAuth2 token refresh handled manually via raw fetch.
 *
 * Auth flow: `node gcalendar-mcp.js auth`
 * Normal mode: launched as MCP server by Claude SDK
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';

const JARVIS_CALENDAR_ID = process.env.NANOCLAW_CALENDAR_ID!;
const CONFIG_DIR =
  process.env.GCALENDAR_CONFIG_DIR ||
  path.join(process.env.HOME || '/home/node', '.gcalendar-mcp');
const OAUTH_KEYS_PATH = path.join(CONFIG_DIR, 'gcp-oauth.keys.json');
const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json');
const BASE = 'https://www.googleapis.com/calendar/v3';

// ── OAuth2 helpers ──────────────────────────────────────────────────────

interface OAuthKeys {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
}

interface Credentials {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
}

function readOAuthKeys(): OAuthKeys {
  const raw = JSON.parse(fs.readFileSync(OAUTH_KEYS_PATH, 'utf-8'));
  const key = raw.installed || raw.web;
  if (!key) throw new Error('Invalid gcp-oauth.keys.json: no installed or web key');
  return {
    client_id: key.client_id,
    client_secret: key.client_secret,
    redirect_uris: key.redirect_uris || ['http://localhost:3333'],
  };
}

function readCredentials(): Credentials {
  return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
}

function writeCredentials(creds: Credentials): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
}

async function refreshAccessToken(creds: Credentials): Promise<Credentials> {
  const keys = readOAuthKeys();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: keys.client_id,
      client_secret: keys.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  const updated: Credentials = {
    ...creds,
    access_token: data.access_token,
    expiry_date: Date.now() + data.expires_in * 1000,
  };
  writeCredentials(updated);
  return updated;
}

async function getAccessToken(): Promise<string> {
  let creds = readCredentials();
  if (Date.now() >= creds.expiry_date - 60_000) {
    creds = await refreshAccessToken(creds);
  }
  return creds.access_token;
}

// ── Calendar API helper ─────────────────────────────────────────────────

async function calendarApi(
  method: string,
  apiPath: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const token = await getAccessToken();
  const url = `${BASE}${apiPath}`;
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (method === 'DELETE' && res.status === 204) return { deleted: true };
  if (!res.ok) {
    throw new Error(`Calendar API ${res.status}: ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// ── Result helpers ──────────────────────────────────────────────────────

function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
    isError: true,
  };
}

// ── Auth subcommand ─────────────────────────────────────────────────────

async function runAuth(): Promise<void> {
  const keys = readOAuthKeys();
  const redirectUri = 'http://localhost:3333';
  const scope = 'https://www.googleapis.com/auth/calendar';

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', keys.client_id);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scope);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  console.log(`\nOpen this URL in your browser:\n\n${authUrl.toString()}\n`);

  const code = await new Promise<string>((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url!, `http://localhost:3333`);
      const c = u.searchParams.get('code');
      if (c) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<h1>Authorization successful!</h1><p>You can close this tab.</p>',
        );
        srv.close();
        resolve(c);
      } else {
        res.writeHead(400);
        res.end('Missing code parameter');
        srv.close();
        reject(new Error('No code received'));
      }
    });
    srv.listen(3333, () => {
      console.log('Waiting for OAuth callback on http://localhost:3333 ...');
    });
  });

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: keys.client_id,
      client_secret: keys.client_secret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(
      `Token exchange failed ${tokenRes.status}: ${await tokenRes.text()}`,
    );
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const creds: Credentials = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expiry_date: Date.now() + tokenData.expires_in * 1000,
  };
  writeCredentials(creds);
  console.log(`\nCredentials saved to ${CREDENTIALS_PATH}`);
}

// ── Auth mode check ─────────────────────────────────────────────────────

if (process.argv[2] === 'auth') {
  await runAuth();
  process.exit(0);
}

// ── MCP Server ──────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'gcalendar',
  version: '1.0.0',
});

// --- Read tools (any calendar) ---

server.tool(
  'calendar_list',
  'List all Google Calendars available to the user, with id, summary, and primary flag.',
  {},
  async () => {
    try {
      const data = await calendarApi('GET', '/users/me/calendarList');
      return textResult(data);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  'calendar_get_events',
  `Get events from a specific calendar within a time range.
Use ISO 8601 datetime with timezone offset for timeMin/timeMax (e.g. 2026-03-18T00:00:00+01:00).`,
  {
    calendarId: z
      .string()
      .describe(
        'Calendar ID (use "primary" for the main calendar, or a specific ID from calendar_list)',
      ),
    timeMin: z
      .string()
      .describe('Start of time range (ISO 8601 with timezone)'),
    timeMax: z
      .string()
      .describe('End of time range (ISO 8601 with timezone)'),
    maxResults: z
      .number()
      .optional()
      .describe('Max events to return (default: 50)'),
    query: z
      .string()
      .optional()
      .describe('Free-text search filter (optional)'),
  },
  async ({ calendarId, timeMin, timeMax, maxResults, query }) => {
    try {
      const params = new URLSearchParams({
        timeMin,
        timeMax,
        maxResults: String(maxResults || 50),
        singleEvents: 'true',
        orderBy: 'startTime',
      });
      if (query) params.set('q', query);
      const data = await calendarApi(
        'GET',
        `/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      );
      return textResult(data);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  'calendar_search_events',
  `Search events by text query across all calendars or specific ones.
Returns matching events from each calendar.`,
  {
    query: z.string().describe('Text to search for in event fields'),
    calendarIds: z
      .array(z.string())
      .optional()
      .describe(
        'Specific calendar IDs to search (omit to search all calendars)',
      ),
    timeMin: z
      .string()
      .optional()
      .describe('Start of time range (ISO 8601, default: now)'),
    timeMax: z
      .string()
      .optional()
      .describe('End of time range (ISO 8601, default: 1 year from now)'),
  },
  async ({ query, calendarIds, timeMin, timeMax }) => {
    try {
      let ids = calendarIds;
      if (!ids || ids.length === 0) {
        const list = (await calendarApi(
          'GET',
          '/users/me/calendarList',
        )) as { items?: { id: string }[] };
        ids = (list.items || []).map((c) => c.id);
      }

      const now = new Date().toISOString();
      const oneYear = new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000,
      ).toISOString();

      const results: Record<string, unknown> = {};
      for (const id of ids) {
        const params = new URLSearchParams({
          q: query,
          timeMin: timeMin || now,
          timeMax: timeMax || oneYear,
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '20',
        });
        try {
          const data = await calendarApi(
            'GET',
            `/calendars/${encodeURIComponent(id)}/events?${params}`,
          );
          const items = (data as { items?: unknown[] }).items;
          if (items && items.length > 0) {
            results[id] = items;
          }
        } catch {
          // Skip calendars that error (permissions, etc.)
        }
      }
      return textResult(results);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  'calendar_freebusy',
  'Check free/busy status across one or more calendars for a time range.',
  {
    calendarIds: z
      .array(z.string())
      .describe('Calendar IDs to check'),
    timeMin: z.string().describe('Start of range (ISO 8601)'),
    timeMax: z.string().describe('End of range (ISO 8601)'),
  },
  async ({ calendarIds, timeMin, timeMax }) => {
    try {
      const data = await calendarApi('POST', '/freeBusy', {
        timeMin,
        timeMax,
        items: calendarIds.map((id) => ({ id })),
      });
      return textResult(data);
    } catch (err) {
      return errorResult(err);
    }
  },
);

// --- Write tools (JARVIS calendar ONLY — calendarId is hardcoded) ---

server.tool(
  'calendar_create_event',
  `Create a new event on the JARVIS calendar.
Times must be ISO 8601 with timezone offset (e.g. 2026-03-18T15:00:00+01:00).
For all-day events, use date format YYYY-MM-DD for start and end.`,
  {
    summary: z.string().describe('Event title'),
    start: z
      .string()
      .describe(
        'Start time (ISO 8601 with timezone) or date (YYYY-MM-DD for all-day)',
      ),
    end: z
      .string()
      .describe(
        'End time (ISO 8601 with timezone) or date (YYYY-MM-DD for all-day)',
      ),
    description: z.string().optional().describe('Event description'),
    location: z.string().optional().describe('Event location'),
    attendees: z
      .array(z.string())
      .optional()
      .describe('Email addresses of attendees'),
  },
  async ({ summary, start, end, description, location, attendees }) => {
    try {
      const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(start);
      const event: Record<string, unknown> = {
        summary,
        start: isAllDay ? { date: start } : { dateTime: start },
        end: isAllDay ? { date: end } : { dateTime: end },
      };
      if (description) event.description = description;
      if (location) event.location = location;
      if (attendees && attendees.length > 0) {
        event.attendees = attendees.map((email) => ({ email }));
      }

      const data = await calendarApi(
        'POST',
        `/calendars/${encodeURIComponent(JARVIS_CALENDAR_ID)}/events`,
        event,
      );
      return textResult(data);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  'calendar_update_event',
  'Update an existing event on the JARVIS calendar. Only provided fields are changed.',
  {
    eventId: z.string().describe('Event ID to update'),
    summary: z.string().optional().describe('New title'),
    start: z.string().optional().describe('New start time (ISO 8601)'),
    end: z.string().optional().describe('New end time (ISO 8601)'),
    description: z.string().optional().describe('New description'),
    location: z.string().optional().describe('New location'),
    attendees: z
      .array(z.string())
      .optional()
      .describe('New attendee email list (replaces existing)'),
  },
  async ({ eventId, summary, start, end, description, location, attendees }) => {
    try {
      const patch: Record<string, unknown> = {};
      if (summary !== undefined) patch.summary = summary;
      if (description !== undefined) patch.description = description;
      if (location !== undefined) patch.location = location;
      if (start !== undefined) {
        const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(start);
        patch.start = isAllDay ? { date: start } : { dateTime: start };
      }
      if (end !== undefined) {
        const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(end);
        patch.end = isAllDay ? { date: end } : { dateTime: end };
      }
      if (attendees !== undefined) {
        patch.attendees = attendees.map((email) => ({ email }));
      }

      const data = await calendarApi(
        'PATCH',
        `/calendars/${encodeURIComponent(JARVIS_CALENDAR_ID)}/events/${encodeURIComponent(eventId)}`,
        patch,
      );
      return textResult(data);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  'calendar_delete_event',
  'Delete an event from the JARVIS calendar.',
  {
    eventId: z.string().describe('Event ID to delete'),
  },
  async ({ eventId }) => {
    try {
      const data = await calendarApi(
        'DELETE',
        `/calendars/${encodeURIComponent(JARVIS_CALENDAR_ID)}/events/${encodeURIComponent(eventId)}`,
      );
      return textResult(data);
    } catch (err) {
      return errorResult(err);
    }
  },
);

// ── Start server ────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
