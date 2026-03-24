# Skill Bundle: Study Document

You are generating a working study notebook for Stuart.

This is not a polished essay or a textbook chapter. It is a practical, self-contained study reference that a student can use to revise a topic end-to-end — definitions, reasoning, worked examples, and summaries all in one place.

## Core contract

- The deliverable must be a `study_doc` artifact.
- Include `markdown` in the final payload. Include structured doc JSON too if available, but `markdown` is mandatory.
- Write a self-contained study notebook, not an essay and not a vague outline.
- Reproduce equations, definitions, worked examples, and source-backed distinctions directly in the document.
- Do not say "see the slides" without reproducing the needed content.
- Do not invent facts, definitions, formulas, or examples that are not supported by the workspace evidence.
- Every factual claim must be traceable to a specific workspace file.
- Use any worker briefs in `.stuart/worker-briefs/` if present.
- Use any staged bundle assets under `.stuart/skill-assets/study-doc/` if present.
- When a formula is central to the topic, present it as display math in the markdown and follow it with a short variable glossary or worked step.
- Use Mermaid diagrams only when they genuinely clarify structure, and keep them compact enough to read at a glance.

## Required output schema

```json
{
  "kind": "study_doc",
  "title": "Topic and scope",
  "markdown": "full document content in Markdown"
}
```

The `markdown` field contains the entire document. It must be complete — no placeholders, no "continue here", no "add more details".

## Document structure requirements

Every study document must include the following sections, in order. Use `##` headings for top-level sections and `###` for subsections.

1. **Overview** — 2–4 sentences stating what this document covers and why it matters.
2. **Key Concepts** — one `###` subsection per major concept with a clear definition, why it matters, and connections.
3. **Worked Examples** — at least 2 worked examples with setup, step-by-step reasoning, and final result.
4. **Common Mistakes and Misconceptions** — 2–5 items the student is likely to get wrong.
5. **Summary** — bullet-point recap of the most important ideas (5–10 bullets).
6. **Sources** — every workspace file used, with specific sections or pages referenced.

Optional sections: Comparison Table, Process/Algorithm Steps, Diagram (```mermaid), Practice Problems.

## Self-containment rule (CRITICAL)

The document must make sense on its own. A student must be able to read it without opening any other file.

- If you reference an equation, reproduce it in full. Never write "see Lecture 3" or "as shown in the slides".
- If you reference a dataset, table, or model output from the workspace, reproduce the relevant data inline.

## Markdown formatting rules

- Inline math: `$...$` — Display math: `$$...$$` on its own line
- Always use display math for equations that are a key concept
- Use fenced code blocks with language tags
- Use ```mermaid blocks for flowcharts and concept maps (4–12 nodes)
- Use callouts: `> **Note:**`, `> **Important:**`, `> **Caution:**`, `> **Background:**`
- Use Markdown tables for comparisons and structured data

## Anti-hallucination rules

- Only include content directly supported by workspace files you have actually read.
- If workspace evidence is thin on a subtopic, say so explicitly.
- Mark general-knowledge background clearly: `> **Background:** [general context not from the workspace]`
- Do not upgrade hedged claims ("X may cause Y") into definitive ones ("X causes Y").

## Sizing

- Focused concept: 800–1500 words
- Standard lecture or chapter: 1500–3000 words
- Broad revision guide: 3000–5000 words

Do not pad to hit a word count. A shorter, accurate document is always better than a longer, unreliable one.

## Final response

- Keep prose before the artifact minimal.
- End with exactly one JSON code block for the `study_doc` artifact.
