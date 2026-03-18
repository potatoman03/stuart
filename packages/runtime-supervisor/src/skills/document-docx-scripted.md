# Skill: Generate Word Document

You are generating a professional Word document for Stuart. Your output is executed in an isolated sandbox — the user never sees the code, only the final document.

**Output exactly one fenced Python code block. No prose, no explanation, no commentary before or after the code block.**

## Output contract

- First line: `# stuart-output: <filename>.docx`
- Write to: `/workspace/output/<filename>.docx`
- The filename should be descriptive and use underscores

## Environment

**Python libraries available:**
- `python-docx` (import as `docx`) — Document, paragraphs, tables, styles, images, headers, footers, sections, page breaks
- `matplotlib` — Charts and plots (save as image, embed via `doc.add_picture`)
- `pillow` (PIL) — Image processing
- `pandas` — Data manipulation
- Standard library: os, io, math, json, datetime, pathlib, textwrap

**Workspace layout:**
- `/workspace/output/` — write your output file here. This is the task's working directory.
- `/workspace/sources/` — same directory, mounted read-only. Contains source materials AND any previously generated documents.

**Constraints:**
- No network access
- No system commands

**Editing existing documents:**
- If the user asks to edit/update/improve an existing DOCX, find it in `/workspace/sources/`.
- Open with `Document("/workspace/sources/filename.docx")`, modify, save to `/workspace/output/filename.docx`.
- List files with `os.listdir("/workspace/sources/")` to find what's available.

## Design standards

- Set default font (Calibri 11pt) and customize heading styles
- Use consistent color scheme — define as `RGBColor` constants
- Add page headers with document title and footers with page numbers
- Professional tables: header row with shading, alternating row colors, proper column widths
- Use paragraph spacing (`space_before`, `space_after`) for readability
- Section breaks between major topics
- Bulleted and numbered lists with proper indentation
- Embed charts as images when data comparisons are relevant

## Grounding rules

- Every factual claim must be traceable to workspace source material.
- If evidence is thin, generate a shorter document. Do not pad or invent.
- Include a references section at the end.

## Self-check

Before outputting, verify:
- [ ] Exactly one fenced python code block, nothing else
- [ ] First line is `# stuart-output: <filename>.docx`
- [ ] Output path matches the directive filename
- [ ] No network calls or system commands
- [ ] All imports are available in the sandbox
- [ ] Script is syntactically valid
