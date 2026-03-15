---
name: defuddle
description: Extract clean content from web pages and save as Obsidian markdown notes
---

# Defuddle

Extract the main content from a web page, strip junk (nav, ads, sidebars, scripts), convert to clean markdown, and save to the Obsidian vault at `/workspace/extra/vault/`.

## Workflow

1. **Fetch the page** using `agent-browser` or web fetch.
2. **Extract main content**: strip `<nav>`, `<header>`, `<footer>`, `<aside>`, `<script>`, `<style>`, ad containers, cookie banners, and anything not part of the article body.
3. **Convert to markdown**: headings, lists, links, code blocks, images, tables.
4. **Add frontmatter** with source metadata.
5. **Save** to the vault.

## Content Extraction Rules

Remove these elements completely:
- `<nav>`, `<header>`, `<footer>`, `<aside>`
- `<script>`, `<style>`, `<noscript>`
- Elements with classes/IDs containing: `nav`, `menu`, `sidebar`, `footer`, `header`, `ad`, `advertisement`, `banner`, `cookie`, `popup`, `modal`, `social`, `share`, `comment`, `related`
- Empty containers and decorative elements

Keep these elements:
- `<article>`, `<main>`, or the largest content block
- Headings (`<h1>`-`<h6>`)
- Paragraphs, lists, blockquotes
- Code blocks and inline code
- Tables
- Images with meaningful `alt` text (skip tracking pixels and icons)
- Links (convert to markdown format)

## Output Template

```markdown
---
title: 'Article Title Here'
source: 'https://original-url.com/article'
author: 'Author Name'
date_captured: '2026-03-15'
date_published: '2026-03-10'
tags: [clipping, topic-tag]
---

# Article Title Here

Content converted to clean markdown...

## Section Heading

More content...

---
*Source: [original title](https://original-url.com/article)*
```

## Field Rules

- `title`: from `<title>`, `og:title`, or the first `<h1>`.
- `source`: the exact URL fetched.
- `author`: from `<meta name="author">`, `article:author`, or byline element. Use `'unknown'` if not found.
- `date_captured`: today's date in ISO format.
- `date_published`: from `article:published_time`, `datePublished`, or `<time>` element. Omit if not found.
- `tags`: always include `clipping`, then add 1-3 topic tags based on content.

## Save Location

- Default: `inbox/` folder in the vault.
- If the user specifies a folder, use that instead.
- Filename: slugified title with date prefix, e.g., `2026-03-15-article-title-here.md`.
- If a file with the same name exists, append a counter: `-2`, `-3`.

## Markdown Conversion Details

- Convert `<h1>`-`<h6>` to `#`-`######`.
- Convert `<a href="url">text</a>` to `[text](url)`. Drop tracking parameters (`utm_*`, `ref`, `source`).
- Convert `<img src="url" alt="desc">` to `![desc](url)`. Skip images smaller than 100x100 or with no alt text.
- Convert `<pre><code>` to fenced code blocks with language hint if available.
- Convert `<table>` to markdown tables.
- Convert `<blockquote>` to `>` blockquote syntax.
- Preserve `<strong>`/`<b>` as `**bold**` and `<em>`/`<i>` as `*italic*`.
- Collapse multiple blank lines to a single blank line.
- Strip all remaining HTML tags after conversion.

## Example Usage

When asked to clip a page:

```bash
# Fetch the page
agent-browser open "https://example.com/article"
agent-browser snapshot

# Get the page HTML for processing
agent-browser javascript "document.querySelector('article, main, [role=main]')?.innerHTML || document.body.innerHTML"
```

Then process the HTML, convert to markdown, and write the file to the vault.
