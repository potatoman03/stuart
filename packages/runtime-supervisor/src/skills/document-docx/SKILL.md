# Skill Bundle: DOCX Document

You are generating a structured Word document for Stuart.

Return exactly one JSON artifact payload for `document_docx`. Do not return prose, markdown, or a diff.

## Core contract

- Output a complete `document_docx` artifact payload.
- Keep the payload compatible with Stuart's DOCX renderer.
- Treat this as a real editable study document, not a chat response.
- If editing an existing document, preserve useful structure and improve it safely instead of flattening it.
- Use any worker briefs in `.stuart/worker-briefs/` if present.
- Use any staged bundle assets under `.stuart/skill-assets/document-docx/` if present.

## Required payload shape

```json
{
  "kind": "document_docx",
  "title": "Breadth-First Search Study Guide",
  "document": {
    "metadata": {
      "author": "Stuart",
      "subject": "Breadth-First Search",
      "description": "Editable study guide grounded in lecture materials."
    },
    "citations": [
      {
        "sourceId": "lecture-2",
        "relativePath": "Lecture 2 - Solving Problems by Searching.pdf",
        "locator": "slide 12",
        "excerpt": "Breadth-first search expands the shallowest unexpanded node first."
      }
    ],
    "sections": [
      {
        "heading": "Core Idea",
        "level": 1,
        "paragraphs": [
          { "type": "text", "content": "Breadth-first search explores the state space level by level." },
          { "type": "bullet", "content": "Uses a FIFO queue frontier." },
          { "type": "numbered", "content": "Pop the oldest frontier node." },
          { "type": "definition", "term": "Frontier", "definition": "The set of discovered but unexplored states." },
          { "type": "kv", "entries": [{ "key": "Complete", "value": "Yes for finite branching factor" }] },
          { "type": "table", "headers": ["Property", "BFS"], "rows": [["Optimal", "Yes for equal positive step costs"]] },
          { "type": "math", "content": "b^d", "display": true },
          { "type": "svg", "svg": "<svg viewBox=\"0 0 240 120\">...</svg>", "caption": "Queue expansion across BFS layers." },
          { "type": "code", "content": "frontier.push(start)\\nwhile frontier.size > 0", "language": "python" },
          { "type": "callout", "content": "BFS is memory-heavy because the frontier grows exponentially.", "style": "warning" },
          { "type": "quote", "content": "Breadth-first search is complete and optimal under the usual assumptions." },
          { "type": "divider" },
          { "type": "citation_note", "content": "[1] Lecture 2, slides 12-16." }
        ]
      }
    ]
  }
}
```

## Supported paragraph types

Use only these paragraph types:

- `text`
  - Plain explanatory prose. Keep paragraphs short.
- `bullet`
  - One bullet item. Use multiple bullet paragraphs rather than embedding a list in one string.
- `numbered`
  - One ordered step.
- `table`
  - Requires `headers` and `rows`. Every row must match header width.
- `callout`
  - Requires `content`. Optional `style`: `info`, `tip`, `warning`, `important`.
- `quote`
  - For direct course wording or high-value quotations.
- `citation_note`
  - Compact section-level source note such as `[1] Lecture 2 slide 13`.
- `math`
  - Requires `content`. Optional `display: true` for centered display equations.
- `code`
  - Requires `content`. Optional `language` for human readability.
- `svg`
  - Requires raw `<svg>...</svg>` markup. Optional `caption`, `alt`, `width`, and `height`.
  - Use for diagrams, flowcharts, state graphs, geometric figures, and rendered equation graphics when a text block would lose structure.
- `divider`
  - No content. Use sparingly to separate blocks.
- `definition`
  - Requires `term` and `definition`.
- `kv`
  - Requires `entries`, where each entry is `{ "key": "...", "value": "..." }`.

## Structure rules

- Use `level` 1, 2, or 3 only.
- Every section must contain at least one paragraph.
- Prefer 3-6 strong sections over many thin sections.
- Mix paragraph types. Do not produce a wall of only `text` or only `bullet`.
- Use `definition`, `kv`, `table`, `math`, and `callout` when they teach more clearly than prose.

## Math and notation rules

- Use `math` paragraphs for display equations, derivations, and formulas the student should study directly.
- Use `svg` paragraphs for diagrams, plotted curves, state machines, process flows, geometric sketches, and any equation/visual that must preserve 2D layout beyond plain text math.
- For inline math anywhere inside strings — including `text`, `bullet`, `numbered`, `definition`, `kv`, `table`, `quote`, and `citation_note` — wrap the math in `$...$`.
- Use LaTeX notation inside those delimiters:
  - `$x_1 + 2x_2 \\leq 6$`
  - `$O(n^2)$`
  - `$\\alpha$`, `$\\beta$`, `$\\sum_{i=1}^n i$`
- Do not emit bare forms like `x1 + 2x2 <= 6` when the content is mathematical.
- For equations that are central to the topic, keep the full relationship in a `math` paragraph and follow it with a compact `definition`, `kv`, or `table` block that names variables, assumptions, or cases.
- Do not flatten formula-driven content into prose bullets when a math block would preserve the structure better.

## Grounding and citations

- Put all source records in the top-level `citations` array.
- Every course-specific claim should be supported by those citations.
- Use `citation_note` paragraphs for local reminders, but the real evidence lives in the top-level `citations`.
- If evidence is thin, shorten the document. Do not pad.

## What good DOCX outputs look like

- readable as a handout or revision note
- editable after export
- grounded in course material
- useful for both humanities and STEM topics
- visually varied enough to scan quickly

## What to avoid

- generic essay prose
- unsupported expansions beyond the workspace
- fake citations
- HTML, markdown, or raw LaTeX wrappers around the payload
- giant monolithic sections with no visual structure

## Final self-check

Before returning, verify:

- exactly one `document_docx` payload
- valid JSON
- at least one section
- only supported paragraph types
- SVG blocks use raw `<svg>...</svg>` markup when present
- tables have matching column counts
- definitions use `term` + `definition`
- `kv` blocks use `entries`
- citations array is populated when factual claims are present
