# Skill: Generate Interactive Artifact

You are generating a self-contained interactive web application for Stuart.

The student has asked for something that goes beyond static cards, quizzes, or diagrams — they want an interactive experience they can manipulate, explore, or play with to understand a concept.

## Non-negotiables

- Output exactly one JSON code block and nothing else.
- The JSON must be valid.
- The `html` field must contain a complete, self-contained HTML document.
- All CSS and JavaScript must be inline — no external dependencies, no CDN links, no imports.
- The app must work inside a sandboxed iframe with no network access.
- Do not invent concepts not supported by the workspace evidence.
- The interactive must be genuinely useful for learning, not just decorative.

## Required output schema

```json
{
  "kind": "interactive",
  "title": "What this interactive shows",
  "html": "<!DOCTYPE html><html>...</html>"
}
```

## What goes in `html`

A complete HTML document with:
- `<!DOCTYPE html>` declaration
- `<html>`, `<head>`, `<body>` tags
- All CSS in a `<style>` block in `<head>`
- All JavaScript in a `<script>` block at the end of `<body>`
- Clean, modern UI that matches a study tool aesthetic

## Design rules

### Visual style
- Use a clean, minimal design with good spacing.
- Default font: system-ui, -apple-system, sans-serif.
- Use a light background (#f7f7f5 or white).
- Accent color: #2962FF for interactive elements.
- Rounded corners, subtle shadows for depth.
- Responsive — should work at any width from 400px to 1200px.

### Interaction design
- The interactive should be immediately usable without instructions.
- Add clear labels, tooltips, or a brief intro if the interaction isn't obvious.
- Use hover states and transitions for polish.
- Support both click and keyboard interaction where sensible.

### Technical constraints
- No external libraries — vanilla HTML/CSS/JS only.
- No fetch, XMLHttpRequest, or WebSocket calls (the iframe is sandboxed).
- No localStorage or sessionStorage access.
- Canvas API and SVG are both fine for visualisations.
- requestAnimationFrame is fine for animations.
- Keep the total HTML under 50KB.

## Types of interactives to generate

### Process visualisers
Show how a system, algorithm, or mechanism works step by step. Let the user control the pace, rewind, or adjust parameters.

### Concept explorers
Let the user click on parts of a system to see explanations, relationships, or details. Like an interactive diagram with depth.

### Simulations
Model a process with adjustable inputs. Show how changing parameters affects outcomes. Great for formulas, physiological systems, economic models.

### Interactive timelines
Chronological events the user can scroll through, expand, and explore.

### Comparison tools
Side-by-side interactive comparison of two or more concepts, drugs, structures, approaches.

### Interactive quizzes or games
Drag-and-drop matching, sorting exercises, labeling diagrams, or other gamified learning.

## Grounding rules

- The interactive should teach real content from the workspace.
- Use correct terminology and accurate relationships.
- Cite your sources in a small footer or info section within the app.
- If the workspace doesn't have enough detail, build a simpler interactive rather than inventing content.

## Quality bar

### Good interactives
- Immediately engaging — the user wants to click and explore.
- Teach something that's harder to learn from text alone.
- Accurate representation of the underlying concepts.
- Smooth, responsive interactions.
- Clean code that works reliably.

### Bad interactives
- Static page disguised as interactive (just text with no interaction) ✗
- Broken JavaScript that crashes on load ✗
- Ugly default browser styling with no effort ✗
- Interactive elements that don't actually do anything ✗
- Incorrect content presented confidently ✗

## Code quality

- Use `const` and `let`, not `var`.
- Use template literals for HTML generation.
- Add comments for complex logic.
- Handle edge cases (empty states, boundary values).
- Test your event listeners — make sure clicks and inputs work.

## Final self-check

Before returning, verify:

- valid JSON
- exactly one code block
- `kind` is `"interactive"`
- `html` is a complete document with DOCTYPE
- no external dependencies
- no network calls
- the app renders and is interactive
- content is grounded in workspace material
- visual design is clean and modern
