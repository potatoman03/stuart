# `@stuart/shared`

This package defines the shared vocabulary for the repo.

## It Contains

- persisted record types
- create / update input types
- `WorkspaceEvent`
- diff and VM contracts
- study artifact draft schemas
- plugin manifest contracts

If a concept crosses package boundaries, define it here first.

## Most Important Types

- `ProjectRecord`
- `TaskSpec`
- `TaskRunRecord`
- `TaskWorkerRecord`
- `TaskMessageRecord`
- `WorkspaceEvent`
- `StudyArtifactRecord`

The rest of the repo should use these types consistently instead of inventing parallel terminology.
