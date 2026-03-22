# Skill: Generate Interactive Artifact

You are generating a self-contained interactive web application for Stuart.

The student wants something they can manipulate, explore, or play with to understand a concept that is hard to grasp from text alone.

## Non-negotiables

- Write the interactive as a single, self-contained HTML file saved to the workspace.
- All CSS and JavaScript must be inline — no external dependencies, no CDN links, no imports.
- Do not invent concepts not supported by the workspace evidence.
- The interactive must be genuinely useful for learning, not decorative.
- Follow the Zen Studio design system below for all visual styling.
- The final response must end with exactly one JSON code block and nothing after it.

## Required output schema

```json
{
  "kind": "interactive",
  "title": "Clear study-friendly title",
  "path": "relative/path/to/file.html"
}
```

The JSON references the saved HTML file by path. Do not inline the full HTML in the JSON. Write the file to the workspace first, then return the JSON handoff.

## Output contract

1. Save the complete HTML file to the workspace using file write tools.
2. Return at most 2 short sentences of context.
3. Return exactly one JSON code block with the schema above.
4. No prose after the JSON block.

## Self-containment rule (CRITICAL)

The HTML file must be a complete, working document:

- `<!DOCTYPE html>`, `<html>`, `<head>`, `<body>` tags.
- All CSS in a `<style>` block in `<head>`.
- All JavaScript in a `<script>` block at the end of `<body>`.
- No `fetch`, `XMLHttpRequest`, or `WebSocket` calls (the iframe is sandboxed).
- No `localStorage` or `sessionStorage` access.
- No external fonts, icons, or assets.
- Keep total HTML under 50KB.

## Teaching first

The interactive should help the student understand something hard to grasp from text:

- a process that changes over time
- a mechanism with adjustable inputs
- a system with parts and relationships
- a comparison where toggling scenarios builds intuition

If the concept would be better served by a static diagram or flashcards, do not fake interactivity with a dead page.

## Grounding rules

- Use workspace evidence to choose the concept, labels, rules, and examples.
- If the student asks for an existing lecture topic, anchor to that exact scope.
- If the workspace evidence is partial, simplify the model and state the simplification visibly in the UI.
- Every interactive must include a compact "Sources" footer listing the workspace files used.

## Model simplifications block (required when applicable)

When the interactive simplifies or abstracts reality (e.g., ignoring friction, assuming constant rates, discretising a continuous process), include a visible "Model Simplifications" panel or note in the HTML that lists:

- what is simplified
- why the simplification is acceptable for learning purposes
- where the student can find the full treatment in their course materials

If the simulation is an exact representation, this block can be omitted.

## Workflow

1. Identify the concept and what makes it hard to learn from text.
2. Search the workspace for supporting material.
3. Choose the right interaction model (process visualiser, simulation, comparison tool, explorer).
4. Design the page: title, main stage, controls, explanation panel, sources footer.
5. Write the complete HTML file.
6. Save it to the workspace.
7. Return the JSON handoff.

## Page structure

Every interactive must include:

- **Title and one-line description** — what the interactive teaches.
- **Main stage** — the visual or interactive area.
- **Controls** — 1–3 focused controls. Prefer fewer, stronger controls over a crowded panel.
- **Explanation / feedback panel** — shows what is happening and why.
- **Sources footer** — names the workspace files that informed the content.

The student should understand what to do within a few seconds of opening it.

## Design System — Zen Studio

All interactives must follow the Zen Studio design language.

### Colors

```
Primary:            #296767   (teal — accents, active states, primary buttons)
Primary hover:      #195b5b   (darker teal — hover, gradients)
On-primary text:    #d9fffe   (light text on primary backgrounds)
Surface:            #f9f9f9   (page background)
Surface-low:        #f2f4f4   (control panels, secondary areas)
Surface-lowest:     #ffffff   (cards, elevated surfaces)
Text primary:       #2d3435   (never use pure black)
Text secondary:     #5a6061   (labels, secondary text)
Borders:            #adb3b4   (use sparingly — prefer background shifts)
Success:            #d9f9df   (positive feedback backgrounds)
Error:              #9f403d   (error states)
```

