# `@stuart/db`

This package owns Stuart's durable local state.

## Tables

- `projects`
- `tasks`
- `task_threads`
- `task_runs`
- `task_workers`
- `task_messages`
- `approvals`
- `artifacts`
- `ingestion_documents`
- `ingestion_chunks` (FTS5)
- `study_artifacts`

## Responsibility

- schema creation and migration
- CRUD for the runtime model
- FTS search over ingestion chunks
- persistence of thread ids, run ids, artifacts, and worker state

The database layer should remain storage-oriented. Retrieval policy and runtime decisions belong above it.
