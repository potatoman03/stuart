# Skill: Generate Interactive Artifact

You are generating a self-contained interactive web application for Stuart.

The student has asked for something that goes beyond static cards, quizzes, or diagrams — they want an interactive experience they can manipulate, explore, or play with to understand a concept.

## IMPORTANT: Design instructions

**You MUST follow the design system and interaction rules below.** These are Stuart-specific requirements that override any generic defaults. Read them carefully before writing any HTML, JSX, or TSX.

## Non-negotiables

- Write the interactive as a self-contained HTML file in the workspace.
- All CSS and JavaScript must be inline — no external dependencies, no CDN links, no imports.
- Do not invent concepts not supported by the workspace evidence.
- The interactive must be genuinely useful for learning, not just decorative.
- Build a real teaching surface: controls, a live visual/state area, and a compact explanation or feedback area.
- **Follow the Zen Studio design system below** for all colors, typography, spacing, and interaction patterns.
- The final response must end with exactly one JSON code block and nothing after it.
- The JSON must be shaped like `{ "kind": "interactive", "title": "...", "path": "relative/path.html" }`.
- Do not stop at a prose summary plus a filename or markdown link. The JSON handoff is required.

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
- Support both click and keyboard interaction where sensible.
- Include a clear reset path when the state can drift or get messy.
- Start in a meaningful default state instead of an empty shell.
- Prefer 1 to 3 strong controls over a crowded control panel.

### Visual feedback — CRITICAL
Every interaction must produce visible, satisfying feedback. Without this the app feels dead.

**State changes:**
- When the user clicks a button or changes an input, something must visibly change within 100ms.
- Use smooth CSS transitions (300-500ms, `cubic-bezier(0.2, 0.8, 0.2, 1)`) for all state changes.
- Animate values changing: counters should count up/down, not jump. Bars should slide, not snap.

**Hover states:**
- Every clickable element needs a hover state (background shift, subtle scale, or color change).
- Use `transform: scale(1.02)` or `background` shift on hover — subtle but noticeable.
- Cursor must be `pointer` on all interactive elements.

**Active/selected states:**
- Selected items should be visually distinct: use `background: rgba(41, 103, 103, 0.08)` + `border-left: 3px solid #296767` or similar.
- Use `box-shadow: 0 0 0 2px rgba(41, 103, 103, 0.2)` for focus rings.

**Animations for processes:**
- Step-by-step algorithms: animate each step with a delay (200-400ms between steps).
- Use `requestAnimationFrame` for smooth continuous animations.
- Node/graph highlights should fade in/out, not blink.
- Moving elements should use `transition: transform 400ms cubic-bezier(0.2, 0.8, 0.2, 1)`.

**Data visualisation:**
- Use SVG or Canvas for graphs, trees, and network visualisations — not just divs.
- Nodes should be circles or rounded rects with labels inside or beside them.
- Edges should be smooth lines or curves, not jagged.
- Highlight the current/active element with a color change + subtle glow (`box-shadow` or SVG filter).
- Show values on hover with a clean tooltip (not `alert()` or `title` attribute).

**Progress and scoring:**
- Use animated progress bars (width transition) to show completion.
- Show step counts with the label style: `STEP 3 OF 8` in small caps.
- Score/result animations: count up to the final number, don't just show it.

**Controls:**
- Sliders: use `<input type="range">` styled with the primary color for the track fill.
- Buttons: use the primary gradient for the main action, surface colors for secondary.
- Step controls (prev/next): use arrow icons, not text links.
- Speed controls: offer at least slow/normal/fast for animations.
- All controls should have visible labels — no icon-only buttons without tooltips.

**Empty/loading states:**
- Never show a blank screen. Start with a meaningful default (e.g., a pre-loaded graph, a starting configuration).
- If computation takes time, show a brief loading indicator.

**Error handling:**
- If the user enters invalid input, show inline feedback (red border + message), don't ignore silently.
- Prevent impossible states rather than handling them — disable buttons that can't be clicked.

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

## Response contract

Your final response should be:

1. At most 2 short sentences of context.
2. Exactly one JSON code block.
3. No prose after the JSON block.

Use this shape:

```json
{
  "kind": "interactive",
  "title": "Clear study-friendly title",
  "path": "relative/path/to/file.html"
}
```

If you created the HTML file, always hand it off with `path`. Do not inline the full HTML in the final answer unless the runtime explicitly asked for inline `html`.

## Design System — Zen Studio

All interactive artifacts must follow the Zen Studio design language. This ensures visual consistency with the rest of the app.

### Colors
```css
--primary: #296767;          /* teal — use for accents, active states, primary buttons */
--primary-dim: #195b5b;      /* darker teal — hover states, gradients */
--on-primary: #d9fffe;       /* light text on primary backgrounds */
--surface: #f9f9f9;          /* page background */
--surface-low: #f2f4f4;      /* secondary panels */
--surface-lowest: #ffffff;   /* cards, elevated surfaces */
--on-surface: #2d3435;       /* primary text — never use pure black */
--on-surface-variant: #5a6061; /* secondary text, labels */
--outline-variant: #adb3b4;  /* subtle borders (use sparingly, prefer bg shifts) */
--tertiary-container: #d9f9df; /* success/positive backgrounds */
--error: #9f403d;            /* error states */
```

### Typography
- Headings: `font-family: 'Segoe UI', system-ui, sans-serif; font-weight: 300-500`
- Body: `font-family: 'Inter', system-ui, sans-serif; font-size: 14px`
- Labels: `font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700`
- Never use pure black (#000). Use #2d3435 for text.

### Layout rules
- Use `background: #f9f9f9` for the page body
- Cards/panels: `background: #ffffff; border-radius: 12px` — no 1px borders, use background shifts
- Buttons: primary uses gradient `linear-gradient(135deg, #296767, #195b5b)` with `color: #d9fffe; border-radius: 999px`
- Shadows: `0px 12px 32px rgba(45, 52, 53, 0.06)` — subtle, not heavy
- Spacing: generous padding (16-24px), gaps between sections (24-32px)
- Transitions: use `cubic-bezier(0.2, 0.8, 0.2, 1)` for a premium feel

### Interactive-specific
- Control panels should be `background: #f2f4f4` (surface-low)
- Active/selected items: `background: rgba(41, 103, 103, 0.08)` with `color: #296767`
- Progress indicators: thin bars (3-4px) with `#296767` fill on `#f2f4f4` track
- State labels (step count, score, etc.): use the label style (10px uppercase tracking)
- Feedback/explanation area: `background: #ffffff; border-radius: 12px; padding: 16px`

### Do NOT
- Use garish colors, heavy borders, or default browser styling
- Use pure black text or backgrounds
- Use heavy drop shadows
- Use border-radius > 16px on non-pill elements

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
