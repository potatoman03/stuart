# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Stuart is a pnpm monorepo (Node 22+) — a local-first AI study workspace. See `README.md` for the full architecture and development guide.

### Key commands

| Action | Command |
|---|---|
| Install deps | `pnpm install` |
| Bootstrap (.env + diagnostics) | `pnpm bootstrap` |
| Build all packages | `pnpm build` |
| Type-check | `pnpm typecheck` |
| Unit tests | `pnpm test` (vitest) |
| E2E tests | `pnpm test:e2e` (Playwright) |
| Web dev mode | `pnpm run _dev:web` |
| Desktop dev mode | `pnpm dev:desktop` |

### Gotchas

- **esbuild build scripts**: The root `package.json` has `pnpm.onlyBuiltDependencies` configured to allow `esbuild` and `protobufjs` postinstall scripts. Without this, `esbuild` won't be available and builds will fail.
- **Codex CLI is required for full runtime** but is not available in the cloud VM. The study runtime will start without it (logging `failed to warm codex app-server`), and the system check shows it as a required failure. The web UI still loads and is fully navigable; project/task CRUD, system diagnostics, and all non-AI-chat features work without it.
- **`pnpm dev` vs `pnpm run _dev:web`**: The `pnpm dev` command runs a preflight check that fails if Codex CLI is missing. Use `pnpm run _dev:web` to bypass preflight and start the web dev server directly in cloud environments where Codex is unavailable.
- **Docker sandbox** is optional. Stuart logs `sandbox executor unavailable — Docker not running` and continues without script-based document generation.
- **SQLite** uses Node.js 22's built-in `node:sqlite` (experimental). No external DB is needed.
- **Build order matters**: Packages must be built sequentially (shared → db → plugin-sdk → sandbox-executor → runtime-supervisor → harness → web). The `pnpm build` script handles this automatically.
- **Dev ports**: API on `localhost:8787`, Vite UI on `localhost:5173`. The server process has `--watch` mode with automatic TypeScript recompilation.
- **`.stuart-data/`** directory is auto-created at the workspace root for SQLite DB, staging, and artifacts.
