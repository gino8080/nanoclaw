/**
 * OAuth token management for NanoClaw.
 *
 * Two flows:
 * 1. Refresh: uses the refresh token from keychain (fast, no user interaction)
 * 2. Full OAuth: generates authorize URL, user opens in browser, callback captures code
 *
 * The service reads tokens from a local cache file, never from keychain directly.
 * Keychain is only accessed by the /login command (user-initiated).
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { logger } from './logger.js';

const TOKEN_CACHE_PATH = path.join(
  os.homedir(),
  '.config',
  'nanoclaw',
  'oauth-token.json',
);

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_ACCOUNT = process.env.USER || 'magico';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_SCOPES = [
  'user:inference',
  'user:profile',
  'user:sessions:claude_code',
].join(' ');

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface KeychainData {
  claudeAiOauth: OAuthCredentials & { scopes?: string[] };
  [key: string]: unknown;
}

// Pending OAuth flow state
let pendingOAuth: {
  codeVerifier: string;
  state: string;
  chatJid: string;
  resolve: (result: { success: boolean; message: string }) => void;
  timeout: ReturnType<typeof setTimeout>;
} | null = null;

// ── Cache file operations ──

export function getCachedToken(): string | null {
  try {
    if (!fs.existsSync(TOKEN_CACHE_PATH)) return null;
    const data: TokenCache = JSON.parse(
      fs.readFileSync(TOKEN_CACHE_PATH, 'utf-8'),
    );
    if (data.expiresAt <= Date.now()) {
      logger.warn('Cached OAuth token expired');
      return null;
    }
    return data.accessToken;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to read token cache',
    );
    return null;
  }
}

function writeTokenCache(token: string, expiresAt: number): void {
  const dir = path.dirname(TOKEN_CACHE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const data: TokenCache = { accessToken: token, expiresAt };
  fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(data), { mode: 0o600 });
}

// ── Keychain operations ──

function readKeychain(): KeychainData | null {
  try {
    const raw = execSync(
      `security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" -w`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeKeychain(data: KeychainData): boolean {
  try {
    const json = JSON.stringify(data);
    try {
      execSync(
        `security delete-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}"`,
        { stdio: 'pipe', timeout: 5000 },
      );
    } catch {
      // OK if not found
    }
    execSync(
      `security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" -w "${json.replace(/"/g, '\\"')}"`,
      { stdio: 'pipe', timeout: 5000 },
    );
    return true;
  } catch (err) {
    logger.error({ err }, 'Failed to write keychain');
    return false;
  }
}

// ── OAuth API calls ──

async function refreshOAuthToken(
  refreshToken: string,
): Promise<OAuthCredentials | null> {
  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error(
        { status: res.status, body: text.slice(0, 200) },
        'OAuth refresh failed',
      );
      return null;
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  } catch (err) {
    logger.error({ err }, 'OAuth refresh request failed');
    return null;
  }
}

async function exchangeCodeForToken(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<OAuthCredentials | null> {
  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: OAUTH_CLIENT_ID,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error(
        { status: res.status, body: text.slice(0, 200) },
        'OAuth code exchange failed',
      );
      return null;
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  } catch (err) {
    logger.error({ err }, 'OAuth code exchange failed');
    return null;
  }
}

// ── PKCE helpers ──

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ── Token expiry check ──

export function isTokenExpiringSoon(bufferMs = 10 * 60 * 1000): boolean {
  try {
    if (!fs.existsSync(TOKEN_CACHE_PATH)) return true;
    const data: TokenCache = JSON.parse(
      fs.readFileSync(TOKEN_CACHE_PATH, 'utf-8'),
    );
    return data.expiresAt <= Date.now() + bufferMs;
  } catch {
    return true;
  }
}

// ── Public API ──

/**
 * Try to refresh the token using the keychain's refresh token.
 * If the token is still valid, just update the cache.
 * Returns result with success/failure message.
 */
