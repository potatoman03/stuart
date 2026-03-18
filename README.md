# Stuart

Stuart is a local-first study workspace built around staged local folders, Codex app-server turns, and persistent learning artifacts.

The repo is much closer to a Copal / Cowork-style runtime than to an upload-first notebook. A student picks a folder, Stuart stages that material into an isolated run, builds local retrieval support, and lets Codex work inside that staged workspace while the UI streams the turn back live.

If you only read one other doc, read [ARCHITECTURE.md](./ARCHITECTURE.md).

## Quick Start

Prerequisites: Node 22+, pnpm, [Codex CLI](https://github.com/openai/codex) (authenticated), Docker (optional, for sandbox document generation).

```bash
pnpm install
pnpm bootstrap   # creates .env, checks prerequisites
pnpm dev          # starts Vite client + Express server
```

Open `http://localhost:5173`, pick a study folder, and start chatting.

## What Stuart Is

Stuart is built around a few core nouns:

- `Project`: one local study folder on disk.
- `Task`: one study session attached to that project.
- `Task run`: one staged execution snapshot of the task scope.
- `Worker`: a subordinate agent with a narrower objective.
- `Ingestion index`: local retrieval, OCR, and preview support. Important, but not the product front door.
- `Study artifact`: a persisted flashcard deck, quiz, mind map, diagram, interactive draft, mock exam, or generated document (PDF, DOCX, XLSX, PPTX).

The important architectural stance is:

- workspace-first, not import-first
- one primary Codex thread per study session
- optional worker fanout for parallel exploration
- ingestion as support infrastructure, not as the main user abstraction

## Repo Map

```text
apps/
  web/                React client + local Express server
  desktop/            Electron shell and native folder picker

packages/
  runtime-supervisor/ Core runtime loop: staging, Codex turns, workers, ingestion
  harness/            HTTP + SSE transport around the runtime
  db/                 SQLite persistence and FTS-backed ingestion search
  shared/             Shared records, events, artifact schemas
  sandbox-executor/   Optional Docker-backed script sandbox for generated outputs
  plugin-sdk/         Plugin manifest and extension contracts
  guest-daemon/       Reserved runtime support package
  visuals/            Shared visual helpers

native/
  vm-helper/          Swift helper for local VM-related support

tests/
  tests/              Vitest coverage
  e2e/                Playwright browser coverage
```

Package-level docs:

- [apps/web/README.md](./apps/web/README.md)
- [packages/runtime-supervisor/README.md](./packages/runtime-supervisor/README.md)
- [packages/harness/README.md](./packages/harness/README.md)
- [packages/db/README.md](./packages/db/README.md)
- [packages/shared/README.md](./packages/shared/README.md)

## How It Works

1. The user selects a folder.
2. Stuart creates a `project` and a default `task` for that workspace.
3. `runtime-supervisor` prepares a staged `task run` under `.stuart-data/.../staging/<run-id>`.
4. Stuart builds a local ingestion index for search, previews, OCR, and workspace support.
5. Stuart resumes or starts a Codex app-server thread rooted at that staged workspace.
6. User messages start Codex turns with:
   - staged workspace access
   - optional retrieved context support
   - optional artifact skill prompts
7. Larger material sets can fan out into worker threads for parallel exploration.
8. Events stream back over SSE and the UI renders thinking state, assistant deltas, sources, workers, and artifacts.

The main runtime entry point is [packages/runtime-supervisor/src/index.ts](./packages/runtime-supervisor/src/index.ts). The app-server transport is [packages/runtime-supervisor/src/codex-app-server.ts](./packages/runtime-supervisor/src/codex-app-server.ts).

## Current Product Surface

What works today:

- local workspace selection
- staged study sessions backed by Codex app-server
- persistent tasks, runs, messages, workers, and artifacts in SQLite
- retrieval support over indexed local content
- previews for PDF, DOCX, XLSX, JSX, HTML, images, and text
- artifact generation for flashcards, quiz, mind map, diagram, interactive, mock exam, and document (PDF/DOCX/XLSX/PPTX) flows
- document generation via sandbox-executed scripts (reportlab, python-docx) or JSON-to-binary renderers (pdfkit, docx, pptxgenjs)
- research and curriculum builder: web search, repo cloning, article fetching, curated source files saved to workspace, phased learning plans
- auto-reindex after research turns so new materials are immediately available for study artifacts
- generated files (documents, research sources) sync to the project root folder
- web UI and Electron desktop shell

What Stuart is not trying to be:

- a pure upload-and-chat notebook
- a giant dashboard with separate planner, teacher, and artifact runtimes
- a system where ingestion completely replaces model-side file reasoning

## Requirements

Baseline:

- Node `22+`
- `pnpm`
- Codex CLI installed and available as `codex`, or overridden through `CODEX_BINARY_PATH`

Codex-specific prerequisites:

- Stuart launches `codex app-server` locally.
- That means the Codex CLI must already be installed on the machine before Stuart can run.
- The CLI must also already be authenticated, because Stuart does not handle the Codex sign-in flow itself.

Recommended install:

```bash
npm i -g @openai/codex
```

Recommended first-run auth check:

```bash
codex
```

On first run, Codex will prompt you to authenticate with either:

- your ChatGPT account
- or an API key

If Stuart cannot find an authenticated Codex CLI, `codex app-server` startup will fail and the study runtime will not come up correctly.

Helpful native tools:

- `swift`
  - used for the local PDF rendering path and native helper builds on macOS
- `tesseract`
  - used for OCR on images and OCR recovery paths
- `soffice`
  - used for DOCX to PDF conversion when richer visual extraction is needed
- Docker
  - used by `@stuart/sandbox-executor` for script-based document and artifact generation
  - Stuart will still boot without it, but sandboxed generation paths are disabled

macOS-specific behavior:

- the web server uses `osascript` for the native folder chooser route
- the desktop shell uses Electron’s native dialog flow
- the native VM helper is a Swift package that targets macOS `14+` and links Apple’s `Virtualization` framework

## Setup

Install dependencies:

```bash
pnpm install
```

Create and verify your local setup:

```bash
pnpm bootstrap
pnpm preflight
```

What those do:

- `pnpm bootstrap`
  - creates a local `.env` from [`.env.example`](./.env.example) if needed
  - runs a full prerequisite check
- `pnpm preflight`
  - validates Node, `pnpm`, Codex CLI, Codex auth, local data-dir access, and optional native tools
  - prints a terminal report before you launch the app

Reference environment values live in [`.env.example`](./.env.example):

```bash
PORT=8787
STUART_UI_PORT=5173
STUART_UI_HOST=127.0.0.1
STUART_DATA_DIR=.stuart-data
CODEX_BINARY_PATH=codex
STUART_VM_HELPER_BINARY_PATH=
STUART_INGESTION_CHUNK_TOKENS=380
STUART_INGESTION_OVERLAP_TOKENS=80
```

Important nuance:

- root `pnpm dev`, `pnpm dev:desktop`, `pnpm dev:harness`, `pnpm bootstrap`, and `pnpm preflight` all load `.env` automatically if it exists
- Codex authentication is separate from `.env`; Stuart expects the local Codex CLI to already be signed in
- `pnpm dev` skips the native VM helper build by default through `STUART_SKIP_VM_HELPER=1`
- the Docker sandbox is warmed non-blockingly; if Docker is unavailable, Stuart logs that sandboxed script generation is disabled
- the web UI shows an in-app system check card sourced from the same diagnostics layer as `pnpm preflight`

In practice, the normal technical-user path is:

```bash
pnpm install
pnpm bootstrap
pnpm dev
```

## Running Stuart

Web app:

```bash
pnpm dev
```

That starts:

- Vite client on `http://127.0.0.1:5173`
- local server on `http://127.0.0.1:8787`


Other useful entry points:

```bash
pnpm bootstrap
pnpm preflight
pnpm dev:harness
pnpm build
pnpm typecheck
pnpm test
pnpm test:e2e
```

## Runtime Notes

Codex integration:

- Stuart launches `codex app-server` over WebSockets.
- Each study session persists a main thread id.
- Model routing: Stuart selects the model and effort per turn based on what's needed:
  - **Main teaching thread**: `gpt-5.4-mini` (thread default)
  - **Research / curriculum turns**: `gpt-5.4` at `high` effort (flagship for deep reasoning + web search)
  - **Scripted document generation**: `gpt-5.4` at `high` effort (code gen needs flagship quality)
  - **Interactive artifact generation**: `gpt-5.4` at `high` effort (HTML/JS code gen)
  - **Simple Q&A** ("what is X"): `gpt-5.4-mini` at `low` effort
  - **Normal study turns**: `gpt-5.4-mini` at `medium` effort
  - **Explorer workers** (parallel file scanning): `gpt-5.4-mini` at `medium` effort
- Skill matching is regex-based as a boost: when matched, detailed skill prompts are injected as turn context. The system prompt also describes all capabilities so the LLM can self-select when regex misses.
- On shutdown, Stuart cleans up child `codex app-server` processes (SIGINT/SIGTERM handlers).

Retrieval:

- Stuart builds a local SQLite FTS index over ingested chunks.
- Retrieval is support context for Codex, not the final authority.
- Recent work tightened query cleaning, prefix matching, broad-vs-strict fallback, deduplication, and workspace junk filtering.
- After research turns, the workspace is auto-reindexed so new source files are immediately available.

Artifacts:

- Artifact-specific skill prompts live in [packages/runtime-supervisor/src/skills](./packages/runtime-supervisor/src/skills).
- Renderer and persistence behavior are defined by shared schemas in [packages/shared/src/index.ts](./packages/shared/src/index.ts).
- Document artifacts (PDF/DOCX/XLSX/PPTX) can be generated via two paths:
  - **JSON-to-binary**: LLM outputs structured JSON, server renders to binary via pdfkit/docx/pptxgenjs/xlsx.
  - **Sandbox-scripted**: LLM outputs a Python/JS script, executed in a Docker sandbox (reportlab, python-docx, etc.).
- Generated documents are written to the project's workspace root so the user can access them directly.
- Download and preview endpoints serve the binary files with correct MIME types; previews render natively (PDF in iframe, DOCX via mammoth, XLSX via sheet_to_html, PPTX as HTML cards).

Research:

- The `research` skill instructs the LLM to search the web, clone repos, fetch articles, and save curated markdown files to `sources/` in the workspace.
- A `curriculum.md` with phased learning path is generated alongside.
- After a research turn completes, files are synced from staging to the project root and the ingestion index is rebuilt.

Dependency surfaces:

- Root tooling:
  - `typescript`, `tsx`, `vitest`, `@playwright/test`, `concurrently`
- Web app:
  - `react`, `react-dom`, `vite`, `express`, `cors`, `mermaid`, `react-markdown`, `remark-gfm`
- Document and preview stack:
  - `mammoth`, `xlsx`, `pdfjs-dist`, `fast-xml-parser`, `jszip`, `docx`, `pdfkit`, `pptxgenjs`
- Desktop shell:
  - `electron`
- Optional sandbox runtime:
  - `dockerode`
- UI helpers:
  - `clsx`, `tailwind-merge`

## Development Guide

If you are changing:

- task/run lifecycle, Codex turns, workers, ingestion, or event emission:
  - start in [packages/runtime-supervisor/src/index.ts](./packages/runtime-supervisor/src/index.ts)
- JSON-RPC / websocket app-server behavior:
  - start in [packages/runtime-supervisor/src/codex-app-server.ts](./packages/runtime-supervisor/src/codex-app-server.ts)
- routes or SSE transport:
  - start in [packages/harness/src/index.ts](./packages/harness/src/index.ts)
- SQLite schema or retrieval primitives:
  - start in [packages/db/src/index.ts](./packages/db/src/index.ts)
- client UX, streaming UI, or artifact surfaces:
  - start in [apps/web/src/client/App.tsx](./apps/web/src/client/App.tsx)
  - and [apps/web/src/client/ArtifactCanvas.tsx](./apps/web/src/client/ArtifactCanvas.tsx)
- preview serving:
  - start in [apps/web/src/server/index.ts](./apps/web/src/server/index.ts)

## Testing

Unit and integration coverage:

```bash
pnpm test
```

Browser end-to-end coverage:

```bash
pnpm test:e2e
```

Current dedicated test areas include:

- plugin manifest handling
- diff engine behavior
- retrieval query cleaning and ranking behavior
- browser flows for seeded study workspaces and artifacts

## Known Edges

- The runtime is still mid-pivot toward a cleaner workspace-first model.
- Retrieval is much better than the earlier snippet-only path, but it is still FTS-backed support rather than full semantic search.
- Native document fidelity depends on the optional local tools listed above.

## Philosophy

The repo should keep moving in this direction:

- one primary Codex loop
- staged local workspaces
- persistent study memory
- optional worker fanout
- artifacts as first-class outputs
- ingestion as a support plane, not a replacement for model reasoning

If a change pulls Stuart back toward an import-first dashboard or adds another parallel orchestration stack, it is probably the wrong change.
