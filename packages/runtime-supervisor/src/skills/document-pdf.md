# Skill: Generate PDF Document

You are generating a professional, print-optimized PDF document for Stuart. PDFs can serve many purposes: cheat sheets, study guides, reports, proposals, resumes, letters, and more.

The document must be grounded in the workspace material, well-structured for its document type, and valid for Stuart's document renderer.

## Non-negotiables

- Output exactly one JSON code block and nothing else.
- The JSON must be valid. No comments, no trailing commas, no prose before or after the code block.
- Use only the Stuart schema below.
- Do not invent facts that are not supported by the workspace evidence.
- Prefer lecture slides, readings, notes, worksheets, tutorials, and study guides over code, configs, and tooling files.
- If the evidence is thin, generate a shorter document with only well-supported content. Do not pad.

## Document types

Choose the `docType` that best fits the student's request. Each type has a distinct visual identity:

| `docType` | Purpose | Typical layout | Default `mood` |
|-----------|---------|----------------|----------------|
| `report` | Formal academic or project report | 1-column, cover page | `academic` |
| `proposal` | Project or research proposal | 1-column, cover page | `corporate` |
| `study_guide` | Comprehensive topic review | 1-column, dense sections | `academic` |
| `cheat_sheet` | Quick-reference formula/fact sheet | 2-column, ultra-compact | `technical` |
| `reference_card` | API, syntax, or command reference | 2-column, compact | `technical` |
| `syllabus` | Course or module outline | 1-column, structured | `academic` |
| `essay` | Argumentative or expository essay | 1-column, flowing prose | `elegant` |
| `letter` | Formal or semi-formal letter | 1-column, letterhead style | `minimal` |
| `memo` | Internal communication | 1-column, compact header | `corporate` |
| `resume` | CV or resume | 1-column, structured | `minimal` |
| `invoice` | Billing document | 1-column, tabular | `corporate` |
| `recipe` | Step-by-step instructions (cooking, lab protocols) | 1-column, numbered steps | `warm` |
| `poster` | Conference or class poster | 2-column, large headings | `creative` |
| `one_pager` | Executive summary or project brief | 1-column, concise | `corporate` |
| `brief` | Short informational brief | 1-column, compact | `minimal` |

## Mood system

The `mood` field controls the document's color palette, typography feel, and accent styling. Choose one:

| `mood` | Primary color | Feel |
|--------|---------------|------|
| `academic` | `#1a365d` (navy) | Scholarly, authoritative, classic |
| `corporate` | `#1e3a5f` (dark blue) | Professional, clean, business |
| `creative` | `#6b21a8` (purple) | Vibrant, expressive, artistic |
| `minimal` | `#374151` (gray) | Clean, understated, modern |
| `warm` | `#92400e` (amber) | Approachable, friendly, inviting |
| `playful` | `#0d9488` (teal) | Energetic, fun, engaging |
| `technical` | `#0f172a` (slate) | Precise, structured, engineering |
| `elegant` | `#1c1917` (charcoal) | Refined, sophisticated, timeless |

The mood's primary color is applied to headers, accent bars, callout backgrounds, bullet dots, table headers, and the cover page accent element.

## Required output schema

```json
{
  "kind": "document_pdf",
  "title": "Document title",
  "document": {
    "docType": "report",
    "mood": "academic",
    "pageSize": "A4",
    "columns": 1,
    "cover": {
      "title": "Main Document Title",
      "subtitle": "Optional subtitle or tagline",
      "author": "Student Name or Team",
      "date": "March 2026",
      "institution": "University or Course Name",
      "coverPattern": "dots"
    },
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
          { "type": "heading", "content": "Inline sub-heading", "level": 2 },
          { "type": "bullet", "content": "A bullet point" },
          { "type": "numbered", "content": "A numbered item" },
          { "type": "definition", "term": "Term Name", "definition": "What it means, concisely." },
          { "type": "kv", "entries": [{ "key": "Property", "value": "its value" }] },
          { "type": "table", "headers": ["Col 1", "Col 2"], "rows": [["val1", "val2"]] },
          { "type": "math", "content": "E = mc^2", "display": true },
          { "type": "svg", "svg": "<svg viewBox=\"0 0 320 160\">...</svg>", "caption": "Simplex feasible-region sketch" },
          { "type": "code", "content": "fork() // creates child process" },
          { "type": "callout", "content": "Key exam insight!", "style": "warning" },
          { "type": "quote", "content": "A direct quote from source material." },
          { "type": "divider" },
          { "type": "citation_note", "content": "[1] Source reference." },
          { "type": "bibliography", "entries": ["[1] Author. Title. Journal, 2024.", "[2] Author. Book Title. Publisher, 2023."] },
          { "type": "checklist", "items": [{ "label": "Review Chapter 3", "checked": false }, { "label": "Complete problem set", "checked": true }] },
          { "type": "timeline", "events": [{ "date": "Week 1", "title": "Introduction", "description": "Overview of key concepts" }, { "date": "Week 2", "title": "Deep Dive", "description": "Detailed analysis begins" }] },
          { "type": "image_placeholder", "alt": "Diagram of neural network architecture", "width": 300, "height": 200 }
        ]
      }
    ]
  }
}
```

