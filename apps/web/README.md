# `@stuart/web`

This package is the user-facing application.

## Structure

- `src/client/`: React UI
- `src/server/`: local Express server that mounts the harness and serves previews
- `vite.config.ts`: client dev server and `/api` proxy configuration

## Responsibility

The web app should present Stuart as:

- a workspace-first study tool
- a streaming Codex-backed conversation
- a persistent artifact workspace

It should not expose stale internal package names or older ingestion-first language.

## Runtime Flow

1. The client creates projects and tasks through `/api`.
2. The client sends task messages.
3. The server relays runtime events over `/api/events`.
4. The UI renders thinking state, streaming deltas, messages, workers, sources, and artifacts.

The web server is also where task-scoped previews for PDF, DOCX, XLSX, JSX, HTML, images, and text are served.
