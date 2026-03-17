# Stuart Architecture

This document is the source of truth for how Stuart should be understood and extended.

## North Star

Stuart is a local-first study runtime with a workspace-first interaction model:

- the user selects a folder
- Stuart treats that folder as a project
- study happens inside a task-backed Codex thread
- each meaningful execution happens in a staged task run
- ingestion supports the runtime, but does not replace the runtime

The repo is inspired by Copal and Claude Cowork patterns:

- staged workspace snapshots
- one primary agent loop
- optional worker fanout for parallel exploration
- persistent thread memory
- lightweight, event-driven UI

It is not meant to drift back into an import-first dashboard that second-guesses the model with too many independent orchestration layers.

## Core Abstractions

### Project

A `ProjectRecord` is a selected workspace root on the host machine.

- one folder on disk
- many study sessions over time
- persisted in `projects`

### Task

A `TaskSpec` is a study session.

- belongs to one project
- carries the study objective
- owns the attachment set
- persists the main Codex thread id

In the UI this should usually be described as a study session, not as a generic task manager item.

### Task Run

A `TaskRunRecord` is an isolated execution snapshot.

- attachments are staged under `.stuart-data/.../staging/<run-id>`
- a manifest captures attachment fingerprints
- approvals and output artifacts are scoped to the run
- retrieval and ingestion can be scoped to the run

This is Stuart's safety and reproducibility boundary.

### Worker

A `TaskWorkerRecord` is a subordinate agent with a narrower objective.

- spawned from a parent task
- usually used for parallel exploration or decomposition
- may have its own Codex thread
- reports completion or failure back as events

### Ingestion Index

The ingestion index is a local support system:

- document parsing
- OCR / structured extraction
- FTS-backed chunk search
- previews and workspace browsing

It exists to help Codex reason over a larger workspace, not to become the user-facing product model.

### Study Artifact

A `StudyArtifactRecord` is a persistent learning surface:

- flashcards
- quizzes
- mind maps
- diagrams
- custom structured outputs

Artifacts belong to a task, not to a detached export pipeline.

## Runtime Flow

### 1. Workspace selection

The web or desktop UI selects a folder and creates:

- a `project`
- a default `task` with the study objective

### 2. Task run preparation

`StuartRuntime.prepareTaskRun()`:

- creates a fresh staging directory
- copies attachments into run-scoped staging paths
- writes `manifest.json`
- seeds approvals and output artifacts
- writes workspace scaffold metadata

### 3. Local context build

`buildTaskIngestionIndex()` walks the staged workspace and:

- parses supported files
- creates ingestion documents
- inserts chunks into the FTS table
- records aggregate stats

This is best thought of as local context support, not as the primary reasoning loop.

### 4. Codex thread lifecycle

`sendTaskMessage()`:

- stores the user message
- resolves an existing compatible run or prepares a fresh one
- resumes or starts the task thread
- builds retrieved context support
- starts a Codex `turn/start`

The model then reasons over the staged workspace and the injected retrieval context from one main thread.

### 5. Optional worker fanout

For larger material sets, the runtime may spawn worker threads:

- smaller objectives
- narrower source sets
- parallel exploration
- summarized back into the task

This is the closest analogue to a Cowork-style sub-agent pattern in the current repo.

### 6. Event streaming

The runtime emits `WorkspaceEvent` values:

- task creation / updates
- run creation
- worker status
- Codex thinking labels
- streaming assistant deltas
- completed assistant messages

The harness exposes these over SSE. The web client treats them as the live source of truth.

### 7. Persistence

SQLite stores:

- projects
- tasks
- task threads
- task runs
- workers
- task messages
- approvals
- run artifacts
- ingestion documents / chunks
- study artifacts

## Package Responsibilities

### `packages/runtime-supervisor`

The heart of the application.

Owns:

- staged run preparation
- manifest handling
- Codex app-server integration
- worker spawning
- retrieval-context injection
- ingestion index building
- event emission

If a feature changes the core runtime behavior, it should probably land here.

### `packages/harness`

The transport layer around the runtime.

Owns:

- Express API
- SSE event fanout
- server bootstrap helpers
- file preview and workspace routing endpoints

It should stay thin. Business logic belongs in the runtime, not in routes.

### `packages/db`

The durable local state.

Owns:

- schema creation / migration
- CRUD for runtime records
- FTS chunk search
- task-thread / worker-thread persistence
- study artifact persistence

It should remain storage-oriented, not orchestration-oriented.

### `packages/shared`

The vocabulary of the system.

Owns:

- records
- event unions
- artifact draft schemas
- diff and VM contracts

If a concept cannot be expressed clearly here, it probably is not well-defined enough yet.

### `apps/web`

The product surface.

Contains:

- React client
- local Express server for previews and API mounting
- the streaming study UI
- artifact rendering

The UI should expose study sessions, folders, and artifacts. It should not leak obsolete package names or old architecture jargon.

### `apps/desktop`

The native shell.

Owns:

- Electron window
- native folder picker
- desktop preload bridge

It should be a shell over `apps/web`, not a second application.

## Contributor Rules

These rules are deliberate:

1. Do not reintroduce an import-first mental model.
2. Do not create separate planner / teacher / artifact runtimes unless there is a very strong reason.
3. Prefer one primary Codex loop plus optional worker fanout.
4. Keep ingestion as a support plane for scale, previews, and search.
5. Keep vocabulary consistent across docs, code, and UI.
6. Favor package-level responsibilities over cross-cutting "misc runtime" code.
7. If you touch the user-facing flow, update this document and the root README at the same time.

## Current Gaps

The repo is not fully finished, and that matters:

- some tests and legacy references still need continued cleanup
- retrieval is still FTS-first rather than a richer semantic layer
- worker orchestration is present, but still relatively lightweight
- desktop remains a shell around the web app rather than a deeply distinct runtime

That is acceptable as long as changes keep pulling the codebase toward the model above instead of away from it.
