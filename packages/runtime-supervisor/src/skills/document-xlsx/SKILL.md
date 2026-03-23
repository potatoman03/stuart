# Skill Bundle: XLSX Workbook

You are generating a structured Excel workbook for Stuart.

Return exactly one JSON artifact payload for `document_xlsx`. Do not return prose.

## Core contract

- Output a complete `document_xlsx` artifact payload.
- Keep the payload compatible with Stuart's workbook renderer.
- Design sheets that help the student reason, compare, calculate, or track progress.
- If editing an existing workbook, preserve useful structure and extend it safely.
- Use any worker briefs in `.stuart/worker-briefs/` if present.
- Use any staged bundle assets under `.stuart/skill-assets/document-xlsx/` if present.

## Required payload shape

```json
{
  "kind": "document_xlsx",
  "title": "Search Algorithm Comparison Workbook",
  "workbook": {
    "sheets": [
      {
        "name": "Comparison",
        "columns": [
          { "header": "Algorithm", "width": 26 },
          { "header": "Complete", "width": 14 },
          { "header": "Notes", "width": 38 },
          { "header": "Score", "width": 14 }
        ],
        "frozenRows": 1,
        "frozenColumns": 1,
        "autoFilter": true,
        "merges": [
          { "startRow": 5, "startColumn": 1, "endRow": 5, "endColumn": 2 }
        ],
        "rows": [
          [
            { "value": "BFS", "style": "subheader" },
            true,
            "Complete and optimal for equal positive step costs.",
            { "formula": "2+2", "value": 4, "numberFormat": "0", "style": "good" }
          ],
          [
            { "value": "DFS", "style": "warning" },
            false,
            "Uses less memory but is not optimal.",
            { "value": 2, "numberFormat": "0" }
          ],
          [
            { "value": "Study takeaway", "style": "emphasis" },
            { "value": "Know when completeness matters.", "style": "muted" },
            null,
            null
          ]
        ]
      }
    ],
    "sourceNotes": [
      "Lecture 2 - Solving Problems by Searching.pdf slide 12",
      "Tutorial 1.pdf question 3"
    ]
  }
}
```

## Sheet schema

Each sheet supports:

- `name`
  - Sheet tab name. Keep it concise.
- `columns`
  - Array of `{ "header": string, "width"?: number }`.
- `rows`
  - 2D array of cells. Each cell can be:
    - a primitive value: string, number, boolean, or `null`
    - or a structured cell object:
      - `value?: string | number | boolean | null`
      - `formula?: string`
      - `numberFormat?: string`
      - `style?: "header" | "subheader" | "emphasis" | "good" | "warning" | "muted"`
- `frozenRows?`
  - Number of top rows to freeze.
- `frozenColumns?`
  - Number of left columns to freeze.
- `autoFilter?`
  - Set to `true` when the main table should be filterable.
- `merges?`
  - Array of merge ranges with 1-based sheet coordinates:
    - `startRow`, `startColumn`, `endRow`, `endColumn`
  - These row numbers include the header row.

## Workbook rules

- Every sheet must have a clear purpose.
- Prefer a few useful sheets over many filler tabs.
- Use formulas when they help the student compute or compare, not just for show.
- Use `sourceNotes` for provenance. This is the workbook-level evidence trail.
- Avoid fake precision and fake spreadsheet complexity.

## Math and notation rules

- When a cell contains mathematical notation as text, wrap the notation in `$...$` in the JSON payload.
- This applies to headers, row labels, notes, and string cells:
  - `"Constraint 1: $x_1 + 2x_2 \\leq 6$"`
  - `"Growth is $O(n^2)$"`
  - `{ "value": "$x_1$ enters the basis" }`
- Use real Excel `formula` fields only for spreadsheet computation.
- Do not emit bare math-like text such as `x1 + 2x2 <= 6` when you mean mathematical notation.
- If the topic is formula-heavy, use a dedicated sheet for worked steps, variable definitions, or comparison cases so the workbook reads like a calculation walkthrough rather than a flat table.
- Keep subject-matter equations in text cells with `$...$`; reserve `formula` fields for workbook calculations that the spreadsheet should compute.

## Style guidance

- `subheader` for row labels or important section starts
- `good` for positive outcomes or desirable results
- `warning` for risks, bad cases, or caveats
- `emphasis` for key takeaways
- `muted` for secondary/supporting notes

## Good workbook patterns

- comparison tables
- worked examples
- simplex/tableau or matrix walk-throughs
- revision trackers
- parameter/result sheets
- formula-backed summaries

## What to avoid

- giant unstructured data dumps
- empty decorative tabs
- formulas with no pedagogical purpose
- fabricated source notes
- charts implied by prose when the schema does not ask for them

## Final self-check

Before returning, verify:

- exactly one `document_xlsx` payload
- valid JSON
- at least one sheet
- `rows` match the intended workbook logic
- formulas are plain Excel formulas without leading prose
- merge coordinates are 1-based and sensible
- `sourceNotes` is populated when the workbook contains factual course content
