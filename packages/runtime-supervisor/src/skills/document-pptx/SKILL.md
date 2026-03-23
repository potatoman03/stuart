# Skill Bundle: PPTX Presentation

You are generating a structured slide deck for Stuart.

Return exactly one JSON artifact payload for `document_pptx`. Do not return prose.

## Core contract

- Output a complete `document_pptx` artifact payload.
- Keep the payload compatible with Stuart's slide renderer.
- Plan the deck before writing slide content.
- Preserve useful structure when editing an existing deck instead of flattening it into generic slides.
- Use any worker briefs in `.stuart/worker-briefs/` if present.
- Use any staged bundle assets under `.stuart/skill-assets/document-pptx/` if present.

## Required payload shape

```json
{
  "kind": "document_pptx",
  "title": "Adversarial Search Overview",
  "presentation": {
    "theme": {
      "primaryColor": "#2962FF",
      "fontFamily": "Arial"
    },
    "citations": [
      {
        "sourceId": "lecture-5",
        "relativePath": "Lecture 5 - Adversarial Search.pdf",
        "locator": "slides 8-14",
        "excerpt": "Minimax assumes optimal play from both sides."
      }
    ],
    "slides": [
      {
        "layout": "title",
        "title": "Adversarial Search",
        "subtitle": "Minimax and alpha-beta pruning",
        "notes": ["Open by contrasting single-agent search with adversarial settings."]
      },
      {
        "layout": "section",
        "title": "Core concepts",
        "notes": ["Use this as a transition slide."]
      },
      {
        "layout": "content",
        "title": "Minimax assumptions",
        "bullets": [
          "Two-player, zero-sum setting",
          "Perfect information",
          "Both sides act optimally"
        ],
        "notes": ["Emphasize why these assumptions matter for exam questions."]
      },
      {
        "layout": "two_column",
        "title": "Minimax vs alpha-beta",
        "left": ["Minimax explores the game tree conceptually.", "No pruning by default."],
        "right": ["Alpha-beta preserves the minimax result.", "Prunes branches that cannot affect the decision."],
        "notes": ["Keep the comparison tight and high-signal."]
      },
      {
        "layout": "table",
        "title": "Property comparison",
        "headers": ["Property", "Minimax", "Alpha-beta"],
        "rows": [
          ["Optimality", "Yes", "Yes"],
          ["Pruning", "No", "Yes"],
          ["Best-case speedup", "None", "Substantial"]
        ],
        "notes": ["Mention move ordering in the spoken explanation."]
      },
      {
        "layout": "diagram",
        "title": "Game-tree pruning pattern",
        "svg": "<svg viewBox=\"0 0 640 360\">...</svg>",
        "caption": "Alpha-beta can prune branches that cannot affect the minimax decision.",
        "notes": ["Keep labels short so the visual remains legible at slide distance."]
      }
    ]
  }
}
```

## Supported slide layouts

Use only these layouts:

- `title`
  - Fields: `title`, optional `subtitle`, optional `notes`
- `content`
  - Fields: `title`, `bullets`, optional `notes`
- `two_column`
  - Fields: `title`, `left`, `right`, optional `notes`
- `table`
  - Fields: `title`, `headers`, `rows`, optional `notes`
- `diagram`
  - Fields: `title`, `svg`, optional `caption`, optional `notes`
  - Use raw `<svg>...</svg>` markup for diagrams, plotted curves, flowcharts, state spaces, search trees, or rendered equation figures that must preserve visual structure.
- `section`
  - Fields: `title`, optional `notes`
- `sources`
  - Fields: `entries`, optional `notes`
  - Use when you want an explicit references slide in the payload.

## Notes field

- `notes` is an array of presenter-note strings.
- Use notes for teaching reminders, emphasis, examples, or cautions that should not clutter the slide itself.
- Keep notes concrete and brief.

## Deck design rules

- One main idea per slide.
- Use `section` slides for major transitions.
- Prefer `two_column` and `table` when they teach better than bullet walls.
- Keep bullets concise and parallel.
- Include citations in the top-level `citations` array for course-specific content.
- End with explicit sources in the payload when helpful; Stuart can also append references from citations.

## Math and notation rules

- For inline math in slide titles, bullets, table cells, and notes, wrap the notation in `$...$`.
- Examples:
  - `"title": "Simplex update: $x_1$ enters"`
  - `"bullets": ["Constraint: $x_1 + 2x_2 \\leq 6$", "Complexity: $O(n^2)$"]`
  - `"rows": [["Variable", "$x_1$"], ["Objective", "$z = 3x_1 + 2x_2$"]]`
- Use `\\alpha`, `\\beta`, `\\sum`, `\\leq`, subscripts like `_1`, and superscripts like `^2` inside those delimiters.
- Do not emit bare math-like text such as `x1 + 2x2 <= 6` when the content is mathematical.
- For equation-heavy slides, keep the core formula in a title, bullet, or table cell with `$...$`, then use notes to explain variables, assumptions, or derivation steps without crowding the slide surface.
- Prefer `table` or `two_column` layouts when the comparison or derivation is clearer as structured math than as bullet prose.
- Use `diagram` when the student needs a real visual: search trees, simplex geometry, circuit diagrams, annotated coordinate plots, or rendered equation figures.

## Good deck patterns

- title -> section -> concept slides -> comparison/table slides -> sources
- lecture recap decks
- worked-example decks
- revision decks with clear concept progression

## What to avoid

- giant bullet walls
- repeating the same idea across multiple content slides
- decorative filler slides
- unsupported claims beyond the workspace
- slide text that reads like essay prose

## Final self-check

Before returning, verify:

- exactly one `document_pptx` payload
- valid JSON
- at least one slide
- every slide uses a supported layout
- `diagram` slides include valid raw `<svg>...</svg>` markup when used
- `table` slides have matching headers/row widths
- content slides stay concise
- citations array is populated for grounded factual decks
