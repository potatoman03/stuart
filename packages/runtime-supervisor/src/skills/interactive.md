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
- Build a real teaching surface: controls, a live visual/state area, and a compact explanation or feedback area.

## Required output schema

```json
{
  "kind": "interactive",
  "title": "What this interactive shows",
  "html": "<!DOCTYPE html><html>...</html>"
}
```

## Teaching first

The interactive should help the student understand something that is hard to grasp from text alone:

- a process that changes over time
- a mechanism with adjustable inputs
- a system with parts and relationships
- a comparison where the student benefits from toggling scenarios

If the concept would be better served by a static diagram or flashcards, do not fake interactivity with a dead page.

## What goes in `html`

A complete HTML document with:
- `<!DOCTYPE html>` declaration
- `<html>`, `<head>`, `<body>` tags
- All CSS in a `<style>` block in `<head>`
- All JavaScript in a `<script>` block at the end of `<body>`
- Clean, modern UI that matches a study tool aesthetic

### Recommended page structure

Include all of these when they make sense:

- a short title and one-line explanation of what the interactive teaches
- a main stage or visual area
- controls for changing inputs or stepping through the process
- a compact explanation, feedback, or observation panel
- a small sources footer or evidence panel

The student should be able to understand what to do within a few seconds of opening it.

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
- Include a clear reset path when the state can drift or get messy.
- Start in a meaningful default state instead of an empty shell.
- Prefer 1 to 3 strong controls over a crowded control panel.

### Technical constraints
- No external libraries — vanilla HTML/CSS/JS only.
- No fetch, XMLHttpRequest, or WebSocket calls (the iframe is sandboxed).
- No localStorage or sessionStorage access.
- Canvas API and SVG are both fine for visualisations.
- requestAnimationFrame is fine for animations.
- Keep the total HTML under 50KB.
- Avoid console noise and uncaught runtime errors.
- Keep logic deterministic on first load; do not require hidden async initialization.

## Evidence use

- Use workspace evidence to choose the concept, labels, rules, and examples.
- If the student asks for an existing lecture/topic, anchor the interactive to that exact scope.
- If the workspace evidence is partial, simplify the model and state the simplification in the UI.
- Add a compact "Sources" or "Grounding" area in the app that names the files used.

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
- Use semantic buttons, labels, and form controls.
- Add `aria-label` where the control text is not explicit.
- Keep text selectable and readable; do not bury explanations in canvas-only rendering.

## Final deliverable shape

The generated app should usually contain:

- a visible teaching title
- one focused interaction model
- one or more controls
- one live explanation or feedback region
- a small evidence footer

Do not return a landing page, essay page, or static infographic disguised as an app.

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
- there is a clear reset or replay path
- there is a visible evidence/footer area
