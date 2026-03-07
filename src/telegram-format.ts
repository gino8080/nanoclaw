/**
 * Converts generic Markdown (as produced by Claude) to Telegram-compatible HTML.
 *
 * Supported conversions:
 *   ```code```  → <pre>code</pre>
 *   `code`      → <code>code</code>
 *   **bold**    → <b>bold</b>
 *   *bold*      → <b>bold</b>
 *   ~~strike~~  → <s>strike</s>
 *   _italic_    → <i>italic</i>
 *   [t](url)    → <a href="url">t</a>
 *
 * All other text is HTML-escaped so Telegram renders it safely.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function markdownToTelegramHtml(text: string): string {
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // 1. Extract fenced code blocks (preserve content, strip lang hint)
  let result = text.replace(/```(?:\w*\n)?([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(escapeHtml(code.trimEnd()));
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // 2. Extract inline code
  result = result.replace(/`([^`\n]+)`/g, (_, code) => {
    inlineCodes.push(escapeHtml(code));
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // 3. Escape HTML in remaining text
  result = escapeHtml(result);

  // 4. Markdown → HTML conversions (order matters)

  // Bold: **text** first (greedy asterisks)
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // Bold: *text* (not mid-word, not bullet-like)
  result = result.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '<b>$1</b>');

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Italic: _text_ (not mid-word like snake_case)
  result = result.replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, '<i>$1</i>');

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 5. Restore placeholders
  result = result.replace(
    /\x00CB(\d+)\x00/g,
    (_, i) => `<pre>${codeBlocks[+i]}</pre>`,
  );
  result = result.replace(
    /\x00IC(\d+)\x00/g,
    (_, i) => `<code>${inlineCodes[+i]}</code>`,
  );

  return result;
}
