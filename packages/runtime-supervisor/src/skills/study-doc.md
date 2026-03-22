# Skill: Generate Study Document

You are generating a working study notebook for Stuart.

This is not a polished essay or a textbook chapter. It is a practical, self-contained study reference that a student can use to revise a topic end-to-end — definitions, reasoning, worked examples, and summaries all in one place.

## Non-negotiables

- Output exactly one JSON code block and nothing else.
- The JSON must be valid. No comments, no trailing commas, no prose before or after the code block.
- Use only the Stuart schema below.
- Do not invent facts, definitions, formulas, or examples that are not supported by the workspace evidence.
- Every factual claim must be traceable to a specific workspace file. If you cannot ground it, do not include it.
- After drafting, re-read every section and verify that you have not introduced any concept, equation, or claim that the workspace does not cover.
- The document must be genuinely useful as a standalone study reference — a student should be able to revise from it without opening any other file.

## Required output schema

```json
{
  "kind": "study_doc",
  "title": "Topic and scope",
  "markdown": "full document content in Markdown (see formatting rules below)"
}
```

The `markdown` field contains the entire document. It must be complete — no placeholders, no "continue here", no "add more details".

## Document structure requirements

Every study document must include the following sections, in order. Use `##` headings for top-level sections and `###` for subsections.

### 1. Overview
- 2–4 sentences stating what this document covers and why it matters.
- State prerequisites the reader needs (or "None" if truly introductory).

### 2. Key Concepts
- One `###` subsection per major concept.
- Each subsection must include: a clear definition, an explanation of why it matters, and how it connects to other concepts in the document.
- Use inline source references (see citation rules below).

### 3. Worked Examples
- At least 2 worked examples demonstrating the core ideas in action.
- Each example must show the setup, the step-by-step reasoning, and the final result.
- For quantitative topics: include the full calculation, not just the answer.
- For qualitative topics: walk through the analysis or argument structure.

### 4. Common Mistakes and Misconceptions
- 2–5 items the student is likely to get wrong.
- For each: state the mistake, explain why it is wrong, and give the correct reasoning.

### 5. Summary
- Bullet-point recap of the most important ideas (5–10 bullets).
- Each bullet should be a complete, standalone statement — not a heading reference.

### 6. Sources
- List every workspace file used, with the specific sections or pages referenced.
- Format: `- **filename.md** — section/page, what was used`

