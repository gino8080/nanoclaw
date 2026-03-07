import { describe, it, expect } from 'vitest';

import { markdownToTelegramHtml } from './telegram-format.js';

describe('markdownToTelegramHtml', () => {
  it('escapes HTML entities in plain text', () => {
    expect(markdownToTelegramHtml('a & b < c > d')).toBe(
      'a &amp; b &lt; c &gt; d',
    );
  });

  it('converts **bold** to <b>', () => {
    expect(markdownToTelegramHtml('hello **world**')).toBe(
      'hello <b>world</b>',
    );
  });

  it('converts *bold* to <b>', () => {
    expect(markdownToTelegramHtml('*Spesa*')).toBe('<b>Spesa</b>');
  });

  it('converts ~~strikethrough~~ to <s>', () => {
    expect(markdownToTelegramHtml('~~Pane~~')).toBe('<s>Pane</s>');
  });

  it('converts _italic_ to <i>', () => {
    expect(markdownToTelegramHtml('_hello_')).toBe('<i>hello</i>');
  });

  it('does not convert snake_case to italic', () => {
    expect(markdownToTelegramHtml('my_variable_name')).toBe('my_variable_name');
  });

  it('converts inline `code`', () => {
    expect(markdownToTelegramHtml('run `npm install`')).toBe(
      'run <code>npm install</code>',
    );
  });

  it('converts fenced code blocks', () => {
    expect(markdownToTelegramHtml('```\nconsole.log("hi")\n```')).toBe(
      '<pre>console.log("hi")</pre>',
    );
  });

  it('strips language hint from code blocks', () => {
    expect(markdownToTelegramHtml('```js\nconst x = 1\n```')).toBe(
      '<pre>const x = 1</pre>',
    );
  });

  it('converts [text](url) to <a>', () => {
    expect(markdownToTelegramHtml('[Google](https://google.com)')).toBe(
      '<a href="https://google.com">Google</a>',
    );
  });

  it('handles the shopping list example correctly', () => {
    const input = `*🛒 Spesa*
• ~~Pane~~ ✅
• Latte

*📦 Acquisti generici*
• Batterie (Amazon)`;

    const result = markdownToTelegramHtml(input);
    expect(result).toContain('<b>🛒 Spesa</b>');
    expect(result).toContain('<s>Pane</s>');
    expect(result).toContain('<b>📦 Acquisti generici</b>');
    expect(result).toContain('• Latte');
    expect(result).toContain('• Batterie (Amazon)');
  });

  it('preserves HTML inside code blocks (escaped)', () => {
    expect(markdownToTelegramHtml('`<div>`')).toBe('<code>&lt;div&gt;</code>');
  });

  it('does not apply formatting inside code blocks', () => {
    expect(markdownToTelegramHtml('```\n*not bold*\n```')).toBe(
      '<pre>*not bold*</pre>',
    );
  });

  it('handles mixed formatting', () => {
    const input = '**bold** and _italic_ and ~~strike~~';
    const result = markdownToTelegramHtml(input);
    expect(result).toBe('<b>bold</b> and <i>italic</i> and <s>strike</s>');
  });
});
