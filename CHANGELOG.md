# Changelog

All notable changes to Stuart will be documented in this file.

## 1.0.1 - 2026-04-01

Stuart 1.0.1 is the first release that feels like a coherent desktop study product rather than a collection of runtime experiments. The release tightens the learning loop in three areas: grounded answers with inline citations, a more deliberate Socratic teaching mode, and a cleaner workspace startup flow that makes the runtime and first-session behavior explicit.

### Grounded study flow

- Added inline citation handling across the main study UI so assistant answers can point back to local materials without dropping the student into raw file paths.
- Expanded the document preview pipeline for PDF and PowerPoint materials, including richer preview rendering and better source recovery for study context.
- Improved citation extraction, source matching, and citation-related test coverage so grounded responses are more reliable in normal use.
- Added a cleaner “copy without citations” path for assistant responses when students want the text itself without the source markers.

### Socratic teaching

- Added a turn-level Socratic tutoring policy that can ask for a rough guess, give progressively stronger hints, and only switch to direct explanation when the interaction calls for it.
- Tightened the teaching prompt so Socratic behavior is used where it helps learning, but not for administrative turns such as workspace summaries, orientation messages, or setup updates.
- Added dedicated unit and end-to-end coverage for the Socratic flow to reduce regressions in hinting, override handling, and response shaping.

### Onboarding and runtime setup

- Reworked workspace onboarding around a provider-first setup flow instead of immediately launching the same default session every time.
- Added explicit runtime selection for Codex, Gemini Native, and MiniMax Native, along with provider-specific model selection and setup readiness checks.
- Added two startup modes:
  - Guided start: Stuart reads the workspace, gives a concise overview, and asks where to focus.
  - Direct start: Stuart performs a quiet first pass and moves straight to the student’s first real question.
- Persisted workspace runtime preferences so task creation, session startup, and future turns can reuse the selected profile instead of guessing.

### Runtime orchestration

- Refactored model routing and worker spawning into a dedicated runtime-planning layer so turn effort, thread defaults, and explore/research swarms are easier to reason about and extend.
- Hardened the task/runtime schema so runtime profile intent is stored in the shared types, database layer, and staged workspace memory.
- Added diagnostics for Gemini and MiniMax native readiness in addition to the existing Codex checks, making setup state visible before session launch.

### Workspace and UI improvements

- Added project and session archiving flows so active workspaces stay cleaner without forcing permanent deletion.
- Continued the broader app shell and study UI overhaul for a more consistent desktop workflow.
- Improved desktop packaging and release handling for the notarized macOS build.

### Verification

- Added targeted runtime-planning tests alongside expanded teaching-prompt, citation, window-sizing, retrieval, and Socratic-runtime coverage.
- Rebuilt and notarized the macOS desktop artifacts for this release.