## Cover page

Include a `cover` object for document types that benefit from a title page: `report`, `proposal`, `syllabus`, `essay`, `poster`, `one_pager`. The cover page is rendered as a full first page with the mood's accent color.

- `title` (required): The main document title, displayed large and bold.
- `subtitle` (optional): A tagline, course name, or description.
- `author` (optional): The author or team name.
- `date` (optional): Date string (e.g., "March 2026", "2026-03-30").
- `institution` (optional): University, company, or organization.
- `coverPattern` (optional): Decorative pattern — `"dots"`, `"lines"`, `"grid"`, `"none"`. Default is `"none"`.

For compact types like `cheat_sheet`, `reference_card`, `memo`, `resume`, and `invoice`, omit the cover and use the `metadata.subject` header instead.

## Paragraph types — when to use each

| Type | Best for | Notes |
|------|----------|-------|
| `text` | Explanatory prose | Keep short. 1-2 sentences max for cheat sheets. |
| `heading` | Inline sub-headings within a section | Use `level` (2 or 3) to control size. Useful when a section needs internal structure without a new top-level section. |
| `bullet` | Lists of related facts | Rendered with a colored dot. Great for properties, rules, steps. |
| `numbered` | Ordered steps, algorithms | Auto-numbered. Use for processes and procedures. |
| `definition` | Term + meaning pairs | Bold term on left, definition indented. Perfect for vocabulary. |
| `kv` | Key-value pairs | Two-column layout within one block. Good for properties, parameters, comparisons. |
| `table` | Structured comparisons | Full table with header row and zebra striping. Use for side-by-side comparisons. |
| `math` | Formulas, equations | LaTeX-like syntax auto-converted to Unicode math symbols. Set `"display": true` for centered display. Supports: Greek letters (`\alpha`, `\beta`...), operators (`\times`, `\leq`, `\infty`...), superscripts (`^2`, `^n`), subscripts (`_i`, `_0`). |
| `svg` | Diagrams, plots, geometric figures | Provide raw `<svg>...</svg>` markup. Optional `caption`. Use when a visual or 2D layout matters more than text. |
| `code` | Code snippets, pseudocode, syscalls | Monospace on dark background. Keep short — 1-3 lines ideal. |
| `callout` | Key insights, exam traps, must-know rules | Colored box. Styles: `"info"` (blue), `"tip"` (green), `"warning"` (amber), `"important"` (red). |
| `quote` | Important definitions from sources | Italic with left bar. Use sparingly. |
| `divider` | Visual separation | Dashed line between subsections. No content needed. |
| `citation_note` | Inline source references | Tiny gray text. Use at end of sections. |
| `bibliography` | Formatted reference list | Array of `entries` strings. Each entry is a complete formatted reference. Use at the end of reports, essays, and proposals. |
| `checklist` | Task lists, requirements, to-do items | Array of `items` with `label` and `checked` boolean. Great for syllabi, study plans, and project tracking. |
| `timeline` | Chronological events, project phases, historical sequences | Array of `events` with `date`, `title`, and `description`. Rendered as a vertical timeline with the mood's accent color. |
| `image_placeholder` | Placeholder for images not yet available | Shows a bordered placeholder box with alt text. Use when referencing a figure that cannot be rendered as SVG. |

## Layout: `columns` field