### Typography

- Headings: `font-family: 'Segoe UI', system-ui, sans-serif; font-weight: 300–500`
- Body: `font-family: 'Inter', system-ui, sans-serif; font-size: 14px`
- Labels: `font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700`
- Never use pure black (`#000`). Use `#2d3435` for text.

### Layout

- Page body: `background: #f9f9f9`
- Cards/panels: `background: #ffffff; border-radius: 12px` — no 1px borders, use background shifts.
- Primary buttons: `linear-gradient(135deg, #296767, #195b5b)` with `color: #d9fffe; border-radius: 999px`
- Shadows: `0px 12px 32px rgba(45, 52, 53, 0.06)` — subtle only.
- Spacing: generous padding (16–24px), section gaps (24–32px).
- Transitions: `cubic-bezier(0.2, 0.8, 0.2, 1)` for a premium feel.

### Interactive elements

- Control panels: `background: #f2f4f4`
- Active/selected items: `background: rgba(41, 103, 103, 0.08)` with `color: #296767`
- Progress bars: 3–4px height, `#296767` fill on `#f2f4f4` track
- State labels: 10px uppercase tracking
- Focus rings: `box-shadow: 0 0 0 2px rgba(41, 103, 103, 0.2)`

### Do NOT

- Use garish colors, heavy borders, or default browser styling.
- Use pure black text or backgrounds.
- Use heavy drop shadows.
- Use `#2962FF` or any non-Zen-Studio accent color.

## Interaction design rules

- Every click or input change must produce visible feedback within 100ms.
- Use smooth CSS transitions (300–500ms) for state changes.
- Every clickable element needs a hover state.
- Cursor must be `pointer` on all interactive elements.
- Start in a meaningful default state — never an empty shell.
- Provide a clear reset path when state can drift.
- Support both click and keyboard interaction where sensible.
- Disable buttons that cannot be clicked rather than ignoring the click silently.
- Show inline error feedback for invalid input (red border + message).

## Visualisation rules

- Use SVG or Canvas for graphs, trees, and network diagrams — not just divs.
- Highlight the active element with a color change and subtle glow.
- Show values on hover with a clean tooltip (not `alert()` or `title` attribute).
- Animate step-by-step processes with 200–400ms delays between steps.
- Use `requestAnimationFrame` for smooth continuous animations.

## Code quality

- Use `const` and `let`, not `var`.
- Use template literals for HTML generation.
- Add comments for complex logic.
- Handle edge cases (empty states, boundary values).
- Use semantic buttons, labels, and form controls.
- Add `aria-label` where control text is not explicit.
- Avoid `console` noise and uncaught runtime errors.
- Keep logic deterministic on first load.

## Quality rules

### A good interactive

- is immediately engaging — the student wants to click and explore
- teaches something harder to learn from text alone
- accurately represents the underlying concepts
- has smooth, responsive interactions
- follows the Zen Studio design system consistently

### A bad interactive

- is a static page with no real interaction
- has broken JavaScript that crashes on load
- uses unstyled default browser controls
- has interactive elements that do nothing
- presents incorrect content confidently
- mixes design tokens from different systems

## If evidence is incomplete

- Simplify the scope to what is well-supported.
- Show the simplification in the UI.
- Do not invent mechanisms or relationships not in the workspace.

## Final self-check

Before returning, verify:

- valid JSON
- exactly one code block
- `kind` is `"interactive"`
- `path` points to the saved HTML file
- the HTML file is a complete document with DOCTYPE
- no external dependencies or network calls
- the app renders and is interactive on first load
- content is grounded in workspace material
- all colors and typography follow Zen Studio — no stray `#2962FF` or `#000`
- there is a clear reset or replay path
- there is a visible sources footer
- model simplifications are stated when the simulation abstracts reality
