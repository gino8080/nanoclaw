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
 * - We do NOT await runAgent() to completion because the container stays alive
 *   in persistent mode. Instead we resolve as soon as the agent emits a
 *   status:"success" output marker (meaning the query is done).
 */

import fs from 'fs';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { marked } from 'marked';
import path from 'path';

import { ContainerOutput } from './container-runner.js';
import { logger } from './logger.js';
import { formatMessages, stripInternalTags } from './router.js';
import { RegisteredGroup } from './types.js';

const MAC_IP = process.env.MAC_IP ?? '192.168.10.130';
const HTTP_API_PORT = parseInt(process.env.HTTP_API_PORT ?? '3399', 10);
const MAX_BODY_BYTES = 16_000;
const API_TOKEN = process.env.HTTP_API_TOKEN ?? '';
/** Max seconds to wait for the agent to respond before giving up. */
const RESPONSE_TIMEOUT_MS = 120_000;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};

const STATIC_ROOT =
  process.env.STATIC_FILES_DIR ??
  '/Users/magico/PROJECTS/PERSONAL/NANO_CLAW_DATA';

/**
 * Serve a static file from NANO_CLAW_DATA.
 * URL format: /files/subdir/filename.ext
 * Returns true if handled (even for errors), false if URL doesn't match.
 */
function serveStaticFile(res: ServerResponse, urlPath: string): boolean {
  // /files/ prefix already stripped by caller — urlPath is the rest
  const filePath = urlPath.replace(/^\/files\//, '');
  if (!filePath) return false;

  const resolved = path.resolve(STATIC_ROOT, filePath);

  // Path traversal protection
  const relative = path.relative(STATIC_ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    json(res, 403, { error: 'Forbidden' });
    return true;
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    json(res, 404, { error: 'File not found' });
    return true;
  }

  const ext = path.extname(resolved).toLowerCase();

  // Render markdown files as HTML
  if (ext === '.md') {
    const raw = fs.readFileSync(resolved, 'utf8');
    const rendered = marked(raw) as string;
    const fileName = path.basename(resolved);
    const mdFilePath = urlPath.replace(/^\/files\/?/, '');
    const mdSection = mdFilePath.split('/')[0] || '';
    const nav = buildNavHeader(mdSection);
    const html = `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fileName}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 20px; max-width: 800px; margin: 0 auto; line-height: 1.6; }
  ${NAV_STYLES}
  h1, h2, h3, h4 { color: #f0f0f0; margin: 1.2em 0 0.5em; }
  h1 { font-size: 1.6em; border-bottom: 1px solid #222; padding-bottom: 8px; }
  h2 { font-size: 1.3em; }
  h3 { font-size: 1.1em; }
  p { margin: 0.6em 0; }
  a { color: #6ba3f7; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { background: #1a1a1a; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  pre { background: #1a1a1a; padding: 14px; border-radius: 6px; overflow-x: auto; margin: 1em 0; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #333; padding-left: 12px; color: #999; margin: 1em 0; }
  ul, ol { padding-left: 1.5em; margin: 0.6em 0; }
  li { margin: 0.3em 0; }
  table { width: 100%; border-collapse: collapse; margin: 1em 0; }
  th, td { padding: 8px 12px; border: 1px solid #222; text-align: left; }
  th { background: #111; color: #aaa; font-weight: 500; }
  img { max-width: 100%; border-radius: 6px; }
  hr { border: none; border-top: 1px solid #222; margin: 1.5em 0; }
</style>
</head>
<body>
${nav}
<article>${rendered}</article>
</body>
</html>`;
    const content = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': content.length,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(content);
    return true;
  }

  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  const content = fs.readFileSync(resolved);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': content.length,
    'Access-Control-Allow-Origin': '*',
    'Content-Security-Policy':
      "default-src 'self' 'unsafe-inline' https: data:; script-src 'self' 'unsafe-inline' https://maps.googleapis.com https://maps.gstatic.com https://unpkg.com https://cdn.jsdelivr.net; frame-src https://www.google.com https://maps.google.com",
  });
  res.end(content);
  return true;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

const SECTION_ICONS: Record<string, string> = {
  images: '🖼️',
  pages: '📄',
  ricerche: '🔬',
  report_giornalieri: '📊',
  lists: '📋',
  note: '📝',
};

/** Build the top nav bar with links to all root-level sections. */
function buildNavHeader(activeSection: string): string {
  let sections: string[];
  try {
    sections = fs
      .readdirSync(STATIC_ROOT)
      .filter(
        (n) =>
          !n.startsWith('.') &&
          fs.statSync(path.join(STATIC_ROOT, n)).isDirectory(),
      )
      .sort();
  } catch {
    sections = [];
  }

  const links = sections
    .map((name) => {
      const icon = SECTION_ICONS[name] || '📁';
      const isActive = name === activeSection;
      const cls = isActive ? ' class="active"' : '';
      return `<a href="/files/${name}/"${cls}>${icon} ${name}</a>`;
    })
    .join('');

  return `<nav><a href="/files/" class="${!activeSection ? 'active' : ''}">🏠 home</a>${links}</nav>`;
}

