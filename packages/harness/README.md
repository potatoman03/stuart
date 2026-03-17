# `@stuart/harness`

This package wraps the runtime in a local HTTP and SSE API.

## Responsibility

The harness should stay thin. It is responsible for:

- bootstrapping `StuartRuntime`
- exposing runtime methods over Express
- fanning out `WorkspaceEvent` values over SSE
- serving task-scoped previews and workspace file routes

It should not become a second orchestrator layer.

## Route Families

- `/api/projects`
- `/api/tasks`
- `/api/tasks/:taskId/messages`
- `/api/tasks/:taskId/workers`
- `/api/tasks/:taskId/ingestion`
- `/api/tasks/:taskId/workspace-files`
- `/api/task-runs/:taskRunId/*`
- `/api/events`

Business logic belongs in `runtime-supervisor`; the harness should mostly validate input, call the runtime, and serialize results.
