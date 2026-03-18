# Skill: Generate Word Document (DOCX)

You are generating a structured Word document for Stuart.

The document must be grounded in the workspace material, professionally structured, and valid for Stuart's document renderer.

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
  "kind": "document_docx",
  "title": "Document title",
  "document": {
    "metadata": {
      "author": "Student Name (optional)",
      "subject": "Topic area",
      "description": "Brief description of the document"
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
          { "type": "bullet", "content": "A bullet point item" },
          { "type": "numbered", "content": "A numbered list item" },
          { "type": "table", "headers": ["Col 1", "Col 2"], "rows": [["val1", "val2"]] },
          { "type": "callout", "content": "Important note or tip highlighted in a box." },
          { "type": "citation_note", "content": "[1] See source reference." }
        ]
      }
    ]
  }
}
```

## Grounding rules

- Every factual claim should have a corresponding entry in the `citations` array.
- `relativePath` should point to the actual supporting file.
- `locator` is optional, but include it when page, slide, chapter, section, or question number is known.
- `excerpt` should be short evidence, not a full paragraph.
- Cite the material that justifies the claim, not a random nearby mention.

## Citations

- Populate the top-level `citations` array with all sources used.
- Use `citation_note` paragraphs within sections to reference specific citations (e.g., "[1] See Chapter 3 of...").
- Citations will be rendered as numbered endnotes at the end of the generated document.

## Edit-from-file support

If the retrieved context contains content from an existing document the student wants edited (e.g., "add citations to my essay.docx"), preserve its structure, improve or expand it, and add proper citations. Output a complete new document JSON — do not output a diff.

## Workflow

1. Identify the requested scope and document type (study guide, revision notes, summary, handout, etc.).
2. Search the workspace for the strongest material in that scope.
3. Organize into logical sections with clear headings and hierarchy (H1 for major sections, H2/H3 for subsections).
4. Write professional, clear prose with a mix of paragraph types (text, bullets, tables, callouts).
5. Add citations for all factual claims.
6. Return the final document as one JSON code block.

## Document design rules

### Structure
- Use 3 to 8 sections for a standard document.
- Each section should have a clear heading and 2-8 paragraphs.
- Mix paragraph types for readability — don't use only text or only bullets.
- Use tables for comparisons, definitions, or structured data.
- Use callouts for important warnings, tips, or key takeaways.

### Writing quality
- Write in clear, professional academic prose.
- Each paragraph should convey one main idea.
- Bullets should be parallel in structure.
- Tables should have clear, descriptive headers.

### Heading hierarchy
- Level 1: Major sections (Introduction, Key Concepts, Analysis, Conclusion).
- Level 2: Subsections within a major section.
- Level 3: Fine-grained sub-topics.

## Final self-check

Before returning, verify:

- valid JSON
- exactly one code block
- `kind` is `"document_docx"`
- every section has `heading`, `level`, and `paragraphs`
- paragraph types are one of: text, bullet, numbered, table, callout, citation_note
- tables have matching header/row column counts
- citations array is populated with sources used
- no unsupported claims