- Set `"columns": 2` for cheat sheets and reference cards — this creates a two-column layout with compact fonts.
- Set `"columns": 1` (default) for longer study guides, reports, essays, and most other types.
- Two-column layout automatically uses smaller fonts, tighter spacing, and maximizes information density per page.

## Math notation

Use LaTeX-like syntax in `math` paragraphs. The renderer converts these to proper Unicode symbols:

- Greek: `\alpha`, `\beta`, `\gamma`, `\delta`, `\theta`, `\lambda`, `\pi`, `\sigma`, `\phi`, `\omega`, `\Sigma`, `\Delta`, `\Omega`
- Operators: `\times`, `\div`, `\cdot`, `\pm`, `\leq`, `\geq`, `\neq`, `\approx`, `\equiv`
- Sets: `\in`, `\notin`, `\subset`, `\cup`, `\cap`, `\emptyset`, `\forall`, `\exists`
- Calculus: `\int`, `\partial`, `\nabla`, `\sum`, `\prod`, `\infty`, `\sqrt`
- Arrows: `\rightarrow`, `\Rightarrow`, `\leftrightarrow`
- Superscripts: `^2`, `^3`, `^n`; Subscripts: `_0`, `_1`, `_2`, `_i`, `_n`

For inline math anywhere inside strings — including `text`, `bullet`, `numbered`, `definition`, `kv`, `table`, and `citation_note` — wrap the math in `$...$`.

Examples:

- `"Runtime is $O(n^2)$ in the worst case."`
- `"Constraint 1: $x_1 + 2x_2 \\leq 6$"`
- `["Variable", "$x_1$"]`

Do not emit bare forms like `x1 + 2x2 <= 6` when you mean mathematical notation.

For display equations, use `{ "type": "math", "content": "F = ma", "display": true }`.

For diagrams, charts, trees, state graphs, coordinate plots, and other spatial visuals, use `{ "type": "svg", "svg": "<svg ...>...</svg>", "caption": "..." }`.

Use `math` paragraphs for standalone equations, derivations, and formulas the student should study directly. If a section is formula-heavy, pair the equation with a compact `definition`, `kv`, or `table` block so symbols and assumptions stay explicit instead of being flattened into prose.

## Grounding rules

- Every factual claim should have a corresponding entry in the `citations` array.
- `relativePath` should point to the actual supporting file.
- `locator` is optional, but include it when page, slide, chapter, section, or question number is known.
- `excerpt` should be short evidence, not a full paragraph.

## Citations

- Populate the top-level `citations` array with all sources used.
- Use `citation_note` paragraphs sparingly — at the end of major sections, not after every paragraph.
- For formal documents (reports, proposals, essays), use a `bibliography` paragraph at the end instead of scattered `citation_note` paragraphs.
- Citations are rendered as a compact bibliography at the end of the PDF.

## Edit-from-file support

If the retrieved context contains content from an existing document the student wants edited, preserve its structure, improve or expand it, and add proper citations. Output a complete new document JSON — do not output a diff.

## Workflow

1. Identify the document type from the student's request and set `docType` accordingly.
2. Choose the matching `mood` (or let the default apply). Override only if the student requests a specific feel.
3. Search the workspace for the strongest material in that scope.
4. Decide whether to include a `cover` page (yes for reports, proposals, essays, syllabi; no for cheat sheets, memos, resumes).
5. Choose layout: `"columns": 2` for cheat sheets/reference cards/posters, `"columns": 1` for longer documents.
6. Organize densely but logically — front-load the most important information.
7. Use varied paragraph types for visual scannability — mix definitions, tables, math, callouts, timelines, checklists. Do NOT use only bullets.
8. Add citations for all factual claims.
9. Return the final document as one JSON code block.

## Design principles by document type

### Cheat sheets and reference cards (`cheat_sheet`, `reference_card`)

**Information architecture:**
- Lead with the most fundamental concepts. Put the "if you only remember one thing" items first.
- Group related concepts into sections with clear H1 headings (3-6 sections typical).
- Use H2 for subsections within a group. H3 is rarely needed.
- Keep `text` paragraphs to 1-2 sentences. Cheat sheets are for scanning, not reading.

