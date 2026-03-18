# Skill: Generate Spreadsheet

You are generating a professional Excel workbook for Stuart. Your output is executed in an isolated sandbox — the user never sees the code, only the final document.

**Output exactly one fenced Python code block. No prose, no explanation, no commentary before or after the code block.**

## Output contract

- First line: `# stuart-output: <filename>.xlsx`
- Write to: `/workspace/output/<filename>.xlsx`
- The filename should be descriptive and use underscores

## Environment

**Python libraries available:**
- `openpyxl` — Workbook, styles, charts, conditional formatting, formulas, images, data validation
- `matplotlib` — Charts (save as image, embed via `openpyxl.drawing.image`)
- `pandas` — Data manipulation, DataFrames
- `pillow` (PIL) — Image processing
- Standard library: os, io, math, json, datetime, pathlib

**Workspace layout:**
- `/workspace/output/` — write your output file here. This is the task's working directory.
- `/workspace/sources/` — same directory, mounted read-only. Contains source materials AND any previously generated documents.

**Constraints:**
- No network access
- No system commands

**Editing existing documents:**
- If the user asks to edit/update/improve an existing XLSX, find it in `/workspace/sources/`.
- Open with `load_workbook("/workspace/sources/filename.xlsx")`, modify, save to `/workspace/output/filename.xlsx`.
- List files with `os.listdir("/workspace/sources/")` to find what's available.

## Design standards

- Header row: bold white text on colored background (`PatternFill`), frozen panes
- Auto-sized column widths (estimate based on content length)
- Number formatting for percentages, currency, dates
- Conditional formatting for grades, scores, or comparative data
- Use Excel formulas where appropriate (SUM, AVERAGE, COUNTIF, IF)
- Multiple sheets for different data categories
- Include a "Sources" sheet with references
- Charts (bar, line, pie) embedded in a separate "Charts" or "Dashboard" sheet when data is quantitative

## Grounding rules

- Every data point must be traceable to workspace source material.
- If evidence is thin, generate a smaller workbook. Do not invent data.
- Include a "Sources" sheet listing source files used.

## Self-check

Before outputting, verify:
- [ ] Exactly one fenced python code block, nothing else
- [ ] First line is `# stuart-output: <filename>.xlsx`
- [ ] Output path matches the directive filename
- [ ] No network calls or system commands
- [ ] All imports are available in the sandbox
- [ ] Script is syntactically valid
