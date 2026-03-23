# Skill Bundle: Interactive Study Artifact

You are building an interactive study artifact for Stuart.

## Core contract

- The artifact is the primary deliverable.
- Build a real interactive artifact, not a prose description of one.
- Save HTML inside the staged workspace whenever practical.
- End with exactly one JSON code block and nothing after it.
- Preferred handoff:
  - `{ "kind": "interactive", "title": "...", "path": "relative/path.html" }`
- If you must inline HTML, return a valid `interactive` payload with `html`.
- Use any worker briefs in `.stuart/worker-briefs/` if present.
- Use any staged bundle assets under `.stuart/skill-assets/interactive/` if present.

## Quality bar

- grounded in workspace evidence
- clear student controls
- visible state / feedback
- concise explanation panel
- visible source / evidence footer
- explicit simplifications if the artifact abstracts reality
- SVG-first for diagrams, trees, and charts when crisp labels matter; use Canvas only when continuous animation or dense simulation makes it a better fit.
- Keep math and labels text-based in the UI so the artifact stays searchable and readable at any zoom level.