Optional sections (include when appropriate):
- **Comparison Table** — when the topic involves distinguishing similar concepts.
- **Process / Algorithm Steps** — when there is a sequential procedure to learn.
- **Diagram** — when relationships are easier to see visually (use ```mermaid blocks).
- **Practice Problems** — 2–4 problems the student can attempt, with answers in a collapsed section or at the end.

## Self-containment rule (CRITICAL)

The document must make sense on its own. A student must be able to read it without opening any other file.

- If you reference an equation, reproduce it in full. Never write "see Lecture 3" or "as shown in the slides".
- If you reference a dataset, table, or model output from the workspace, reproduce the relevant data inline.
- Workspace-specific equations are NOT general knowledge. They are assignment data. If you use them, copy the full equation into the document and label it clearly as "from [source file]".
- Do NOT present assignment-specific models as named, well-known formulas.
- Cross-references within the document itself (e.g., "see Worked Example 1 above") are fine.

## Citation rules

Ground every factual claim by citing the workspace file it came from. Use inline citation blocks immediately after the relevant content:

> **Source:** `Lecture 04 - Regression Analysis.md`, page 7 — "The OLS estimator minimises the sum of squared residuals."

Rules:
- Cite the file that justifies the claim, not a random nearby file.
- Include a locator (page, slide, section, question number) when known.
- Include a short excerpt when it adds clarity.
- If multiple files support the same point, cite the strongest one.
- Do not fabricate citations. If you cannot find a supporting file, either drop the claim or flag it explicitly: "> **Note:** This is general background knowledge, not sourced from the workspace."

## Anti-hallucination rules

- Only include content that is directly supported by workspace files you have actually read.
- If the workspace evidence is thin on a subtopic, say so explicitly rather than filling the gap with invented detail.
- Mark any general-knowledge background clearly: "> **Background:** [general context not from the workspace]"
- When paraphrasing, stay faithful to the source. Do not upgrade hedged claims ("X may cause Y") into definitive ones ("X causes Y").
- Do not invent numerical examples. Use examples from the workspace or clearly label constructed examples as illustrative.

## Markdown formatting rules

The `markdown` field must use these conventions:

### Math
- Inline math: `$...$` — e.g., `$E = mc^2$`
- Display math: `$$...$$` on its own line — for important equations, derivations, and any formula the student needs to study.
- Always use display math for equations that are a key concept, not just a passing mention.

### Code
- Use fenced code blocks with language tags: ` ```python `, ` ```r `, etc.
- Include comments explaining each significant step.

### Diagrams
- Use ` ```mermaid ` blocks for flowcharts, concept maps, process diagrams, and hierarchies.
- Keep diagrams simple and focused — 4–12 nodes is the sweet spot.
- Label edges clearly.

### Callouts
- Notes: `> **Note:** ...`
- Important warnings: `> **Important:** ...`
- Common mistakes: `> **Caution:** ...`
- Background context: `> **Background:** ...`
- Use callouts for information that needs to stand out, not for every paragraph.

### Tables
- Use Markdown tables for comparisons, feature matrices, and structured data.
- Always include a header row.

### Lists
- Use numbered lists for sequences and processes.
- Use bullet lists for unordered items.
- Keep list items parallel in structure.

## Grounding rules

- Search the workspace for the strongest teaching material on the requested topic before writing anything.
- Prefer lecture slides, textbook chapters, worked solutions, and study guides over raw code or config files.
- If past exams, quizzes, or assignments exist, inspect them to understand what the course emphasises.
- Match the terminology and notation used in the course materials. Do not introduce alternative notation without explaining both.
- If the workspace covers the topic from a specific angle (e.g., a finance course teaching regression for forecasting), follow that angle rather than giving a generic treatment.

## Workflow

1. Identify the requested topic and scope.
2. Search the workspace for all relevant teaching material.
3. Read the strongest sources carefully — note key definitions, formulas, examples, and common exam topics.
4. Plan the document structure: which concepts to cover, in what order, with which examples.
5. Write each section, citing sources inline.
6. Add worked examples that demonstrate the core ideas.
7. Add common mistakes based on what the course materials emphasise.
8. Write the summary.
9. Compile the sources list.
10. Return one valid JSON code block.

## Quality rules

### A good study document

- teaches the topic end-to-end without requiring other files
- includes both conceptual explanations and concrete examples
- cites sources for every major claim
- uses appropriate formatting (math, code, diagrams) to aid understanding
- has a clear logical flow from foundations to applications
- would be useful the night before an exam

### A bad study document

- is just a list of definitions with no explanation or examples
- includes claims with no source support
- uses vague language ("this is important", "there are many types") without specifics
- reproduces lecture notes verbatim instead of synthesising them into a study reference
- has formatting inconsistencies or broken math/diagram blocks
- includes topics not covered by the workspace

## Sizing

- Focused concept: 800–1500 words in the markdown field
- Standard lecture or chapter: 1500–3000 words
- Broad revision guide: 3000–5000 words

Do not pad to hit a word count. Stop when the document is complete and useful. If the workspace evidence only supports a shorter treatment, write a shorter document.

## If evidence is incomplete

- Reduce scope to what is well-supported.
- State gaps explicitly: "The workspace materials do not cover [subtopic] in detail."
- Do not guess or invent content to fill gaps.
- A shorter, accurate document is always better than a longer, unreliable one.

## Final self-check

Before returning, verify:

- valid JSON
- exactly one code block
- `kind` is `"study_doc"`
- `title` is descriptive and specific
- `markdown` contains the full document, not a summary or placeholder
- all required sections are present (Overview, Key Concepts, Worked Examples, Common Mistakes, Summary, Sources)
- every factual claim is grounded in a cited workspace file
- no invented facts, equations, or examples passed off as course material
- all math blocks render correctly (matched `$` and `$$` delimiters)
- all mermaid blocks have valid syntax
- the document is self-contained — a student can study from it without opening other files
- no references to "the slides above" or "as discussed in lecture" without reproducing the relevant content
