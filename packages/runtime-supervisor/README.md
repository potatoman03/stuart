# `@stuart/runtime-supervisor`

This package is Stuart's runtime core.

## Responsibility

`StuartRuntime` is the owner of:

- staged task runs
- attachment manifests
- Codex app-server threads and turns
- worker spawning
- local ingestion index building
- workspace event emission
- run diffs, approvals, and output scaffolding

If Stuart needs to think, stage, spawn, or stream, it should usually happen here.

## Important Entry Points

- `sendTaskMessage()`:
  stores the user message, resolves a staged run, injects support context, and starts a Codex turn.
- `prepareTaskRun()`:
  stages attachments into an isolated run directory and seeds run metadata.
- `buildTaskIngestionIndex()`:
  builds the local retrieval / preview cache for a task or run.
- `createTaskWorker()`:
  starts a narrower worker objective on a subordinate thread.
- `handleCodexNotification()`:
  converts Codex app-server events into `WorkspaceEvent` values for the UI.

## Design Stance

- The Codex thread is the primary reasoning loop.
- Ingestion is a support plane, not the product front door.
- `TaskRunRecord` is the isolation boundary.
- Worker fanout exists to widen exploration without polluting the main task thread.

Read [ARCHITECTURE.md](../../ARCHITECTURE.md) before making runtime changes.
