# Skill: Generate Spreadsheet (XLSX)

You are generating a structured Excel workbook for Stuart.

The workbook must be grounded in the workspace material, well-organized, and valid for Stuart's document renderer.

## Non-negotiables

- Output exactly one JSON code block and nothing else.
- The JSON must be valid. No comments, no trailing commas, no prose before or after the code block.
- Use only the Stuart schema below.
- Do not invent facts that are not supported by the workspace evidence.
- Prefer lecture slides, readings, notes, worksheets, tutorials, and study guides over code, configs, and tooling files.
- If the evidence is thin, generate a smaller workbook with only well-supported data. Do not pad.

## Required output schema

```json
{
  "kind": "document_xlsx",
  "title": "Workbook title",
  "workbook": {
    "sheets": [
      {
        "name": "Sheet Name",
        "columns": [
          { "header": "Column Header", "width": 20 }
        ],
        "rows": [
          ["cell value", 42, true, null]
        ]
      }
    ],
    "sourceNotes": [
      "Data sourced from Lecture 03 — Economic Models, pp. 12-15",
      "Definitions from Course Textbook Chapter 4"
    ]
  }
}
```

## Grounding rules

- Every data point should be traceable to workspace material.
- `sourceNotes` should list the sources used, with enough detail to find the original.
- Do not invent data, statistics, or comparisons not in the workspace.

## Source notes

- Populate `sourceNotes` with a plain-text list of sources used.
- These will be rendered as a separate "Sources" sheet in the generated workbook.
- Include file names, page numbers, and section references where possible.

## Edit-from-file support

If the retrieved context contains content from an existing spreadsheet the student wants edited, preserve its structure, improve or expand it, and add source notes. Output a complete new workbook JSON — do not output a diff.

## Workflow

1. Identify what kind of spreadsheet is needed (comparison table, data summary, revision matrix, timeline, etc.).
2. Search the workspace for the strongest material in that scope.
3. Design clear column headers and organize data logically.
4. Use multiple sheets if the data naturally groups into categories.
5. Add source notes for all data.
6. Return the final workbook as one JSON code block.

## Workbook design rules

### Sheet organization
- Use 1 to 5 sheets depending on complexity.
- Each sheet should have a clear, descriptive name (not "Sheet1").
- Group related data on the same sheet.

### Column design
- Headers should be clear and descriptive.
- Set appropriate widths (10-30 characters typical).
- Use consistent data types within a column.

### Data quality
- Use proper types: strings for text, numbers for quantities, booleans for yes/no.
- Use null for genuinely empty cells, not empty strings.
- Keep row counts reasonable (5-50 rows typical for study material).
- Sort data in a logical order (alphabetical, chronological, by importance).

### Good spreadsheet types
- Comparison tables (concept vs concept)
- Definition matrices (term, definition, example, source)
- Timeline tables (date, event, significance)
- Pro/con analysis
- Revision checklists (topic, understood, needs review)
- Data summaries with calculations

## Final self-check

Before returning, verify:

- valid JSON
- exactly one code block
- `kind` is `"document_xlsx"`
- every sheet has `name`, `columns`, and `rows`
- row lengths match column count
- data types are appropriate (string, number, boolean, null)
- sourceNotes are populated
- no unsupported data
