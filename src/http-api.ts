/**
 * http-api.ts — Lightweight HTTP server for Siri Shortcuts integration.
 *
 * POST /ask  { "text": "domanda" }
 *            → { "response": "risposta di Jarvis", "ok": true }
 *
 * Runs on HTTP_API_PORT (default 3399) and is accessible only on the local
 * network. The iPhone Shortcut calls this endpoint directly, gets the answer
 * back as JSON and can read it aloud with the Speak Text action.
 *
 * Design notes:
 * - Messages are NOT stored in the DB to avoid the message-loop picking them
 *   up and triggering a parallel container run (race condition).
 * - A synthetic chatJid (`http:siri-<ts>`) is used for queue registration so
 *   the HTTP request doesn't collide with the real Telegram group queue state.
 * - The agent response is captured via the onOutput callback and returned
 *   directly to the HTTP client — it does NOT go through Telegram.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';

import { ContainerOutput } from './container-runner.js';
import { logger } from './logger.js';
import { formatMessages, stripInternalTags } from './router.js';
import { RegisteredGroup } from './types.js';

const MAC_IP = process.env.MAC_IP ?? '192.168.10.130';
const HTTP_API_PORT = parseInt(process.env.HTTP_API_PORT ?? '3399', 10);
const MAX_BODY_BYTES = 16_000;

export interface HttpApiDeps {
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  runAgent: (
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    onOutput?: (output: ContainerOutput) => Promise<void>,
    opts?: { singleQuery?: boolean },
  ) => Promise<'success' | 'error'>;
}

/** Read the full request body (capped at MAX_BODY_BYTES). */
async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

export function startHttpApi(deps: HttpApiDeps): void {
  let activeRequest = false;

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      // CORS pre-flight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }

      // Health check
      if (req.method === 'GET' && req.url === '/health') {
        json(res, 200, { ok: true, busy: activeRequest });
        return;
      }

      if (req.method !== 'POST' || req.url !== '/ask') {
        json(res, 404, { error: 'Not found. Use POST /ask' });
        return;
      }

      // Prevent concurrent requests (one Siri call at a time)
      if (activeRequest) {
        json(res, 429, {
          error: 'Jarvis is already thinking. Try again in a moment.',
        });
        return;
      }

      // --- Parse body ---
      let text: string;
      try {
        const raw = await readBody(req);
        const parsed = JSON.parse(raw) as { text?: unknown };
        if (typeof parsed.text !== 'string' || !parsed.text.trim()) {
          throw new Error('Missing text');
        }
        text = parsed.text.trim();
      } catch (err: unknown) {
        json(res, 400, {
          error: `Bad request: ${err instanceof Error ? err.message : 'invalid JSON'}`,
        });
        return;
      }

      // --- Find main group ---
      const groups = deps.getRegisteredGroups();
      const mainEntry = Object.entries(groups).find(([, g]) => g.isMain);
      if (!mainEntry) {
        json(res, 503, { error: 'No main group registered in NanoClaw' });
        return;
      }
      const [, group] = mainEntry;

      // Use a synthetic JID so the queue doesn't conflict with the real
      // Telegram group. Each HTTP request gets its own unique JID.
      const httpJid = `http:siri-${Date.now()}`;

      // --- Build prompt directly (NO DB storage — avoids message-loop race) ---
      const timestamp = new Date().toISOString();
      const prompt = formatMessages([
        {
          id: `http-${Date.now()}`,
          chat_jid: httpJid,
          sender: 'http-api',
          sender_name: 'Magico (Siri)',
          content: text,
          timestamp,
          is_from_me: false,
        },
      ]);

      logger.info({ text: text.slice(0, 80) }, 'HTTP API request received');
      activeRequest = true;

      // --- Run the agent and collect streamed output ---
      const parts: string[] = [];
      try {
        const status = await deps.runAgent(
          group,
          prompt,
          httpJid,
          async (output: ContainerOutput) => {
            if (output.result) {
              const raw =
                typeof output.result === 'string'
                  ? output.result
                  : JSON.stringify(output.result);
              const cleaned = stripInternalTags(raw);
              if (cleaned) parts.push(cleaned);
            }
          },
          { singleQuery: true },
        );

        if (status === 'error' && parts.length === 0) {
          json(res, 500, { error: 'Agent returned an error with no output.' });
          return;
        }
      } catch (err: unknown) {
        logger.error({ err }, 'HTTP API agent error');
        json(res, 500, {
          error: `Agent error: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      } finally {
        activeRequest = false;
      }

      const response = parts.join('\n\n') || '(nessuna risposta)';
      logger.info(
        { responseLength: response.length },
        'HTTP API response ready',
      );
      json(res, 200, { response, ok: true });
    },
  );

  server.listen(HTTP_API_PORT, '0.0.0.0', () => {
    logger.info(
      { port: HTTP_API_PORT },
      `HTTP API server listening — iPhone Shortcut: POST http://${MAC_IP}:${HTTP_API_PORT}/ask`,
    );
  });
}
