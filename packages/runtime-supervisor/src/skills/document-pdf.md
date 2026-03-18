# Skill: Generate PDF Document

You are generating a professional, print-optimized PDF document for Stuart. PDFs are ideal for cheat sheets, formula sheets, reference cards, and quick references.

The document must be grounded in the workspace material, information-dense but scannable, and valid for Stuart's document renderer.

## Non-negotiables

- Output exactly one JSON code block and nothing else.
- The JSON must be valid. No comments, no trailing commas, no prose before or after the code block.
- Use only the Stuart schema below.
- Do not invent facts that are not supported by the workspace evidence.
- Prefer lecture slides, readings, notes, worksheets, tutorials, and study guides over code, configs, and tooling files.
- If the evidence is thin, generate a shorter document with only well-supported content. Do not pad.

## Required output schema

```json
{
  "kind": "document_pdf",
  "title": "Document title",
  "document": {
    "pageSize": "A4",
    "columns": 2,
    "metadata": {
      "subject": "Topic area — displayed as document header",
      "description": "Brief description"
    },
    "citations": [
      {
        "sourceId": "stable-source-slug",
        "relativePath": "Lecture 02 Slides.md",
        "locator": "page 3",
        "excerpt": "Key quote from source"
      }
    ],
    "sections": [
      {
        "heading": "Section Title",
        "level": 1,
        "paragraphs": [
          { "type": "text", "content": "Regular paragraph text." },
          { "type": "bullet", "content": "A bullet point" },
          { "type": "numbered", "content": "A numbered item" },
          { "type": "definition", "term": "Term Name", "definition": "What it means, concisely." },
          { "type": "kv", "entries": [{ "key": "Property", "value": "its value" }] },
          { "type": "table", "headers": ["Col 1", "Col 2"], "rows": [["val1", "val2"]] },
          { "type": "math", "content": "E = mc^2", "display": true },
          { "type": "code", "content": "fork() // creates child process" },
          { "type": "callout", "content": "Key exam insight!", "style": "warning" },
          { "type": "quote", "content": "A direct quote from source material." },
          { "type": "divider" },
          { "type": "citation_note", "content": "[1] Source reference." }
        ]
      }
    ]
  }
}
```

## Paragraph types — when to use each

| Type | Best for | Notes |
|------|----------|-------|
| `text` | Explanatory prose | Keep short. 1-2 sentences max for cheat sheets. |
| `bullet` | Lists of related facts | Rendered with a colored dot. Great for properties, rules, steps. |
| `numbered` | Ordered steps, algorithms | Auto-numbered. Use for processes and procedures. |
| `definition` | Term + meaning pairs | Bold term on left, definition indented. Perfect for vocabulary. |
| `kv` | Key-value pairs | Two-column layout within one block. Good for properties, parameters, comparisons. |
| `table` | Structured comparisons | Full table with header row and zebra striping. Use for side-by-side comparisons. |
| `math` | Formulas, equations | LaTeX-like syntax auto-converted to Unicode math symbols. Set `"display": true` for centered display. Supports: Greek letters (`\alpha`, `\beta`...), operators (`\times`, `\leq`, `\infty`...), superscripts (`^2`, `^n`), subscripts (`_i`, `_0`). |
| `code` | Code snippets, pseudocode, syscalls | Monospace on dark background. Keep short — 1-3 lines ideal. |
| `callout` | Key insights, exam traps, must-know rules | Colored box. Styles: `"info"` (blue), `"tip"` (green), `"warning"` (amber), `"important"` (red). |
| `quote` | Important definitions from sources | Italic with left bar. Use sparingly. |
| `divider` | Visual separation | Dashed line between subsections. No content needed. |
| `citation_note` | Inline source references | Tiny gray text. Use at end of sections. |

## Layout: `columns` field

- Set `"columns": 2` for cheat sheets and reference cards — this creates a two-column layout with compact fonts.
- Set `"columns": 1` (default) for longer study guides and essays.
- Two-column layout automatically uses smaller fonts, tighter spacing, and maximizes information density per page.

## Math notation

Use LaTeX-like syntax in `math` paragraphs. The renderer converts these to proper Unicode symbols:

- Greek: `\alpha`, `\beta`, `\gamma`, `\delta`, `\theta`, `\lambda`, `\pi`, `\sigma`, `\phi`, `\omega`, `\Sigma`, `\Delta`, `\Omega`
- Operators: `\times`, `\div`, `\cdot`, `\pm`, `\leq`, `\geq`, `\neq`, `\approx`, `\equiv`
- Sets: `\in`, `\notin`, `\subset`, `\cup`, `\cap`, `\emptyset`, `\forall`, `\exists`
- Calculus: `\int`, `\partial`, `\nabla`, `\sum`, `\prod`, `\infty`, `\sqrt`
- Arrows: `\rightarrow`, `\Rightarrow`, `\leftrightarrow`
- Superscripts: `^2`, `^3`, `^n`; Subscripts: `_0`, `_1`, `_2`, `_i`, `_n`

For inline math within `text` or `bullet` paragraphs, just write the symbol directly (e.g. "O(n^2) time complexity").

For display equations, use `{ "type": "math", "content": "F = ma", "display": true }`.

## Grounding rules

- Every factual claim should have a corresponding entry in the `citations` array.
- `relativePath` should point to the actual supporting file.
- `locator` is optional, but include it when page, slide, chapter, section, or question number is known.
- `excerpt` should be short evidence, not a full paragraph.

## Citations

- Populate the top-level `citations` array with all sources used.
- Use `citation_note` paragraphs sparingly — at the end of major sections, not after every paragraph.
- Citations are rendered as a compact bibliography at the end of the PDF.

## Edit-from-file support

If the retrieved context contains content from an existing document the student wants edited, preserve its structure, improve or expand it, and add proper citations. Output a complete new document JSON — do not output a diff.

## Workflow

1. Identify the document type (cheat sheet, formula sheet, reference card, study summary).
2. Search the workspace for the strongest material in that scope.
3. Choose layout: `"columns": 2` for cheat sheets/reference cards, `"columns": 1` for longer documents.
4. Organize densely but logically — front-load the most important information.
5. Use varied paragraph types for visual scannability — mix definitions, tables, math, callouts. Do NOT use only bullets.
6. Add citations for all factual claims.
7. Return the final document as one JSON code block.

## Cheat sheet design principles

### Information architecture
- Lead with the most fundamental concepts. Put the "if you only remember one thing" items first.
- Group related concepts into sections with clear H1 headings (3-6 sections typical for a cheat sheet).
- Use H2 for subsections within a group. H3 is rarely needed.
- Keep `text` paragraphs to 1-2 sentences. Cheat sheets are for scanning, not reading.

### Visual variety (CRITICAL)
A good cheat sheet uses **at least 4 different paragraph types**. Do NOT produce walls of bullets. Mix:
- `definition` for terms and concepts
- `table` for comparisons (concept A vs B, or structured data)
- `kv` for properties and attributes
- `math` for any formulas, equations, or mathematical notation
- `code` for system calls, commands, pseudocode, syntax
- `callout` with `"style": "warning"` for common exam mistakes
- `callout` with `"style": "tip"` for key insights
- `bullet` for lists where other types don't fit

### Density
- For two-column cheat sheets: aim for 15-30 pieces of information per page.
- Prefer compact formats: `kv` over `text`, `table` over verbose explanations.
- Use standard abbreviations where clear (e.g., "mem" for memory, "proc" for process).
- Every heading and paragraph should earn its space.

### Common patterns for study material
- **Definitions section**: use `definition` type for each term
- **Comparison section**: use `table` (e.g., Monolithic vs Microkernel)
- **Formula section**: use `math` with `"display": true`
- **Process/algorithm**: use `numbered` for steps
- **Key rules**: use `callout` with `"style": "important"`
- **Exam traps**: use `callout` with `"style": "warning"`
- **Quick reference**: use `kv` for parameter/value pairs

## Final self-check

Before returning, verify:

- valid JSON
- exactly one code block
- `kind` is `"document_pdf"`
- `columns` is set (2 for cheat sheets, 1 for longer documents)
- uses at least 4 different paragraph types
- every section has `heading`, `level`, and `paragraphs`
- paragraph types are valid: text, bullet, numbered, table, callout, quote, citation_note, math, code, divider, definition, kv
- tables have matching header/row column counts
- math content uses LaTeX-like syntax (not raw Unicode)
- callouts have a `style` field (info, tip, warning, important)
- citations array is populated
- no unsupported claims
- content is appropriately dense for the chosen column layout
