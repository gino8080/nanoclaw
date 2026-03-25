/**
 * LLM-powered summarization for memory search results.
 * Uses Anthropic API directly (no SDK dependency) to summarize
 * FTS search results before returning them to the agent.
 */
import { request as httpsRequest } from 'https';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const SUMMARY_MODEL = 'claude-haiku-4-5-20251001';
const MAX_INPUT_CHARS = 4000;
const MAX_SUMMARY_TOKENS = 300;

/** Minimum results to trigger summarization (below this, raw is fine) */
const MIN_RESULTS_FOR_SUMMARY = 5;

interface SummaryResult {
  summary: string | null;
}

function getApiKey(): string | null {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY || null;
}

function callAnthropic(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: SUMMARY_MODEL,
      max_tokens: MAX_SUMMARY_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const req = httpsRequest(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Anthropic API ${res.statusCode}: ${data}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const text = parsed.content?.[0]?.text || '';
            resolve(text);
          } catch (e) {
            reject(new Error(`Failed to parse API response: ${data}`));
          }
        });
      },
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Summarize search results using a lightweight LLM.
 * Returns null if summarization is not needed or fails (graceful degradation).
 */
export async function summarizeSearchResults(
  query: string,
  results: unknown[],
): Promise<SummaryResult> {
  if (results.length < MIN_RESULTS_FOR_SUMMARY) {
    return { summary: null };
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    logger.debug('No API key available for summarization, skipping');
    return { summary: null };
  }

  try {
    const truncated = JSON.stringify(results).slice(0, MAX_INPUT_CHARS);

    const systemPrompt =
      'You summarize search results concisely. Output a brief, ' +
      'contextualized summary (2-4 sentences) that answers the query. ' +
      'Focus on the most relevant facts. Use the same language as the query.';

    const userMessage = `Query: "${query}"\n\nSearch results:\n${truncated}`;

    const summary = await callAnthropic(apiKey, systemPrompt, userMessage);
    return { summary: summary || null };
  } catch (err) {
    logger.warn({ err, query }, 'Memory summarization failed, returning raw');
    return { summary: null };
  }
}