**Visual variety (CRITICAL):**
A good cheat sheet uses **at least 4 different paragraph types**. Do NOT produce walls of bullets. Mix:
- `definition` for terms and concepts
- `table` for comparisons (concept A vs B, or structured data)
- `kv` for properties and attributes
- `math` for any formulas, equations, or mathematical notation
- `code` for system calls, commands, pseudocode, syntax
- `callout` with `"style": "warning"` for common exam mistakes
- `callout` with `"style": "tip"` for key insights
- `bullet` for lists where other types don't fit

**Density:**
- For two-column cheat sheets: aim for 15-30 pieces of information per page.
- Prefer compact formats: `kv` over `text`, `table` over verbose explanations.
- Use standard abbreviations where clear (e.g., "mem" for memory, "proc" for process).
- Every heading and paragraph should earn its space.

### Reports and proposals (`report`, `proposal`)
- Always include a `cover` page.
- Use `text` paragraphs for narrative flow. Longer paragraphs are acceptable.
- Structure with clear H1 sections: Introduction, Background, Methodology, Results, Discussion, Conclusion.
- Use `table` for data presentation, `math` for equations, `callout` for key findings.
- End with a `bibliography` paragraph listing all references.
- Use `timeline` for project plans or historical context.

### Study guides (`study_guide`)
- Balance between density and readability — more explanation than a cheat sheet.
- Use `checklist` for study progress tracking.
- Use `callout` generously for key concepts and common pitfalls.
- Include `math` for all formulas with explanations via `definition` or `kv`.

### Essays and letters (`essay`, `letter`)
- Flowing prose with `text` paragraphs as the primary type.
- Use `quote` for cited material.
- Minimal use of `table`, `kv`, or `code` — these break the narrative flow.
- End essays with `bibliography`.

### Resumes and invoices (`resume`, `invoice`)
- Highly structured. Use `kv` for contact details and metadata.
- Use `table` for itemized lists (invoice items, skills matrices).
- Use `bullet` for experience descriptions.
- Keep mood as `minimal` or `corporate`.

### Syllabi (`syllabus`)
- Include a `cover` page with course info.
- Use `timeline` for the course schedule.
- Use `checklist` for assignment tracking.
- Use `table` for grading breakdowns.
- Use `callout` for important policies.

### Posters (`poster`)
- Two-column layout with large headings.
- Lead with a strong title and key finding.
- Use `svg` for figures and diagrams.
- Use `callout` for main takeaways.
- Keep text minimal — posters are visual.

## Common patterns for study material
- **Definitions section**: use `definition` type for each term
- **Comparison section**: use `table` (e.g., Monolithic vs Microkernel)
- **Formula section**: use `math` with `"display": true`
- **Formula-heavy section**: lead with `math`, then use `definition` or `kv` to name variables and `table` to compare cases or rearrangements
- **Process/algorithm**: use `numbered` for steps
- **Key rules**: use `callout` with `"style": "important"`
- **Exam traps**: use `callout` with `"style": "warning"`
- **Quick reference**: use `kv` for parameter/value pairs
- **Project timeline**: use `timeline` for chronological events
- **Requirements list**: use `checklist` for trackable items
- **References**: use `bibliography` for formal citation lists

## Final self-check

Before returning, verify:

- valid JSON
- exactly one code block
- `kind` is `"document_pdf"`
- `docType` is one of: report, proposal, study_guide, cheat_sheet, reference_card, syllabus, essay, letter, memo, resume, invoice, recipe, poster, one_pager, brief
- `mood` is one of: academic, corporate, creative, minimal, warm, playful, technical, elegant
- `columns` is set (2 for cheat sheets/reference cards/posters, 1 for longer documents)
- `cover` is present for formal documents (report, proposal, syllabus, essay, poster, one_pager) and absent for compact types
- uses at least 4 different paragraph types
- every section has `heading`, `level`, and `paragraphs`
- paragraph types are valid: text, heading, bullet, numbered, table, callout, quote, citation_note, math, svg, code, divider, definition, kv, bibliography, checklist, timeline, image_placeholder
- tables have matching header/row column counts
- math content uses LaTeX-like syntax (not raw Unicode)
- callouts have a `style` field (info, tip, warning, important)
- `bibliography` entries are complete formatted reference strings
- `checklist` items have `label` and `checked` fields
- `timeline` events have `date`, `title`, and `description` fields
- citations array is populated
- no unsupported claims
- content is appropriately dense for the chosen column layout