const NAV_STYLES = `
  nav { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 20px; padding-bottom: 12px; border-bottom: 1px solid #1a1a1a; }
  nav a { padding: 6px 12px; border-radius: 6px; background: #141414; color: #999; font-size: 0.85em; text-decoration: none; transition: background 0.15s; }
  nav a:hover { background: #1e1e1e; color: #e0e0e0; }
  nav a.active { background: #1a2a3a; color: #6ba3f7; }
`;

/**
 * Serve an interactive HTML directory listing for NANO_CLAW_DATA.
 * Image-heavy directories get a grid view; others get a table.
 */
function serveDirectoryListing(res: ServerResponse, urlPath: string): boolean {
  const dirPath = urlPath.replace(/^\/files\/?/, '').replace(/\/+$/, '');
  const resolved = path.resolve(STATIC_ROOT, dirPath);

  // Path traversal protection
  const relative = path.relative(STATIC_ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    json(res, 403, { error: 'Forbidden' });
    return true;
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return false;
  }

  // Collect entries
  interface DirEntry {
    name: string;
    isDir: boolean;
    size: number;
    modified: Date;
    ext: string;
    entryPath: string;
  }
  const entries: DirEntry[] = [];
  for (const name of fs.readdirSync(resolved).sort()) {
    if (name.startsWith('.')) continue;
    const fullPath = path.join(resolved, name);
    const stat = fs.statSync(fullPath);
    entries.push({
      name,
      isDir: stat.isDirectory(),
      size: stat.size,
      modified: stat.mtime,
      ext: path.extname(name).toLowerCase(),
      entryPath: dirPath ? `${dirPath}/${name}` : name,
    });
  }

  const activeSection = dirPath.split('/')[0] || '';
  const nav = buildNavHeader(activeSection);
  const displayPath = dirPath ? `/${dirPath}` : '/';

  // Detect image-heavy directory
  const files = entries.filter((e) => !e.isDir);
  const imageFiles = files.filter((e) => IMAGE_EXTS.has(e.ext));
  const isImageDir = files.length > 0 && imageFiles.length / files.length > 0.5;

  let body: string;

  if (isImageDir) {
    // Grid view for images
    const parentLink = dirPath
      ? `<a href="${dirPath.includes('/') ? `/files/${dirPath.substring(0, dirPath.lastIndexOf('/'))}/` : '/files/'}" class="back-link">← indietro</a>`
      : '';

    const cards = entries
      .map((e) => {
        if (e.isDir) {
          return `<a href="/files/${e.entryPath}/" class="card card-dir"><div class="card-icon">📁</div><div class="card-name">${e.name}/</div></a>`;
        }
        if (IMAGE_EXTS.has(e.ext)) {
          return `<a href="/files/${e.entryPath}" class="card card-img"><img src="/files/${e.entryPath}" alt="${e.name}" loading="lazy"><div class="card-name">${e.name}</div></a>`;
        }
        return `<a href="/files/${e.entryPath}" class="card card-file"><div class="card-icon">📄</div><div class="card-name">${e.name}</div></a>`;
      })
      .join('\n');

    body = `${parentLink}<div class="grid">${cards}</div>`;
  } else {
    // Table view
    const rows: string[] = [];
    if (dirPath) {
      const parent = dirPath.includes('/')
        ? `/files/${dirPath.substring(0, dirPath.lastIndexOf('/'))}/`
        : '/files/';
      rows.push(
        `<tr><td>📁</td><td><a href="${parent}">..</a></td><td></td><td></td></tr>`,
      );
    }
    for (const e of entries) {
      if (e.isDir) {
        rows.push(
          `<tr><td>📁</td><td><a href="/files/${e.entryPath}/">${e.name}/</a></td><td>—</td><td>—</td></tr>`,
        );
      } else {
        const modified = e.modified.toLocaleDateString('it-IT', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        rows.push(
          `<tr><td>📄</td><td><a href="/files/${e.entryPath}">${e.name}</a></td><td>${formatFileSize(e.size)}</td><td>${modified}</td></tr>`,
        );
      }
    }
    body = `<table>
<thead><tr><th></th><th>Nome</th><th>Dim.</th><th>Modificato</th></tr></thead>
<tbody>${rows.join('\n')}</tbody>
</table>`;
  }

  const html = `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Files — ${displayPath}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 20px; }
  ${NAV_STYLES}
  h1 { font-size: 1.2em; color: #888; margin-bottom: 16px; font-weight: 400; }
  h1 span { color: #e0e0e0; }
  a { color: #6ba3f7; text-decoration: none; }
  a:hover { text-decoration: underline; }
  /* Table view */
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: #666; font-weight: 500; font-size: 0.85em; text-transform: uppercase; padding: 8px 12px; border-bottom: 1px solid #222; }
  td { padding: 10px 12px; border-bottom: 1px solid #1a1a1a; }
  tr:hover { background: #111; }
  td:first-child { width: 30px; text-align: center; }
  td:nth-child(3), td:nth-child(4), th:nth-child(3), th:nth-child(4) { color: #666; font-size: 0.9em; }
  @media (max-width: 600px) { td:nth-child(4), th:nth-child(4) { display: none; } }
  /* Grid view */
  .back-link { display: inline-block; margin-bottom: 12px; color: #666; font-size: 0.9em; }
  .back-link:hover { color: #6ba3f7; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
  .card { display: flex; flex-direction: column; background: #111; border-radius: 8px; overflow: hidden; text-decoration: none !important; transition: transform 0.15s, background 0.15s; }
  .card:hover { transform: translateY(-2px); background: #1a1a1a; }
  .card-img img { width: 100%; aspect-ratio: 1; object-fit: cover; }
  .card-dir, .card-file { aspect-ratio: 1; align-items: center; justify-content: center; }
  .card-icon { font-size: 2.5em; }
  .card-name { padding: 8px; font-size: 0.8em; color: #aaa; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 600px) { .grid { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; } }
</style>
</head>
<body>
${nav}
<h1>📂 <span>${displayPath}</span></h1>
${body}
</body>
</html>`;

  const content = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': content.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(content);
  return true;
}

export interface HttpApiDeps {
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  runAgent: (
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    onOutput?: (output: ContainerOutput) => Promise<void>,
    opts?: { singleQuery?: boolean },
  ) => Promise<'success' | 'error'>;
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendPoolMessage: (
    chatId: string,
    text: string,
    sender: string,
    groupFolder: string,
  ) => Promise<void>;
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
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
      }

      // Health check
      if (req.method === 'GET' && req.url === '/health') {
        json(res, 200, { ok: true, busy: activeRequest });
        return;
      }

      // Static file serving & directory listing: GET /files/...
      if (req.method === 'GET' && req.url?.startsWith('/files')) {
        const urlPath = decodeURIComponent(req.url.split('?')[0]);
        // Try directory listing first (for paths ending with / or exact /files)
        if (serveDirectoryListing(res, urlPath)) return;
        // Then try serving as file
        if (serveStaticFile(res, urlPath)) return;
        json(res, 404, { error: 'File not found' });
        return;
      }

      // Bearer token auth (required when HTTP_API_TOKEN is set)
      if (API_TOKEN) {
        const auth = req.headers['authorization'];
        if (auth !== `Bearer ${API_TOKEN}`) {
          json(res, 401, { error: 'Unauthorized' });
          return;
        }
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
      const [mainJid, group] = mainEntry;

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

      // -------------------------------------------------------------------
      // Run the agent but DON'T await it to completion.
      // The container stays alive in persistent mode; runAgent only resolves
      // when the container exits (which may take 30+ minutes).
      // Instead we race: resolve as soon as the onOutput callback receives
      // a status:"success" marker, or timeout after RESPONSE_TIMEOUT_MS.
      // -------------------------------------------------------------------
      const parts: string[] = [];

      // This promise resolves when the agent emits its first complete answer.
      const responseReady = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `Agent did not respond within ${RESPONSE_TIMEOUT_MS / 1000}s`,
            ),
          );
        }, RESPONSE_TIMEOUT_MS);

        const onOutput = async (output: ContainerOutput) => {
          // Collect text parts
          if (output.result) {
            const raw =
              typeof output.result === 'string'
                ? output.result
                : JSON.stringify(output.result);
            const cleaned = stripInternalTags(raw);
            if (cleaned) parts.push(cleaned);
          }

          // status:"success" means the query is done — resolve immediately.
          // status:"error" also means done (with failure).
          if (output.status === 'success' || output.status === 'error') {
            clearTimeout(timer);
            if (output.status === 'error' && parts.length === 0) {
              reject(new Error(output.error || 'Agent returned an error'));
            } else {
              resolve();
            }
          }
        };

        // Fire-and-forget: let the container run in the background.
        // We only care about the onOutput callbacks, not when runAgent returns.
        deps
          .runAgent(group, prompt, httpJid, onOutput, { singleQuery: true })
          .catch((err) => {
            clearTimeout(timer);
            reject(err);
          });
      });

      try {
        await responseReady;
      } catch (err: unknown) {
        logger.error({ err }, 'HTTP API agent error');
        json(res, 500, {
          error: `Agent error: ${err instanceof Error ? err.message : String(err)}`,
        });
        activeRequest = false;
        return;
      }

      activeRequest = false;

      const response = parts.join('\n\n') || '(nessuna risposta)';
      logger.info(
        { responseLength: response.length },
        'HTTP API response ready',
      );

      // Mirror the exchange to the AGENTS group chat (not the private main chat).
      // User question goes via a pool bot named "Siri 🎙️";
      // Jarvis response goes via the main bot.
      const agentsGroup = Object.entries(groups).find(
        ([jid, g]) => !g.isMain && jid.startsWith('tg:'),
      );
      if (agentsGroup) {
        const [agentsJid, agentsG] = agentsGroup;
        deps
          .sendPoolMessage(agentsJid, `🗣️ ${text}`, 'Siri 🎙️', agentsG.folder)
          .then(() => deps.sendMessage(agentsJid, response))
          .catch((err) =>
            logger.warn(
              { err },
              'Failed to mirror HTTP API exchange to Telegram',
            ),
          );
      }

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