export async function refreshAndCacheToken(): Promise<{
  success: boolean;
  message: string;
}> {
  const keychainData = readKeychain();
  if (!keychainData?.claudeAiOauth) {
    return {
      success: false,
      message:
        'Nessuna credenziale nel keychain. Usa il link di login qui sotto.',
    };
  }

  const oauth = keychainData.claudeAiOauth;
  const bufferMs = 5 * 60 * 1000;

  // Token still valid — just update cache
  if (oauth.expiresAt > Date.now() + bufferMs) {
    writeTokenCache(oauth.accessToken, oauth.expiresAt);
    const minutes = Math.round((oauth.expiresAt - Date.now()) / 1000 / 60);
    return {
      success: true,
      message: `Token valido (scade tra ${minutes} min). Cache aggiornata.`,
    };
  }

  // Refresh using refresh token
  logger.info('Refreshing OAuth token...');
  const refreshed = await refreshOAuthToken(oauth.refreshToken);
  if (!refreshed) {
    return {
      success: false,
      message: 'Refresh token scaduto.',
    };
  }

  // Update keychain + cache
  keychainData.claudeAiOauth = {
    ...oauth,
    ...refreshed,
  };
  writeKeychain(keychainData);
  writeTokenCache(refreshed.accessToken, refreshed.expiresAt);

  const minutes = Math.round((refreshed.expiresAt - Date.now()) / 1000 / 60);
  logger.info({ expiresInMinutes: minutes }, 'OAuth token refreshed');

  return {
    success: true,
    message: `Token refreshato. Valido per ${minutes} min.`,
  };
}

/**
 * Start a full OAuth authorization flow.
 * Returns the authorization URL the user must open.
 */
export function startOAuthFlow(
  publicBaseUrl: string,
  chatJid: string,
): {
  authorizeUrl: string;
  promise: Promise<{ success: boolean; message: string }>;
} {
  // Cancel any pending flow
  if (pendingOAuth) {
    clearTimeout(pendingOAuth.timeout);
    pendingOAuth.resolve({
      success: false,
      message: 'Flusso annullato (nuovo /login avviato).',
    });
    pendingOAuth = null;
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${publicBaseUrl}/oauth/callback`;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const authorizeUrl = `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;

  const promise = new Promise<{ success: boolean; message: string }>(
    (resolve) => {
      const timeout = setTimeout(
        () => {
          pendingOAuth = null;
          resolve({
            success: false,
            message: 'Login scaduto (5 min). Riprova con /login.',
          });
        },
        5 * 60 * 1000,
      );

      pendingOAuth = { codeVerifier, state, chatJid, resolve, timeout };
    },
  );

  return { authorizeUrl, promise };
}

/**
 * Handle the OAuth callback from the browser redirect.
 * Called by the HTTP server when it receives GET /oauth/callback.
 * Returns HTML to show in the browser.
 */
export async function handleOAuthCallback(
  code: string,
  state: string,
  publicBaseUrl: string,
): Promise<{ html: string; chatJid: string | null }> {
  if (!pendingOAuth || pendingOAuth.state !== state) {
    return {
      html: errorPage(
        'Login non valido o scaduto. Riprova /login su Telegram.',
      ),
      chatJid: null,
    };
  }

  const { codeVerifier, chatJid, resolve, timeout } = pendingOAuth;
  pendingOAuth = null;
  clearTimeout(timeout);

  const redirectUri = `${publicBaseUrl}/oauth/callback`;
  const credentials = await exchangeCodeForToken(
    code,
    codeVerifier,
    redirectUri,
  );

  if (!credentials) {
    resolve({
      success: false,
      message: 'Scambio codice fallito. Riprova /login.',
    });
    return {
      html: errorPage(
        'Errore nello scambio del codice. Riprova /login su Telegram.',
      ),
      chatJid,
    };
  }

  // Save to cache
  writeTokenCache(credentials.accessToken, credentials.expiresAt);

  // Update keychain
  const keychainData = readKeychain() || {
    claudeAiOauth: {
      accessToken: '',
      refreshToken: '',
      expiresAt: 0,
      scopes: OAUTH_SCOPES.split(' '),
    },
  };
  keychainData.claudeAiOauth = {
    ...keychainData.claudeAiOauth,
    ...credentials,
    scopes: OAUTH_SCOPES.split(' '),
  };
  writeKeychain(keychainData);

  const minutes = Math.round((credentials.expiresAt - Date.now()) / 1000 / 60);
  resolve({
    success: true,
    message: `Login completato! Token valido per ${minutes} min.`,
  });

  return {
    html: successPage(minutes),
    chatJid,
  };
}

function successPage(minutes: number): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>NanoClaw Login</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f0fdf4}
.card{background:white;padding:2rem;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,.1);text-align:center;max-width:400px}
h1{color:#16a34a;font-size:1.5rem}p{color:#555}</style></head>
<body><div class="card"><h1>✅ Login completato</h1><p>Token valido per ${minutes} minuti.<br>Puoi chiudere questa pagina.</p></div></body></html>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>NanoClaw Login</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#fef2f2}
.card{background:white;padding:2rem;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,.1);text-align:center;max-width:400px}
h1{color:#dc2626;font-size:1.5rem}p{color:#555}</style></head>
<body><div class="card"><h1>❌ Errore</h1><p>${message}</p></div></body></html>`;
}
