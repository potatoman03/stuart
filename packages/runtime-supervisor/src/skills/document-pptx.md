# Skill: Generate Presentation (PPTX)

You are generating a structured PowerPoint presentation for Stuart.

The presentation must be grounded in the workspace material, visually well-structured, and valid for Stuart's document renderer.

## Non-negotiables

- Output exactly one JSON code block and nothing else.
- The JSON must be valid. No comments, no trailing commas, no prose before or after the code block.
- Use only the Stuart schema below.
- Do not invent facts that are not supported by the workspace evidence.
- Prefer lecture slides, readings, notes, worksheets, tutorials, and study guides over code, configs, and tooling files.
- If the evidence is thin, generate fewer slides with only well-supported content. Do not pad.

## Required output schema

```json
{
  "kind": "document_pptx",
  "title": "Presentation title",
  "presentation": {
    "theme": {
      "primaryColor": "#2962FF",
      "fontFamily": "Arial"
    },
    "citations": [
      {
        "sourceId": "stable-source-slug",
        "relativePath": "Lecture 02 Slides.md",
        "locator": "page 3",
        "excerpt": "Key quote from source"
      }
    ],
    "slides": [
      { "layout": "title", "title": "Presentation Title", "subtitle": "Optional subtitle" },
      { "layout": "content", "title": "Slide Title", "bullets": ["Point 1", "Point 2"] },
      { "layout": "two_column", "title": "Comparison", "left": ["Left points"], "right": ["Right points"] },
      { "layout": "table", "title": "Data Overview", "headers": ["Col 1", "Col 2"], "rows": [["a", "b"]] },
      { "layout": "section", "title": "Section Divider" },
      { "layout": "sources", "entries": ["Source 1 — details", "Source 2 — details"] }
    ]
  }
}
```

## Grounding rules

- Every factual claim should have a corresponding entry in the `citations` array.
- `relativePath` should point to the actual supporting file.
- `locator` is optional, but include it when page, slide, chapter, section, or question number is known.
- `excerpt` should be short evidence, not a full paragraph.

## Citations

- Populate the top-level `citations` array with all sources used.
- A final "References" slide will be auto-generated from the citations array.
- You may also include an explicit `sources` layout slide if you want custom formatting.

## Edit-from-file support

If the retrieved context contains content from an existing presentation the student wants edited, preserve its structure, improve or expand it, and add proper citations. Output a complete new presentation JSON — do not output a diff.

## Workflow

1. Identify the presentation topic and scope.
2. Search the workspace for the strongest material in that scope.
3. Plan the slide sequence: title → section dividers → content slides → references.
4. Write concise, presentation-appropriate content (not essay prose).
5. Add citations for all factual claims.
6. Return the final presentation as one JSON code block.

## Slide design rules

### General
- Target 8 to 20 slides for a standard presentation.
- Always start with a `title` layout slide.
- Use `section` layout slides to separate major topics.
- End with citations (auto-generated from citations array, or explicit `sources` slide).

### Content slides
- Maximum 4-6 bullets per slide.
- Each bullet should be a concise phrase or short sentence (not a paragraph).
- Use parallel structure across bullets.
- One key idea per slide.

### Two-column slides
- Great for comparisons, pros/cons, before/after.
- Keep left and right balanced (similar number of points).

### Table slides
- Keep tables small (3-5 rows, 2-4 columns).
- Headers should be clear and brief.
- Cell content should be concise.

### Section slides
- Use to introduce major topic transitions.
- Title should be 2-5 words.

### Theme
- `primaryColor` sets the accent color (headings, bullets). Default: "#2962FF".
- `fontFamily` sets the base font. Default: "Arial".

## Final self-check

Before returning, verify:

- valid JSON
- exactly one code block
- `kind` is `"document_pptx"`
- first slide uses `title` layout
- all slides have valid layout types: title, content, two_column, table, section, sources
- content slides have 6 or fewer bullets
- table slides have matching header/row column counts
- citations array is populated
- no unsupported claims
