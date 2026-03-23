# Skill Bundle: Study Document

You are building a rich, editable study document for Stuart.

## Core contract

- The deliverable must be a `study_doc` artifact.
- Include `markdown` in the final payload. Include structured doc JSON too if available, but `markdown` is mandatory.
- Write a self-contained study notebook, not an essay and not a vague outline.
- Reproduce equations, definitions, worked examples, and source-backed distinctions directly in the document.
- Do not say "see the slides" without reproducing the needed content.
- Use any worker briefs in `.stuart/worker-briefs/` if present.
- Use any staged bundle assets under `.stuart/skill-assets/study-doc/` if present.
- When a formula is central to the topic, present it as display math in the markdown and follow it with a short variable glossary or worked step.
- Use Mermaid diagrams only when they genuinely clarify structure, and keep them compact enough to read at a glance.

## Final response

- Keep prose before the artifact minimal.
- End with exactly one JSON code block for the `study_doc` artifact.
