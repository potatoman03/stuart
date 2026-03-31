# Skill Bundle: PPTX Presentation

You are generating a structured slide deck for Stuart.

Return exactly one JSON artifact payload for `document_pptx`. Do not return prose.

## Core contract

- Output a complete `document_pptx` artifact payload.
- Keep the payload compatible with Stuart's slide renderer.
- Plan the deck before writing slide content.
- Preserve useful structure when editing an existing deck instead of flattening it into generic slides.
- **Use any worker briefs in `.stuart/worker-briefs/pptx-*.md` if present** — the deck-planner, content-researcher, and design-advisor workers may have already prepared structure plans, content briefs, and design recommendations. Incorporate their guidance.
- Use any staged bundle assets under `.stuart/skill-assets/document-pptx/` if present.

## Slide layout types

Every slide must use one of these 5 layout types:

### 1. `cover` — Title slide
- Dramatic typography with the presentation title front and center.
- Fields: `title`, optional `subtitle`, optional `author`, optional `date`, optional `notes`
- Use exactly once as the first slide.

### 2. `toc` — Table of contents
- Numbered list of the major sections in the deck.
- Fields: `title`, `entries` (string[]), optional `sectionNumber`, optional `notes`
- Use after the cover to give the audience a roadmap.

### 3. `section_divider` — Section break
- Dramatic section break with large section number and title.
- Fields: `title`, `sectionNumber`, optional `subtitle`, optional `notes`
- Use to mark transitions between major sections.

### 4. `content` — Main content slides
Content slides carry the bulk of the presentation. Each content slide must specify a `contentSubtype`:

- **`text_heavy`** — Dense text with bullets, paragraphs, or definitions.
  - Fields: `title`, `bullets`, optional `notes`
- **`mixed_media`** — Text alongside a diagram or image.
  - Fields: `title`, `bullets`, `svg`, optional `caption`, optional `notes`
- **`data_viz`** — Chart, graph, or data table as the focal point.
  - Fields: `title`, `headers`, `rows`, optional `svg`, optional `caption`, optional `notes`
- **`comparison`** — Side-by-side comparison of two concepts.
  - Fields: `title`, `left`, `right`, optional `notes`
- **`timeline`** — Sequential events or process steps.
  - Fields: `title`, `bullets`, optional `notes`
- **`image_showcase`** — Full-slide diagram or image with minimal text.
  - Fields: `title`, `svg`, optional `caption`, optional `notes`

Also supported as content variants (no subtype needed):
- `two_column` — Fields: `title`, `left`, `right`, optional `notes`
- `table` — Fields: `title`, `headers`, `rows`, optional `notes`
- `diagram` — Fields: `title`, `svg`, optional `caption`, optional `notes`
  - Use raw `<svg>...</svg>` markup for diagrams, plotted curves, flowcharts, state spaces, search trees, or rendered equation figures.
- `sources` — Fields: `entries`, optional `notes`
  - Use when you want an explicit references slide in the payload.

### 5. `summary` — Closing slide
- Key takeaways, conclusions, or call to action.
- Fields: `title`, `bullets`, optional `notes`
- Use as the last content slide (before optional sources).

## Required payload shape

```json
{
  "kind": "document_pptx",
  "title": "Adversarial Search Overview",
  "presentation": {
    "theme": {
      "primaryColor": "#296767",
      "secondaryColor": "#1a4040",
      "accentColor": "#4ecdc4",
      "fontHeading": "Montserrat",
      "fontBody": "Open Sans"
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
        "layout": "cover",
        "title": "Adversarial Search",
        "subtitle": "Minimax and alpha-beta pruning",
        "author": "Stuart",
        "date": "2026",
        "notes": ["Open by contrasting single-agent search with adversarial settings."]
      },
      {
        "layout": "toc",
        "title": "Agenda",
        "entries": ["Core Concepts", "Minimax Algorithm", "Alpha-Beta Pruning", "Practical Applications"],
        "notes": ["Walk through the roadmap before diving in."]
      },
      {
        "layout": "section_divider",
        "title": "Core Concepts",
        "sectionNumber": 1,
        "notes": ["Use this as a transition slide."]
      },
      {
        "layout": "content",
        "contentSubtype": "text_heavy",
        "title": "Minimax assumptions",
        "bullets": [
          "Two-player, zero-sum setting",
          "Perfect information",
          "Both sides act optimally"
        ],
        "notes": ["Emphasize why these assumptions matter for exam questions."]
      },
      {
        "layout": "content",
        "contentSubtype": "comparison",
        "title": "Minimax vs Alpha-Beta",
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
        "layout": "content",
        "contentSubtype": "image_showcase",
        "title": "Game-tree pruning pattern",
        "svg": "<svg viewBox=\"0 0 640 360\">...</svg>",
        "caption": "Alpha-beta can prune branches that cannot affect the minimax decision.",
        "notes": ["Keep labels short so the visual remains legible at slide distance."]
      },
      {
        "layout": "summary",
        "title": "Key Takeaways",
        "bullets": [
          "Minimax guarantees optimal play in zero-sum games",
          "Alpha-beta pruning preserves optimality while reducing computation",
          "Move ordering is critical for pruning efficiency"
        ],
        "notes": ["Recap the three big ideas before Q&A."]
      }
    ]
  }
}
```

