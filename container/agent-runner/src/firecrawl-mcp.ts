/**
 * Stdio MCP Server for Firecrawl
 * Scrapes and extracts content from URLs using the Firecrawl API.
 * Useful for bypassing JS-rendered pages and anti-bot protections.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_KEY = process.env.FIRECRAWL_API_KEY!;
const BASE = 'https://api.firecrawl.dev/v1';

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

const server = new McpServer({
  name: 'firecrawl',
  version: '1.0.0',
});

// --- Scrape ---
server.tool(
  'scrape',
  `Scrape a single URL and extract its content as markdown.
Handles JavaScript-rendered pages and bypasses common anti-bot protections.
Use this when agent-browser fails or gets blocked.`,
  {
    url: z.string().url().describe('The URL to scrape'),
    onlyMainContent: z
      .boolean()
      .optional()
      .describe('Extract only the main content, removing navs/footers (default: true)'),
    waitFor: z
      .number()
      .optional()
      .describe('Wait N milliseconds for JS to render before scraping'),
  },
  async ({ url, onlyMainContent, waitFor }) => {
    try {
      const body: Record<string, unknown> = {
        url,
        formats: ['markdown'],
        onlyMainContent: onlyMainContent ?? true,
      };
      if (waitFor != null) {
        body.waitFor = waitFor;
      }

      const res = await fetch(`${BASE}/scrape`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        throw new Error(`Firecrawl API ${res.status}: ${await res.text()}`);
      }

      const result = await res.json();

      // Return just the markdown content + metadata for token efficiency
      const data = result.data;
      return textResult({
        markdown: data?.markdown,
        metadata: data?.metadata,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
