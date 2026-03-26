/**
 * Generic OpenRouter API wrapper.
 * Uses OpenAI-compatible chat completions format.
 */
import { request as httpsRequest } from 'https';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const DEFAULT_TIMEOUT_MS = 10000;

export interface OpenRouterOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function getOpenRouterKey(): string | null {
  const secrets = readEnvFile(['OPENROUTER_API_KEY']);
  return secrets.OPENROUTER_API_KEY || null;
}

/**
 * Call OpenRouter chat completions API.
 * Returns the assistant's text response, or throws on error.
 */
export function chatCompletion(
  apiKey: string,
  messages: ChatMessage[],
  options: OpenRouterOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: options.model,
      max_tokens: options.maxTokens ?? 300,
      ...(options.temperature !== undefined && {
        temperature: options.temperature,
      }),
      messages,
    });

    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const req = httpsRequest(
      {
        hostname: 'openrouter.ai',
        path: '/api/v1/chat/completions',
        method: 'POST',
        timeout,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`OpenRouter API ${res.statusCode}: ${data}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const text = parsed.choices?.[0]?.message?.content || '';
            resolve(text);
          } catch (e) {
            reject(new Error(`Failed to parse OpenRouter response: ${data}`));
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`OpenRouter API timeout (${timeout}ms)`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