## Design system guidance

### Color palettes

Choose the palette that best fits the topic and audience, or use the design-advisor worker brief if available:

| Palette | Primary | Secondary | Accent | Best for |
|---|---|---|---|---|
| **Professional** | `#2c3e50` | `#34495e` | `#3498db` | Business, corporate, formal |
| **Academic** | `#296767` | `#1a4040` | `#4ecdc4` | Lectures, research, education |
| **Creative** | `#6c5ce7` | `#a29bfe` | `#fd79a8` | Design, arts, brainstorming |
| **Minimal** | `#2d3436` | `#636e72` | `#00b894` | Technical, engineering, data |
| **Warm** | `#d35400` | `#e67e22` | `#f39c12` | Marketing, storytelling, pitches |
| **Bold** | `#e74c3c` | `#c0392b` | `#f1c40f` | Impact presentations, calls to action |

### Font pairings

| Heading | Body | Style |
|---|---|---|
| Montserrat | Open Sans | Modern, clean |
| Playfair Display | Source Sans Pro | Elegant, academic |
| Poppins | Inter | Friendly, contemporary |
| Roboto Slab | Roboto | Technical, precise |
| Raleway | Lato | Light, airy |

### Typography scale

- Slide titles: bold, 28-36pt equivalent
- Subtitles and section labels: semibold, 20-24pt
- Body bullets: regular, 18-22pt
- Captions and notes: regular, 14-16pt
- Keep line count per slide to 6-8 lines maximum

## Notes field

- `notes` is an array of presenter-note strings.
- Use notes for teaching reminders, emphasis, examples, or cautions that should not clutter the slide itself.
- Keep notes concrete and brief.

## Deck design rules

- One main idea per slide.
- Use `section_divider` slides for major transitions.
- Never use 3+ identical layouts in a row — vary between text, comparison, table, and diagram slides.
- Prefer `comparison`, `table`, and `diagram` when they teach better than bullet walls.
- Keep bullets concise and parallel.
- Include citations in the top-level `citations` array for course-specific content.
- End with a `summary` slide, optionally followed by `sources`.
- Start every deck with a `cover` slide, followed by `toc` for decks with 8+ slides.

## Math and notation rules

- For inline math in slide titles, bullets, table cells, and notes, wrap the notation in `$...$`.
- Examples:
  - `"title": "Simplex update: $x_1$ enters"`
  - `"bullets": ["Constraint: $x_1 + 2x_2 \\leq 6$", "Complexity: $O(n^2)$"]`
  - `"rows": [["Variable", "$x_1$"], ["Objective", "$z = 3x_1 + 2x_2$"]]`
- Use `\\alpha`, `\\beta`, `\\sum`, `\\leq`, subscripts like `_1`, and superscripts like `^2` inside those delimiters.
- Do not emit bare math-like text such as `x1 + 2x2 <= 6` when the content is mathematical.
- For equation-heavy slides, keep the core formula in a title, bullet, or table cell with `$...$`, then use notes to explain variables, assumptions, or derivation steps without crowding the slide surface.
- Prefer `table` or `comparison` layouts when the comparison or derivation is clearer as structured math than as bullet prose.
- Use `diagram` when the student needs a real visual: search trees, simplex geometry, circuit diagrams, annotated coordinate plots, or rendered equation figures.

## Good deck patterns

- cover -> toc -> section_divider -> concept slides -> comparison/table slides -> summary -> sources
- Lecture recap decks with section dividers between topics
- Worked-example decks with timeline and data_viz slides
- Revision decks with clear concept progression and comparison slides

## What to avoid

- Giant bullet walls (more than 6 bullets per slide)
- Repeating the same idea across multiple content slides
- Three or more identical slide layouts in a row
- Decorative filler slides
- Unsupported claims beyond the workspace
- Slide text that reads like essay prose
- Missing cover or summary slides

## Final self-check

Before returning, verify:

- exactly one `document_pptx` payload
- valid JSON
- at least one slide
- deck starts with a `cover` slide
- deck ends with `summary` and/or `sources`
- every slide uses a supported layout
- no 3+ identical layouts in a row
- `contentSubtype` is set for `content` layout slides
- `diagram` slides include valid raw `<svg>...</svg>` markup when used
- `table` slides have matching headers/row widths
- content slides stay concise (max 6-8 bullet points)
- citations array is populated for grounded factual decks
- `sectionNumber` is set on `section_divider` and `toc` slides
