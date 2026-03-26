/**
 * LLM-powered summarization for memory search results.
 * Uses OpenRouter via generic wrapper for cheap, fast summarization.
 */
import { logger } from './logger.js';
import { chatCompletion, getOpenRouterKey } from './openrouter.js';

const SUMMARY_MODEL = 'anthropic/claude-3.5-haiku';
const MAX_INPUT_CHARS = 4000;
const MAX_SUMMARY_TOKENS = 300;
const API_TIMEOUT_MS = 5000;

/** Minimum results to trigger summarization (below this, raw is fine) */
const MIN_RESULTS_FOR_SUMMARY = 5;

interface SummaryResult {
  summary: string | null;
}

/**
 * LLM fallback for lexical gap: when FTS finds few results, pass ALL
 * knowledge entries to the LLM and let it pick the relevant ones.
 * Returns the keys of relevant entries (empty array on failure).
 */
export async function extractRelevantKeys(
  query: string,
  allEntries: { key: string; value: string; category: string }[],
): Promise<string[]> {
  if (allEntries.length === 0) return [];

  const apiKey = getOpenRouterKey();
  if (!apiKey) return [];

  try {
    const entriesText = allEntries
      .map((e) => `${e.key}: ${e.value}`)
      .join('\n');

    const response = await chatCompletion(
      apiKey,
      [
        {
          role: 'system',
          content:
            'You are a memory retrieval system. Given a user query and a list of stored facts, ' +
            'return ONLY the keys of facts that are relevant to the query. ' +
            'Output one key per line, nothing else. If no facts are relevant, output nothing.',
        },
        {
          role: 'user',
          content: `Query: "${query}"\n\nStored facts:\n${entriesText}`,
        },
      ],
      {
        model: SUMMARY_MODEL,
        maxTokens: 200,
        temperature: 0,
        timeoutMs: API_TIMEOUT_MS,
      },
    );

    const validKeys = new Set(allEntries.map((e) => e.key));
    return response
      .split('\n')
      .map((line) => line.trim())
      .filter((key) => validKeys.has(key));
  } catch (err) {
    logger.warn({ err, query }, 'LLM key extraction failed');
    return [];
  }
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

  const apiKey = getOpenRouterKey();
  if (!apiKey) {
    logger.debug('No OPENROUTER_API_KEY available for summarization, skipping');
    return { summary: null };
  }

  try {
    const truncated = JSON.stringify(results).slice(0, MAX_INPUT_CHARS);

    const summary = await chatCompletion(
      apiKey,
      [
        {
          role: 'system',
          content:
            'You summarize search results concisely. Output a brief, ' +
            'contextualized summary (2-4 sentences) that answers the query. ' +
            'Focus on the most relevant facts. Use the same language as the query.',
        },
        {
          role: 'user',
          content: `Query: "${query}"\n\nSearch results:\n${truncated}`,
        },
      ],
      {
        model: SUMMARY_MODEL,
        maxTokens: MAX_SUMMARY_TOKENS,
        timeoutMs: API_TIMEOUT_MS,
      },
    );

    return { summary: summary || null };
  } catch (err) {
    logger.warn({ err, query }, 'Memory summarization failed, returning raw');
    return { summary: null };
  }
}
