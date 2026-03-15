---
name: json-canvas
description: Create and edit Obsidian .canvas files (JSON Canvas visual format)
---

# JSON Canvas

The vault is mounted at `/workspace/extra/vault/`. Canvas files use the `.canvas` extension and contain JSON.

## File Structure

A `.canvas` file is a JSON object with two arrays:

```json
{
  "nodes": [],
  "edges": []
}
```

## Node Types

### Text Node

Inline markdown content:

```json
{
  "id": "node-1",
  "type": "text",
  "x": 0,
  "y": 0,
  "width": 400,
  "height": 200,
  "text": "# Title\n\nMarkdown content here.",
  "color": "1"
}
```

### File Node

Reference to a file in the vault:

```json
{
  "id": "node-2",
  "type": "file",
  "x": 500,
  "y": 0,
  "width": 400,
  "height": 400,
  "file": "path/to/note.md",
  "color": "2"
}
```

- `file` is relative to the vault root.
- Can reference `.md`, `.png`, `.pdf`, or any file in the vault.

### Link Node

External URL:

```json
{
  "id": "node-3",
  "type": "link",
  "x": 1000,
  "y": 0,
  "width": 400,
  "height": 300,
  "url": "https://example.com",
  "color": "3"
}
```

### Group Node

Visual container that groups other nodes:

```json
{
  "id": "group-1",
  "type": "group",
  "x": -50,
  "y": -50,
  "width": 950,
  "height": 500,
  "label": "Phase 1",
  "color": "4"
}
```

- Groups do not enforce containment. They are purely visual.
- Set position and size to encompass the nodes you want grouped.

## Node Properties

| Property | Type | Required | Notes |
|----------|------|----------|-------|
| `id` | string | yes | Unique within the canvas |
| `type` | string | yes | `text`, `file`, `link`, `group` |
| `x` | number | yes | Horizontal position (pixels) |
| `y` | number | yes | Vertical position (pixels) |
| `width` | number | yes | Node width (min ~100) |
| `height` | number | yes | Node height (min ~60) |
| `text` | string | text only | Markdown content |
| `file` | string | file only | Vault-relative path |
| `url` | string | link only | External URL |
| `label` | string | group only | Group label |
| `color` | string | no | Preset `"1"`-`"6"` or hex `"#FF0000"` |

## Colors

Preset color codes map to Obsidian's theme palette:

| Code | Meaning (default theme) |
|------|------------------------|
| `"1"` | Red |
| `"2"` | Orange |
| `"3"` | Yellow |
| `"4"` | Green |
| `"5"` | Cyan |
| `"6"` | Purple |

Or use a hex string: `"#1a1a2e"`. Omit `color` for the default node color.

## Edges

Connect two nodes:

```json
{
  "id": "edge-1",
  "fromNode": "node-1",
  "toNode": "node-2",
  "fromSide": "right",
  "toSide": "left",
  "color": "5",
  "label": "leads to"
}
```

## Edge Properties

| Property | Type | Required | Notes |
|----------|------|----------|-------|
| `id` | string | yes | Unique within the canvas |
| `fromNode` | string | yes | Source node id |
| `toNode` | string | yes | Target node id |
| `fromSide` | string | no | `"top"`, `"bottom"`, `"left"`, `"right"` |
| `toSide` | string | no | `"top"`, `"bottom"`, `"left"`, `"right"` |
| `color` | string | no | Same as node colors |
| `label` | string | no | Text label on the edge |

- If `fromSide`/`toSide` are omitted, Obsidian picks the shortest path.

## Complete Example: Simple Flowchart

```json
{
  "nodes": [
    {
      "id": "start",
      "type": "text",
      "x": 0,
      "y": 0,
      "width": 300,
      "height": 100,
      "text": "# Start\n\nInitial step.",
      "color": "4"
    },
    {
      "id": "process",
      "type": "text",
      "x": 450,
      "y": 0,
      "width": 300,
      "height": 100,
      "text": "# Process\n\nDo the work.",
      "color": "3"
    },
    {
      "id": "end",
      "type": "text",
      "x": 900,
      "y": 0,
      "width": 300,
      "height": 100,
      "text": "# Done\n\nComplete.",
      "color": "1"
    }
  ],
  "edges": [
    {
      "id": "e1",
      "fromNode": "start",
      "toNode": "process",
      "fromSide": "right",
      "toSide": "left",
      "label": "begin"
    },
    {
      "id": "e2",
      "fromNode": "process",
      "toNode": "end",
      "fromSide": "right",
      "toSide": "left",
      "label": "finish"
    }
  ]
}
```

## Guidelines

- Generate unique IDs. Use descriptive slugs (`intro`, `step-2`, `conclusion`) or UUIDs.
- Space nodes so they do not overlap. A horizontal gap of ~150px and vertical gap of ~100px works well.
- Save the `.canvas` file in the vault folder most relevant to its content.
- Keep text node content concise. Link to full notes with file nodes instead of duplicating content.
- Write the JSON with `JSON.stringify(data, null, 2)` or equivalent for readable output.
