import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  ApprovalRecord,
  ArtifactRecord,
  CardPerformanceRecord,
  CreateProjectInput,
  CreateStudentMemoryInput,
  CreateTaskInput,
  CreateWorkerInput,
  IngestionDocumentRecord,
  IngestionIndexStats,
  IngestionSearchResult,
  MindMapNodeNote,
  MockExamAttempt,
  ProjectLearningSummary,
  ProjectRecord,
  QuizPerformanceRecord,
  StudentMemoryRecord,
  StudyArtifactRecord,
  StudySessionRecord,
  StudyTimelineEntry,
  TaskMessageRecord,
  TaskPerformanceBreakdown,
  TaskRunRecord,
  TaskSpec,
  TaskWorkerRecord,
  TopicPerformanceRecord,
  UpdateTaskInput
} from "@stuart/shared";
import {
  DEFAULT_GLOBAL_INSTRUCTION_PROFILE,
  DEFAULT_NETWORK_POLICY
} from "@stuart/shared";

type DbTaskRow = Omit<TaskSpec, "attachments" | "folderInstructionIds"> & {
  attachmentsJson: string;
  folderInstructionIdsJson: string;
};

type DbTaskWorkerRow = Omit<TaskWorkerRecord, "attachmentIds" | "parentTaskId"> & {
  taskId: string;
  attachmentIdsJson: string;
};

export class LocalDatabase {
  private readonly db: DatabaseSync;

  constructor(private readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        global_instruction_profile_id TEXT NOT NULL,
        folder_instruction_ids_json TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        network_policy_id TEXT NOT NULL,
        auth_mode TEXT NOT NULL,
        browser_enabled INTEGER NOT NULL,
        schedule_rrule TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_threads (
        task_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        staging_path TEXT NOT NULL,
        thread_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_workers (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        task_run_id TEXT,
        parent_worker_id TEXT,
        role TEXT NOT NULL,
        objective TEXT NOT NULL,
        attachment_ids_json TEXT NOT NULL,
        tool_profile_id TEXT NOT NULL,
        status TEXT NOT NULL,
        thread_id TEXT,
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS task_workers_task_id_idx
      ON task_workers (task_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS task_workers_thread_id_idx
      ON task_workers (thread_id);

      CREATE TABLE IF NOT EXISTS task_messages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        task_run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        task_run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        guest_path TEXT NOT NULL,
        proposed_host_path TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ingestion_documents (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        task_id TEXT NOT NULL,
        task_run_id TEXT,
        source_path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        file_type TEXT NOT NULL,
        parser TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        size INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        indexed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ingestion_documents_scope_key_idx
      ON ingestion_documents (scope_key);

      CREATE VIRTUAL TABLE IF NOT EXISTS ingestion_chunks USING fts5(
        chunk_id UNINDEXED,
        document_id UNINDEXED,
        scope_key UNINDEXED,
        task_id UNINDEXED,
        task_run_id UNINDEXED,
        source_path UNINDEXED,
        relative_path UNINDEXED,
        file_type UNINDEXED,
        heading UNINDEXED,
        locator UNINDEXED,
        text
      );

      CREATE TABLE IF NOT EXISTS study_artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS card_performance (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        ease_factor REAL NOT NULL DEFAULT 2.5,
        interval_days REAL NOT NULL DEFAULT 0,
        repetitions INTEGER NOT NULL DEFAULT 0,
        next_review_date TEXT NOT NULL,
        last_rating TEXT,
        total_reviews INTEGER NOT NULL DEFAULT 0,
        correct_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(artifact_id, card_id)
      );

      CREATE TABLE IF NOT EXISTS quiz_performance (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL DEFAULT 1,
        selected_answer TEXT,
        is_correct INTEGER NOT NULL,
        difficulty_flag TEXT,
        attempted_at TEXT NOT NULL,
        UNIQUE(artifact_id, question_id, attempt_number)
      );

      CREATE TABLE IF NOT EXISTS mindmap_node_notes (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(artifact_id, node_id)
      );

      CREATE TABLE IF NOT EXISTS mock_exam_attempts (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        answers TEXT NOT NULL,
        score REAL,
        total_marks REAL NOT NULL,
        time_taken_seconds INTEGER,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS study_sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        cards_reviewed INTEGER NOT NULL DEFAULT 0,
        questions_answered INTEGER NOT NULL DEFAULT 0,
        correct_count INTEGER NOT NULL DEFAULT 0,
        artifact_ids_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS study_sessions_project_id_idx
      ON study_sessions (project_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS topic_performance (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        total_attempts INTEGER NOT NULL DEFAULT 0,
        correct_count INTEGER NOT NULL DEFAULT 0,
        last_attempted_at TEXT,
        source_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
        UNIQUE(project_id, topic)
      );

      CREATE INDEX IF NOT EXISTS topic_performance_project_id_idx
      ON topic_performance (project_id, total_attempts DESC);
    `);

    // Add file_path column to study_artifacts (idempotent)
    try {
      this.db.exec(`ALTER TABLE study_artifacts ADD COLUMN file_path TEXT`);
    } catch {
      // Column already exists — safe to ignore
    }

    // Student memory table for cross-session structured memory
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS student_memories (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL,
        scope_id TEXT,
        category TEXT NOT NULL,
        topic TEXT,
        memory_key TEXT,
        content TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_message_id TEXT,
        created_at TEXT NOT NULL,
        event_date TEXT,
        expires_at TEXT,
        superseded_by TEXT,
        access_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS student_memories_scope_idx
      ON student_memories (scope_type, scope_id, category);

      CREATE INDEX IF NOT EXISTS student_memories_key_idx
      ON student_memories (memory_key) WHERE memory_key IS NOT NULL;
    `);
  }

  listProjects(): ProjectRecord[] {
    return asRows<ProjectRecord>(
      this.db
      .prepare(
        `SELECT id, name, root_path as rootPath, created_at as createdAt, updated_at as updatedAt
         FROM projects
         ORDER BY updated_at DESC`
      )
      .all()
    );
  }

  createProject(input: CreateProjectInput): ProjectRecord {
    const now = new Date().toISOString();
    const record: ProjectRecord = {
      id: randomUUID(),
      name: input.name,
      rootPath: input.rootPath,
      createdAt: now,
      updatedAt: now
    };

    this.db
      .prepare(
        `INSERT INTO projects (id, name, root_path, created_at, updated_at)
         VALUES (@id, @name, @rootPath, @createdAt, @updatedAt)`
      )
      .run(
        asSqlParams({
          id: record.id,
          name: record.name,
          rootPath: record.rootPath,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt
        })
      );

    return record;
  }

  getProject(projectId: string): ProjectRecord | undefined {
    return this.db
      .prepare(
        `SELECT id, name, root_path as rootPath, created_at as createdAt, updated_at as updatedAt
         FROM projects
         WHERE id = ?`
      )
      .get(projectId) as ProjectRecord | undefined;
  }

  listTasks(): TaskSpec[] {
    const rows = asRows<DbTaskRow>(
      this.db
      .prepare(
        `SELECT
          id,
          project_id as projectId,
          title,
          objective,
          global_instruction_profile_id as globalInstructionProfileId,
          folder_instruction_ids_json as folderInstructionIdsJson,
          attachments_json as attachmentsJson,
          network_policy_id as networkPolicyId,
          auth_mode as authMode,
          browser_enabled as browserEnabled,
          schedule_rrule as scheduleRRule,
          created_at as createdAt,
          updated_at as updatedAt
         FROM tasks
         ORDER BY updated_at DESC`
      )
      .all()
    );

    return rows.map((row) => this.mapTask(row));
  }

  listTasksByProject(projectId: string): TaskSpec[] {
    const rows = asRows<DbTaskRow>(
      this.db
        .prepare(
          `SELECT
            id,
            project_id as projectId,
            title,
            objective,
            global_instruction_profile_id as globalInstructionProfileId,
            folder_instruction_ids_json as folderInstructionIdsJson,
            attachments_json as attachmentsJson,
            network_policy_id as networkPolicyId,
            auth_mode as authMode,
            browser_enabled as browserEnabled,
            schedule_rrule as scheduleRRule,
            created_at as createdAt,
            updated_at as updatedAt
           FROM tasks
           WHERE project_id = ?
           ORDER BY updated_at DESC`
        )
        .all(projectId)
    );

    return rows.map((row) => this.mapTask(row));
  }

  getTask(taskId: string): TaskSpec | undefined {
    const row = this.db
      .prepare(
        `SELECT
          id,
          project_id as projectId,
          title,
          objective,
          global_instruction_profile_id as globalInstructionProfileId,
          folder_instruction_ids_json as folderInstructionIdsJson,
          attachments_json as attachmentsJson,
          network_policy_id as networkPolicyId,
          auth_mode as authMode,
          browser_enabled as browserEnabled,
          schedule_rrule as scheduleRRule,
          created_at as createdAt,
          updated_at as updatedAt
         FROM tasks
         WHERE id = ?`
      )
      .get(taskId) as DbTaskRow | undefined;

    return row ? this.mapTask(row) : undefined;
  }

  createTask(input: CreateTaskInput): TaskSpec {
    const now = new Date().toISOString();
    const record: TaskSpec = {
      id: randomUUID(),
      projectId: input.projectId,
      title: input.title,
      objective: input.objective,
      globalInstructionProfileId:
        input.globalInstructionProfileId ?? DEFAULT_GLOBAL_INSTRUCTION_PROFILE,
      folderInstructionIds: input.folderInstructionIds ?? [],
      attachments: input.attachments,
      networkPolicyId: input.networkPolicyId ?? DEFAULT_NETWORK_POLICY,
      authMode: input.authMode ?? "chatgpt",
      browserEnabled: input.browserEnabled ?? false,
      scheduleRRule: input.scheduleRRule,
      createdAt: now,
      updatedAt: now
    };

    this.db
      .prepare(
        `INSERT INTO tasks (
          id,
          project_id,
          title,
          objective,
          global_instruction_profile_id,
          folder_instruction_ids_json,
          attachments_json,
          network_policy_id,
          auth_mode,
          browser_enabled,
          schedule_rrule,
          created_at,
          updated_at
        )
        VALUES (
          @id,
          @projectId,
          @title,
          @objective,
          @globalInstructionProfileId,
          @folderInstructionIdsJson,
          @attachmentsJson,
          @networkPolicyId,
          @authMode,
          @browserEnabled,
          @scheduleRRule,
          @createdAt,
          @updatedAt
        )`
      )
      .run(asSqlParams({
        id: record.id,
        projectId: record.projectId,
        title: record.title,
        objective: record.objective,
        globalInstructionProfileId: record.globalInstructionProfileId,
        browserEnabled: record.browserEnabled ? 1 : 0,
        folderInstructionIdsJson: JSON.stringify(record.folderInstructionIds),
        attachmentsJson: JSON.stringify(record.attachments),
        networkPolicyId: record.networkPolicyId,
        authMode: record.authMode,
        scheduleRRule: record.scheduleRRule ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
      }));

    return record;
  }

  updateTask(taskId: string, input: UpdateTaskInput): TaskSpec {
    const current = this.getTask(taskId);
    if (!current) {
      throw new Error(`Task ${taskId} not found.`);
    }

    const updated: TaskSpec = {
      ...current,
      ...input,
      attachments: input.attachments ?? current.attachments,
      folderInstructionIds: input.folderInstructionIds ?? current.folderInstructionIds,
      updatedAt: new Date().toISOString()
    };

    this.db
      .prepare(
        `UPDATE tasks
         SET project_id = @projectId,
             title = @title,
             objective = @objective,
             global_instruction_profile_id = @globalInstructionProfileId,
             folder_instruction_ids_json = @folderInstructionIdsJson,
             attachments_json = @attachmentsJson,
             network_policy_id = @networkPolicyId,
             auth_mode = @authMode,
             browser_enabled = @browserEnabled,
             schedule_rrule = @scheduleRRule,
             updated_at = @updatedAt
         WHERE id = @id`
      )
      .run(asSqlParams({
        id: updated.id,
        projectId: updated.projectId,
        title: updated.title,
        objective: updated.objective,
        globalInstructionProfileId: updated.globalInstructionProfileId,
        folderInstructionIdsJson: JSON.stringify(updated.folderInstructionIds),
        attachmentsJson: JSON.stringify(updated.attachments),
        networkPolicyId: updated.networkPolicyId,
        authMode: updated.authMode,
        browserEnabled: updated.browserEnabled ? 1 : 0,
        scheduleRRule: updated.scheduleRRule ?? null,
        updatedAt: updated.updatedAt
      }));

    return updated;
  }

  listTaskWorkers(taskId: string): TaskWorkerRecord[] {
    const rows = asRows<DbTaskWorkerRow>(
      this.db
        .prepare(
          `SELECT
            id,
            task_id as taskId,
            task_run_id as taskRunId,
            parent_worker_id as parentWorkerId,
            role,
            objective,
            attachment_ids_json as attachmentIdsJson,
            tool_profile_id as toolProfileId,
            status,
            thread_id as threadId,
            summary,
            created_at as createdAt,
            updated_at as updatedAt,
            completed_at as completedAt
           FROM task_workers
           WHERE task_id = ?
           ORDER BY created_at ASC`
        )
        .all(taskId)
    );

    return rows.map((row) => this.mapTaskWorker(row));
  }

  getTaskWorker(workerId: string): TaskWorkerRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT
          id,
          task_id as taskId,
          task_run_id as taskRunId,
          parent_worker_id as parentWorkerId,
          role,
          objective,
          attachment_ids_json as attachmentIdsJson,
          tool_profile_id as toolProfileId,
          status,
          thread_id as threadId,
          summary,
          created_at as createdAt,
          updated_at as updatedAt,
          completed_at as completedAt
         FROM task_workers
         WHERE id = ?`
      )
      .get(workerId) as DbTaskWorkerRow | undefined;

    return row ? this.mapTaskWorker(row) : undefined;
  }

  createTaskWorker(taskId: string, input: CreateWorkerInput): TaskWorkerRecord {
    const now = new Date().toISOString();
    const record: TaskWorkerRecord = {
      id: randomUUID(),
      parentTaskId: taskId,
      taskRunId: input.taskRunId,
      parentWorkerId: input.parentWorkerId,
      role: input.role,
      objective: input.objective,
      attachmentIds: input.attachmentIds ?? [],
      toolProfileId: input.toolProfileId ?? "default",
      status: "queued",
      threadId: undefined,
      summary: undefined,
      createdAt: now,
      updatedAt: now,
      completedAt: undefined
    };

    this.db
      .prepare(
        `INSERT INTO task_workers (
          id,
          task_id,
          task_run_id,
          parent_worker_id,
          role,
          objective,
          attachment_ids_json,
          tool_profile_id,
          status,
          thread_id,
          summary,
          created_at,
          updated_at,
          completed_at
        ) VALUES (
          @id,
          @taskId,
          @taskRunId,
          @parentWorkerId,
          @role,
          @objective,
          @attachmentIdsJson,
          @toolProfileId,
          @status,
          @threadId,
          @summary,
          @createdAt,
          @updatedAt,
          @completedAt
        )`
      )
      .run(
        asSqlParams({
          id: record.id,
          taskId: record.parentTaskId,
          taskRunId: record.taskRunId ?? null,
          parentWorkerId: record.parentWorkerId ?? null,
          role: record.role,
          objective: record.objective,
          attachmentIdsJson: JSON.stringify(record.attachmentIds),
          toolProfileId: record.toolProfileId,
          status: record.status,
          threadId: record.threadId ?? null,
          summary: record.summary ?? null,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          completedAt: record.completedAt ?? null
        })
      );

    return record;
  }

  updateTaskWorker(record: TaskWorkerRecord): void {
    this.db
      .prepare(
        `UPDATE task_workers
         SET task_run_id = @taskRunId,
             parent_worker_id = @parentWorkerId,
             role = @role,
             objective = @objective,
             attachment_ids_json = @attachmentIdsJson,
             tool_profile_id = @toolProfileId,
             status = @status,
             thread_id = @threadId,
             summary = @summary,
             updated_at = @updatedAt,
             completed_at = @completedAt
         WHERE id = @id`
      )
      .run(
        asSqlParams({
          id: record.id,
          taskRunId: record.taskRunId ?? null,
          parentWorkerId: record.parentWorkerId ?? null,
          role: record.role,
          objective: record.objective,
          attachmentIdsJson: JSON.stringify(record.attachmentIds),
          toolProfileId: record.toolProfileId,
          status: record.status,
          threadId: record.threadId ?? null,
          summary: record.summary ?? null,
          updatedAt: record.updatedAt,
          completedAt: record.completedAt ?? null
        })
      );
  }

  deleteTask(taskId: string): { deleted: boolean; stagingPaths: string[] } {
    const task = this.getTask(taskId);
    if (!task) {
      return {
        deleted: false,
        stagingPaths: []
      };
    }

    const runs = this.listTaskRuns(taskId);
    const stagingPaths = runs.map((run) => run.stagingPath);

    this.db.exec("BEGIN");
    try {
      for (const run of runs) {
        this.db.prepare(`DELETE FROM approvals WHERE task_run_id = ?`).run(run.id);
        this.db.prepare(`DELETE FROM artifacts WHERE task_run_id = ?`).run(run.id);
      }
      this.db.prepare(`DELETE FROM task_workers WHERE task_id = ?`).run(taskId);
      this.db.prepare(`DELETE FROM task_runs WHERE task_id = ?`).run(taskId);
      this.db.prepare(`DELETE FROM task_messages WHERE task_id = ?`).run(taskId);
      this.db.prepare(`DELETE FROM task_threads WHERE task_id = ?`).run(taskId);
      this.db.prepare(`DELETE FROM ingestion_documents WHERE task_id = ?`).run(taskId);
      this.db.prepare(`DELETE FROM ingestion_chunks WHERE task_id = ?`).run(taskId);
      this.db.prepare(`DELETE FROM study_artifacts WHERE task_id = ?`).run(taskId);
      this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      deleted: true,
      stagingPaths
    };
  }

  deleteProject(projectId: string): boolean {
    const result = this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
    return Number(result.changes ?? 0) > 0;
  }

  listTaskMessages(taskId: string): TaskMessageRecord[] {
    return asRows<TaskMessageRecord>(
      this.db
        .prepare(
          `SELECT
            id,
            task_id as taskId,
            role,
            content,
            created_at as createdAt
           FROM task_messages
           WHERE task_id = ?
           ORDER BY created_at ASC`
        )
        .all(taskId)
    );
  }

  cleanupHistoricalTaskMessages(): { deletedCount: number } {
    const rows = asRows<TaskMessageRecord>(
      this.db
        .prepare(
          `SELECT
            id,
            task_id as taskId,
            role,
            content,
            created_at as createdAt
           FROM task_messages
           ORDER BY task_id ASC, created_at ASC`
        )
        .all()
    );

    const deletions = new Set<string>();

    for (const [, taskMessages] of groupMessagesByTask(rows)) {
      for (const message of taskMessages) {
        if (message.role === "assistant" && isLegacySyntheticAssistantMessage(message.content)) {
          deletions.add(message.id);
        }
      }

      let segmentStart = 0;
      while (segmentStart < taskMessages.length) {
        while (
          segmentStart < taskMessages.length &&
          taskMessages[segmentStart]?.role === "user"
        ) {
          segmentStart += 1;
        }

        if (segmentStart >= taskMessages.length) {
          break;
        }

        let segmentEnd = segmentStart;
        while (
          segmentEnd < taskMessages.length &&
          taskMessages[segmentEnd]?.role !== "user"
        ) {
          segmentEnd += 1;
        }

        const segment = taskMessages.slice(segmentStart, segmentEnd);
        const assistants = segment.filter((message) => message.role === "assistant");
        if (assistants.length > 1) {
          for (const assistant of assistants.slice(0, -1)) {
            deletions.add(assistant.id);
          }
        }

        segmentStart = segmentEnd;
      }
    }

    if (deletions.size === 0) {
      return {
        deletedCount: 0
      };
    }

    const deleteStatement = this.db.prepare(
      `DELETE FROM task_messages WHERE id = ?`
    );
    this.db.exec("BEGIN");
    try {
      for (const id of deletions) {
        deleteStatement.run(id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      deletedCount: deletions.size
    };
  }

  createTaskMessage(
    input: Omit<TaskMessageRecord, "id" | "createdAt"> & {
      id?: string;
      createdAt?: string;
    }
  ): TaskMessageRecord {
    const record: TaskMessageRecord = {
      id: input.id ?? randomUUID(),
      taskId: input.taskId,
      role: input.role,
      content: input.content,
      createdAt: input.createdAt ?? new Date().toISOString()
    };

    this.db
      .prepare(
        `INSERT INTO task_messages (
          id,
          task_id,
          role,
          content,
          created_at
        ) VALUES (
          @id,
          @taskId,
          @role,
          @content,
          @createdAt
        )`
      )
      .run(asSqlParams({
        id: record.id,
        taskId: record.taskId,
        role: record.role,
        content: record.content,
        createdAt: record.createdAt
      }));

    return record;
  }

  upsertTaskMessage(
    input: Omit<TaskMessageRecord, "id" | "createdAt"> & {
      id?: string;
      createdAt?: string;
    }
  ): TaskMessageRecord {
    const record: TaskMessageRecord = {
      id: input.id ?? randomUUID(),
      taskId: input.taskId,
      role: input.role,
      content: input.content,
      createdAt: input.createdAt ?? new Date().toISOString()
    };

    this.db
      .prepare(
        `INSERT INTO task_messages (
          id,
          task_id,
          role,
          content,
          created_at
        ) VALUES (
          @id,
          @taskId,
          @role,
          @content,
          @createdAt
        )
        ON CONFLICT(id) DO UPDATE SET
          task_id = excluded.task_id,
          role = excluded.role,
          content = excluded.content,
          created_at = excluded.created_at`
      )
      .run(asSqlParams({
        id: record.id,
        taskId: record.taskId,
        role: record.role,
        content: record.content,
        createdAt: record.createdAt
      }));

    return record;
  }

  getTaskThreadId(taskId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT thread_id as threadId
         FROM task_threads
         WHERE task_id = ?`
      )
      .get(taskId) as { threadId: string } | undefined;

    return row?.threadId;
  }

  getTaskIdByThreadId(threadId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT task_id as taskId
         FROM task_threads
         WHERE thread_id = ?`
      )
      .get(threadId) as { taskId: string } | undefined;

    return row?.taskId;
  }

  getTaskWorkerIdByThreadId(threadId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT id
         FROM task_workers
         WHERE thread_id = ?`
      )
      .get(threadId) as { id: string } | undefined;

    return row?.id;
  }

  setTaskThreadId(taskId: string, threadId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO task_threads (
          task_id,
          thread_id,
          created_at,
          updated_at
        ) VALUES (
          @taskId,
          @threadId,
          @createdAt,
          @updatedAt
        )
        ON CONFLICT(task_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          updated_at = excluded.updated_at`
      )
      .run(asSqlParams({
        taskId,
        threadId,
        createdAt: now,
        updatedAt: now
      }));
  }

  clearTaskThreadId(taskId: string): void {
    this.db
      .prepare(`DELETE FROM task_threads WHERE task_id = ?`)
      .run(taskId);
  }

  setTaskWorkerThreadId(workerId: string, threadId: string): void {
    this.db
      .prepare(
        `UPDATE task_workers
         SET thread_id = @threadId,
             updated_at = @updatedAt
         WHERE id = @id`
      )
      .run(
        asSqlParams({
          id: workerId,
          threadId,
          updatedAt: new Date().toISOString()
        })
      );
  }

  createTaskRun(taskId: string, stagingPath: string): TaskRunRecord {
    const now = new Date().toISOString();
    const record: TaskRunRecord = {
      id: randomUUID(),
      taskId,
      status: "staging",
      stagingPath,
      createdAt: now,
      updatedAt: now
    };

    this.db
      .prepare(
        `INSERT INTO task_runs (
          id,
          task_id,
          status,
          staging_path,
          thread_id,
          created_at,
          updated_at
        ) VALUES (
          @id,
          @taskId,
          @status,
          @stagingPath,
          @threadId,
          @createdAt,
          @updatedAt
        )`
      )
      .run(asSqlParams({
        ...record,
        threadId: null
      }));

    return record;
  }

  listTaskRuns(taskId: string): TaskRunRecord[] {
    return asRows<TaskRunRecord>(
      this.db
      .prepare(
        `SELECT
          id,
          task_id as taskId,
          status,
          staging_path as stagingPath,
          thread_id as threadId,
          created_at as createdAt,
          updated_at as updatedAt
         FROM task_runs
         WHERE task_id = ?
         ORDER BY created_at DESC`
      )
      .all(taskId)
    );
  }

  getTaskRun(taskRunId: string): TaskRunRecord | undefined {
    return this.db
      .prepare(
        `SELECT
          id,
          task_id as taskId,
          status,
          staging_path as stagingPath,
          thread_id as threadId,
          created_at as createdAt,
          updated_at as updatedAt
         FROM task_runs
         WHERE id = ?`
      )
      .get(taskRunId) as TaskRunRecord | undefined;
  }

  updateTaskRun(record: TaskRunRecord): void {
    this.db
      .prepare(
        `UPDATE task_runs
         SET status = @status,
             staging_path = @stagingPath,
             thread_id = @threadId,
             updated_at = @updatedAt
         WHERE id = @id`
      )
      .run(asSqlParams({
        id: record.id,
        status: record.status,
        stagingPath: record.stagingPath,
        threadId: record.threadId ?? null,
        updatedAt: record.updatedAt
      }));
  }

  listArtifacts(taskRunId: string): ArtifactRecord[] {
    return asRows<ArtifactRecord>(
      this.db
      .prepare(
        `SELECT
          id,
          task_run_id as taskRunId,
          type,
          guest_path as guestPath,
          proposed_host_path as proposedHostPath,
          status,
          created_at as createdAt
         FROM artifacts
         WHERE task_run_id = ?
         ORDER BY created_at DESC`
      )
      .all(taskRunId)
    );
  }

  upsertArtifact(artifact: ArtifactRecord): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (
          id,
          task_run_id,
          type,
          guest_path,
          proposed_host_path,
          status,
          created_at
         ) VALUES (
          @id,
          @taskRunId,
          @type,
          @guestPath,
          @proposedHostPath,
          @status,
          @createdAt
         )
         ON CONFLICT(id) DO UPDATE SET
           task_run_id = excluded.task_run_id,
           type = excluded.type,
           guest_path = excluded.guest_path,
           proposed_host_path = excluded.proposed_host_path,
           status = excluded.status`
      )
      .run(asSqlParams({
        ...artifact,
        proposedHostPath: artifact.proposedHostPath ?? null
      }));
  }

  listApprovals(taskRunId: string): ApprovalRecord[] {
    return asRows<ApprovalRecord>(
      this.db
      .prepare(
        `SELECT
          id,
          task_run_id as taskRunId,
          kind,
          status,
          title,
          detail,
          created_at as createdAt,
          resolved_at as resolvedAt
         FROM approvals
         WHERE task_run_id = ?
         ORDER BY created_at DESC`
      )
      .all(taskRunId)
    );
  }

  upsertApproval(approval: ApprovalRecord): void {
    this.db
      .prepare(
        `INSERT INTO approvals (
          id,
          task_run_id,
          kind,
          status,
          title,
          detail,
          created_at,
          resolved_at
         ) VALUES (
          @id,
          @taskRunId,
          @kind,
          @status,
          @title,
          @detail,
          @createdAt,
          @resolvedAt
         )
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           title = excluded.title,
           detail = excluded.detail,
           resolved_at = excluded.resolved_at`
      )
      .run(asSqlParams({
        ...approval,
        detail: approval.detail ?? null,
        resolvedAt: approval.resolvedAt ?? null
      }));
  }

  clearIngestionScope(taskId: string, taskRunId?: string): void {
    const scopeKey = buildIngestionScopeKey(taskId, taskRunId);
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM ingestion_documents WHERE scope_key = ?`).run(scopeKey);
      this.db.prepare(`DELETE FROM ingestion_chunks WHERE scope_key = ?`).run(scopeKey);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertIngestionDocument(document: IngestionDocumentRecord): void {
    const scopeKey = buildIngestionScopeKey(document.taskId, document.taskRunId);
    this.db
      .prepare(
        `INSERT INTO ingestion_documents (
          id,
          scope_key,
          task_id,
          task_run_id,
          source_path,
          relative_path,
          file_type,
          parser,
          chunk_count,
          size,
          status,
          error,
          indexed_at
        ) VALUES (
          @id,
          @scopeKey,
          @taskId,
          @taskRunId,
          @sourcePath,
          @relativePath,
          @fileType,
          @parser,
          @chunkCount,
          @size,
          @status,
          @error,
          @indexedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          scope_key = excluded.scope_key,
          task_id = excluded.task_id,
          task_run_id = excluded.task_run_id,
          source_path = excluded.source_path,
          relative_path = excluded.relative_path,
          file_type = excluded.file_type,
          parser = excluded.parser,
          chunk_count = excluded.chunk_count,
          size = excluded.size,
          status = excluded.status,
          error = excluded.error,
          indexed_at = excluded.indexed_at`
      )
      .run(
        asSqlParams({
          ...document,
          scopeKey,
          taskRunId: document.taskRunId ?? null,
          error: document.error ?? null
        })
      );
  }

  insertIngestionChunk(chunk: {
    chunkId: string;
    documentId: string;
    taskId: string;
    taskRunId?: string;
    sourcePath: string;
    relativePath: string;
    fileType: string;
    heading?: string;
    locator?: string;
    text: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO ingestion_chunks (
          chunk_id,
          document_id,
          scope_key,
          task_id,
          task_run_id,
          source_path,
          relative_path,
          file_type,
          heading,
          locator,
          text
        ) VALUES (
          @chunkId,
          @documentId,
          @scopeKey,
          @taskId,
          @taskRunId,
          @sourcePath,
          @relativePath,
          @fileType,
          @heading,
          @locator,
          @text
        )`
      )
      .run(
        asSqlParams({
          ...chunk,
          scopeKey: buildIngestionScopeKey(chunk.taskId, chunk.taskRunId),
          taskRunId: chunk.taskRunId ?? null,
          heading: chunk.heading ?? null,
          locator: chunk.locator ?? null
        })
      );
  }

  listIngestionDocuments(taskId: string, taskRunId?: string): IngestionDocumentRecord[] {
    const scopeKey = buildIngestionScopeKey(taskId, taskRunId);
    return asRows<IngestionDocumentRecord>(
      this.db
        .prepare(
          `SELECT
            id,
            task_id as taskId,
            task_run_id as taskRunId,
            source_path as sourcePath,
            relative_path as relativePath,
            file_type as fileType,
            parser,
            chunk_count as chunkCount,
            size,
            status,
            error,
            indexed_at as indexedAt
           FROM ingestion_documents
           WHERE scope_key = ?
           ORDER BY relative_path ASC`
        )
        .all(scopeKey)
    );
  }

  getIngestionStats(taskId: string, taskRunId?: string): IngestionIndexStats {
    const scopeKey = buildIngestionScopeKey(taskId, taskRunId);
    const aggregate = this.db
      .prepare(
        `SELECT
          COUNT(*) as documentsIndexed,
          COALESCE(SUM(chunk_count), 0) as chunksIndexed,
          COALESCE(SUM(size), 0) as totalBytes,
          MAX(indexed_at) as indexedAt
         FROM ingestion_documents
         WHERE scope_key = ? AND status = 'indexed'`
      )
      .get(scopeKey) as
      | {
          documentsIndexed: number;
          chunksIndexed: number;
          totalBytes: number;
          indexedAt?: string | null;
        }
      | undefined;

    const parserRows = asRows<{ parser: string; count: number }>(
      this.db
        .prepare(
          `SELECT parser, COUNT(*) as count
           FROM ingestion_documents
           WHERE scope_key = ? AND status = 'indexed'
           GROUP BY parser
           ORDER BY count DESC, parser ASC`
        )
        .all(scopeKey)
    );

    return {
      taskId,
      taskRunId,
      documentsIndexed: Number(aggregate?.documentsIndexed ?? 0),
      chunksIndexed: Number(aggregate?.chunksIndexed ?? 0),
      totalBytes: Number(aggregate?.totalBytes ?? 0),
      indexedAt: aggregate?.indexedAt ?? undefined,
      parserBreakdown: Object.fromEntries(
        parserRows.map((row) => [row.parser, Number(row.count)])
      )
    };
  }

  searchIngestionChunks(
    taskId: string,
    query: string,
    options?: {
      taskRunId?: string;
      limit?: number;
    }
  ): IngestionSearchResult[] {
    const queries = buildFtsQueries(query);
    if (!queries) {
      return [];
    }

    const scopeKey = buildIngestionScopeKey(taskId, options?.taskRunId);
    const limit = options?.limit ?? 8;
    const searchStatement = this.db.prepare(
      `SELECT
        chunk_id as chunkId,
        document_id as documentId,
        task_id as taskId,
        task_run_id as taskRunId,
        source_path as sourcePath,
        relative_path as relativePath,
        file_type as fileType,
        heading,
        locator,
        text,
        snippet(ingestion_chunks, 10, '', '', ' ... ', 20) as snippet,
        bm25(ingestion_chunks) as score
       FROM ingestion_chunks
       WHERE ingestion_chunks MATCH ? AND scope_key = ?
       ORDER BY score ASC
       LIMIT ?`
    );

    const merged = new Map<string, IngestionSearchResult>();
    const strictResults = asRows<IngestionSearchResult>(
      searchStatement.all(queries.strict, scopeKey, limit)
    );
    for (const result of strictResults) {
      merged.set(result.chunkId, result);
    }

    if (merged.size < limit && queries.broad !== queries.strict) {
      const broadResults = asRows<IngestionSearchResult>(
        searchStatement.all(queries.broad, scopeKey, Math.max(limit * 3, limit))
      );
      for (const result of broadResults) {
        if (merged.has(result.chunkId)) {
          continue;
        }
        merged.set(result.chunkId, result);
        if (merged.size >= limit) {
          break;
        }
      }
    }

    return [...merged.values()].slice(0, limit);
  }

  createStudyArtifact(input: { taskId: string; kind: string; title: string; payload: string; filePath?: string }): StudyArtifactRecord {
    const now = new Date().toISOString();
    const record: StudyArtifactRecord = {
      id: randomUUID(),
      taskId: input.taskId,
      kind: input.kind as StudyArtifactRecord["kind"],
      title: input.title,
      payload: input.payload,
      filePath: input.filePath ?? undefined,
      createdAt: now
    };

    this.db
      .prepare(
        `INSERT INTO study_artifacts (id, task_id, kind, title, payload, file_path, created_at)
         VALUES (@id, @taskId, @kind, @title, @payload, @filePath, @createdAt)`
      )
      .run(
        asSqlParams({
          id: record.id,
          taskId: record.taskId,
          kind: record.kind,
          title: record.title,
          payload: record.payload,
          filePath: record.filePath ?? null,
          createdAt: record.createdAt
        })
      );

    return record;
  }

  listStudyArtifacts(taskId: string): StudyArtifactRecord[] {
    return asRows<StudyArtifactRecord>(
      this.db
        .prepare(
          `SELECT
            id,
            task_id as taskId,
            kind,
            title,
            payload,
            file_path as filePath,
            created_at as createdAt
           FROM study_artifacts
           WHERE task_id = ?
           ORDER BY created_at DESC`
        )
        .all(taskId)
    );
  }

  getStudyArtifact(artifactId: string): StudyArtifactRecord | undefined {
    return this.db
      .prepare(
        `SELECT
          id,
          task_id as taskId,
          kind,
          title,
          payload,
          file_path as filePath,
          created_at as createdAt
         FROM study_artifacts
         WHERE id = ?`
      )
      .get(artifactId) as StudyArtifactRecord | undefined;
  }

  updateStudyArtifact(id: string, payload: string): StudyArtifactRecord | undefined {
    this.db
      .prepare(
        `UPDATE study_artifacts SET payload = ? WHERE id = ?`
      )
      .run(payload, id);
    return this.getStudyArtifact(id);
  }

  updateStudyArtifactFilePath(id: string, filePath: string): void {
    this.db
      .prepare(`UPDATE study_artifacts SET file_path = ? WHERE id = ?`)
      .run(filePath, id);
  }

  deleteStudyArtifact(id: string): { deleted: boolean; filePath?: string } {
    const artifact = this.getStudyArtifact(id);
    if (!artifact) return { deleted: false };

    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM card_performance WHERE artifact_id = ?`).run(id);
      this.db.prepare(`DELETE FROM quiz_performance WHERE artifact_id = ?`).run(id);
      this.db.prepare(`DELETE FROM mindmap_node_notes WHERE artifact_id = ?`).run(id);
      this.db.prepare(`DELETE FROM mock_exam_attempts WHERE artifact_id = ?`).run(id);
      this.db.prepare(`DELETE FROM study_artifacts WHERE id = ?`).run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return { deleted: true, filePath: artifact.filePath ?? undefined };
  }

  upsertCardPerformance(input: {
    artifactId: string;
    cardId: string;
    easeFactor: number;
    intervalDays: number;
    repetitions: number;
    nextReviewDate: string;
    lastRating: string;
    totalReviews: number;
    correctCount: number;
  }): CardPerformanceRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO card_performance (id, artifact_id, card_id, ease_factor, interval_days, repetitions, next_review_date, last_rating, total_reviews, correct_count, created_at, updated_at)
         VALUES (@id, @artifactId, @cardId, @easeFactor, @intervalDays, @repetitions, @nextReviewDate, @lastRating, @totalReviews, @correctCount, @createdAt, @updatedAt)
         ON CONFLICT(artifact_id, card_id) DO UPDATE SET
           ease_factor = @easeFactor,
           interval_days = @intervalDays,
           repetitions = @repetitions,
           next_review_date = @nextReviewDate,
           last_rating = @lastRating,
           total_reviews = @totalReviews,
           correct_count = @correctCount,
           updated_at = @updatedAt`
      )
      .run(
        asSqlParams({
          id,
          artifactId: input.artifactId,
          cardId: input.cardId,
          easeFactor: input.easeFactor,
          intervalDays: input.intervalDays,
          repetitions: input.repetitions,
          nextReviewDate: input.nextReviewDate,
          lastRating: input.lastRating,
          totalReviews: input.totalReviews,
          correctCount: input.correctCount,
          createdAt: now,
          updatedAt: now,
        })
      );

    return this.db
      .prepare(
        `SELECT id, artifact_id as artifactId, card_id as cardId, ease_factor as easeFactor,
                interval_days as intervalDays, repetitions, next_review_date as nextReviewDate,
                last_rating as lastRating, total_reviews as totalReviews, correct_count as correctCount,
                created_at as createdAt, updated_at as updatedAt
         FROM card_performance WHERE artifact_id = ? AND card_id = ?`
      )
      .get(input.artifactId, input.cardId) as CardPerformanceRecord;
  }

  listCardPerformance(artifactId: string): CardPerformanceRecord[] {
    return asRows<CardPerformanceRecord>(
      this.db
        .prepare(
          `SELECT id, artifact_id as artifactId, card_id as cardId, ease_factor as easeFactor,
                  interval_days as intervalDays, repetitions, next_review_date as nextReviewDate,
                  last_rating as lastRating, total_reviews as totalReviews, correct_count as correctCount,
                  created_at as createdAt, updated_at as updatedAt
           FROM card_performance WHERE artifact_id = ?`
        )
        .all(artifactId)
    );
  }

  getCardsForReview(artifactId: string): CardPerformanceRecord[] {
    const now = new Date().toISOString();
    return asRows<CardPerformanceRecord>(
      this.db
        .prepare(
          `SELECT id, artifact_id as artifactId, card_id as cardId, ease_factor as easeFactor,
                  interval_days as intervalDays, repetitions, next_review_date as nextReviewDate,
                  last_rating as lastRating, total_reviews as totalReviews, correct_count as correctCount,
                  created_at as createdAt, updated_at as updatedAt
           FROM card_performance WHERE artifact_id = ? AND next_review_date <= ?
           ORDER BY next_review_date ASC`
        )
        .all(artifactId, now)
    );
  }

  getWeakCards(artifactId: string): CardPerformanceRecord[] {
    return asRows<CardPerformanceRecord>(
      this.db
        .prepare(
          `SELECT id, artifact_id as artifactId, card_id as cardId, ease_factor as easeFactor,
                  interval_days as intervalDays, repetitions, next_review_date as nextReviewDate,
                  last_rating as lastRating, total_reviews as totalReviews, correct_count as correctCount,
                  created_at as createdAt, updated_at as updatedAt
           FROM card_performance WHERE artifact_id = ? AND ease_factor < 1.8
           ORDER BY ease_factor ASC`
        )
        .all(artifactId)
    );
  }

  createQuizPerformance(input: {
    artifactId: string;
    questionId: string;
    attemptNumber: number;
    selectedAnswer: string | null;
    isCorrect: boolean;
    difficultyFlag: string | null;
  }): QuizPerformanceRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO quiz_performance (id, artifact_id, question_id, attempt_number, selected_answer, is_correct, difficulty_flag, attempted_at)
         VALUES (@id, @artifactId, @questionId, @attemptNumber, @selectedAnswer, @isCorrect, @difficultyFlag, @attemptedAt)
         ON CONFLICT(artifact_id, question_id, attempt_number) DO UPDATE SET
           selected_answer = @selectedAnswer,
           is_correct = @isCorrect,
           difficulty_flag = @difficultyFlag,
           attempted_at = @attemptedAt`
      )
      .run(
        asSqlParams({
          id,
          artifactId: input.artifactId,
          questionId: input.questionId,
          attemptNumber: input.attemptNumber,
          selectedAnswer: input.selectedAnswer,
          isCorrect: input.isCorrect ? 1 : 0,
          difficultyFlag: input.difficultyFlag,
          attemptedAt: now,
        })
      );

    return {
      id,
      artifactId: input.artifactId,
      questionId: input.questionId,
      attemptNumber: input.attemptNumber,
      selectedAnswer: input.selectedAnswer,
      isCorrect: input.isCorrect,
      difficultyFlag: input.difficultyFlag,
      attemptedAt: now,
    };
  }

  listQuizPerformance(artifactId: string): QuizPerformanceRecord[] {
    return asRows<QuizPerformanceRecord>(
      this.db
        .prepare(
          `SELECT id, artifact_id as artifactId, question_id as questionId,
                  attempt_number as attemptNumber, selected_answer as selectedAnswer,
                  is_correct as isCorrect, difficulty_flag as difficultyFlag,
                  attempted_at as attemptedAt
           FROM quiz_performance WHERE artifact_id = ?
           ORDER BY attempted_at DESC`
        )
        .all(artifactId)
    ).map(r => ({ ...r, isCorrect: Boolean(r.isCorrect) }));
  }

  upsertNodeNote(input: {
    artifactId: string;
    nodeId: string;
    content: string;
  }): MindMapNodeNote {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO mindmap_node_notes (id, artifact_id, node_id, content, created_at, updated_at)
         VALUES (@id, @artifactId, @nodeId, @content, @createdAt, @updatedAt)
         ON CONFLICT(artifact_id, node_id) DO UPDATE SET
           content = @content,
           updated_at = @updatedAt`
      )
      .run(
        asSqlParams({
          id,
          artifactId: input.artifactId,
          nodeId: input.nodeId,
          content: input.content,
          createdAt: now,
          updatedAt: now,
        })
      );

    return this.db
      .prepare(
        `SELECT id, artifact_id as artifactId, node_id as nodeId, content,
                created_at as createdAt, updated_at as updatedAt
         FROM mindmap_node_notes WHERE artifact_id = ? AND node_id = ?`
      )
      .get(input.artifactId, input.nodeId) as MindMapNodeNote;
  }

  listNodeNotes(artifactId: string): MindMapNodeNote[] {
    return asRows<MindMapNodeNote>(
      this.db
        .prepare(
          `SELECT id, artifact_id as artifactId, node_id as nodeId, content,
                  created_at as createdAt, updated_at as updatedAt
           FROM mindmap_node_notes WHERE artifact_id = ?`
        )
        .all(artifactId)
    );
  }

  deleteNodeNote(artifactId: string, nodeId: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM mindmap_node_notes WHERE artifact_id = ? AND node_id = ?`)
      .run(artifactId, nodeId);
    return (result as { changes: number }).changes > 0;
  }

  createMockExamAttempt(input: {
    artifactId: string;
    answers: string;
    totalMarks: number;
  }): MockExamAttempt {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO mock_exam_attempts (id, artifact_id, answers, score, total_marks, time_taken_seconds, started_at, completed_at)
         VALUES (@id, @artifactId, @answers, NULL, @totalMarks, NULL, @startedAt, NULL)`
      )
      .run(
        asSqlParams({
          id,
          artifactId: input.artifactId,
          answers: input.answers,
          totalMarks: input.totalMarks,
          startedAt: now,
        })
      );

    return {
      id,
      artifactId: input.artifactId,
      answers: input.answers,
      score: null,
      totalMarks: input.totalMarks,
      timeTakenSeconds: null,
      startedAt: now,
      completedAt: null,
    };
  }

  updateMockExamAttempt(id: string, update: {
    answers?: string;
    score?: number;
    timeTakenSeconds?: number;
    completedAt?: string;
  }): MockExamAttempt | undefined {
    const sets: string[] = [];
    const values: SQLInputValue[] = [];

    if (update.answers !== undefined) {
      sets.push("answers = ?");
      values.push(update.answers);
    }
    if (update.score !== undefined) {
      sets.push("score = ?");
      values.push(update.score);
    }
    if (update.timeTakenSeconds !== undefined) {
      sets.push("time_taken_seconds = ?");
      values.push(update.timeTakenSeconds);
    }
    if (update.completedAt !== undefined) {
      sets.push("completed_at = ?");
      values.push(update.completedAt);
    }

    if (sets.length === 0) return this.getMockExamAttempt(id);

    values.push(id);
    this.db
      .prepare(`UPDATE mock_exam_attempts SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values);

    return this.getMockExamAttempt(id);
  }

  getMockExamAttempt(id: string): MockExamAttempt | undefined {
    return this.db
      .prepare(
        `SELECT id, artifact_id as artifactId, answers, score, total_marks as totalMarks,
                time_taken_seconds as timeTakenSeconds, started_at as startedAt, completed_at as completedAt
         FROM mock_exam_attempts WHERE id = ?`
      )
      .get(id) as MockExamAttempt | undefined;
  }

  listMockExamAttempts(artifactId: string): MockExamAttempt[] {
    return asRows<MockExamAttempt>(
      this.db
        .prepare(
          `SELECT id, artifact_id as artifactId, answers, score, total_marks as totalMarks,
                  time_taken_seconds as timeTakenSeconds, started_at as startedAt, completed_at as completedAt
           FROM mock_exam_attempts WHERE artifact_id = ?
           ORDER BY started_at DESC`
        )
        .all(artifactId)
    );
  }

  /* ---- Study Sessions ---- */

  createStudySession(input: {
    taskId: string;
    projectId: string;
    artifactIds?: string[];
  }): StudySessionRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO study_sessions (id, task_id, project_id, started_at, artifact_ids_json)
         VALUES (@id, @taskId, @projectId, @startedAt, @artifactIdsJson)`
      )
      .run(
        asSqlParams({
          id,
          taskId: input.taskId,
          projectId: input.projectId,
          startedAt: now,
          artifactIdsJson: JSON.stringify(input.artifactIds ?? []),
        })
      );

    return {
      id,
      taskId: input.taskId,
      projectId: input.projectId,
      startedAt: now,
      endedAt: null,
      cardsReviewed: 0,
      questionsAnswered: 0,
      correctCount: 0,
      artifactIdsJson: JSON.stringify(input.artifactIds ?? []),
    };
  }

  updateStudySession(id: string, update: {
    endedAt?: string;
    cardsReviewed?: number;
    questionsAnswered?: number;
    correctCount?: number;
    artifactIdsJson?: string;
  }): StudySessionRecord | undefined {
    const sets: string[] = [];
    const values: SQLInputValue[] = [];

    if (update.endedAt !== undefined) {
      sets.push("ended_at = ?");
      values.push(update.endedAt);
    }
    if (update.cardsReviewed !== undefined) {
      sets.push("cards_reviewed = ?");
      values.push(update.cardsReviewed);
    }
    if (update.questionsAnswered !== undefined) {
      sets.push("questions_answered = ?");
      values.push(update.questionsAnswered);
    }
    if (update.correctCount !== undefined) {
      sets.push("correct_count = ?");
      values.push(update.correctCount);
    }
    if (update.artifactIdsJson !== undefined) {
      sets.push("artifact_ids_json = ?");
      values.push(update.artifactIdsJson);
    }

    if (sets.length === 0) return this.getStudySession(id);

    values.push(id);
    this.db
      .prepare(`UPDATE study_sessions SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values);

    return this.getStudySession(id);
  }

  getStudySession(id: string): StudySessionRecord | undefined {
    return this.db
      .prepare(
        `SELECT id, task_id as taskId, project_id as projectId, started_at as startedAt,
                ended_at as endedAt, cards_reviewed as cardsReviewed,
                questions_answered as questionsAnswered, correct_count as correctCount,
                artifact_ids_json as artifactIdsJson
         FROM study_sessions WHERE id = ?`
      )
      .get(id) as StudySessionRecord | undefined;
  }

  getActiveStudySession(taskId: string): StudySessionRecord | undefined {
    return this.db
      .prepare(
        `SELECT id, task_id as taskId, project_id as projectId, started_at as startedAt,
                ended_at as endedAt, cards_reviewed as cardsReviewed,
                questions_answered as questionsAnswered, correct_count as correctCount,
                artifact_ids_json as artifactIdsJson
         FROM study_sessions
         WHERE task_id = ? AND ended_at IS NULL
         ORDER BY started_at DESC LIMIT 1`
      )
      .get(taskId) as StudySessionRecord | undefined;
  }

  listStudySessions(projectId: string, limit = 50): StudySessionRecord[] {
    return asRows<StudySessionRecord>(
      this.db
        .prepare(
          `SELECT id, task_id as taskId, project_id as projectId, started_at as startedAt,
                  ended_at as endedAt, cards_reviewed as cardsReviewed,
                  questions_answered as questionsAnswered, correct_count as correctCount,
                  artifact_ids_json as artifactIdsJson
           FROM study_sessions
           WHERE project_id = ?
           ORDER BY started_at DESC
           LIMIT ?`
        )
        .all(projectId, limit)
    );
  }

  /* ---- Topic Performance ---- */

  upsertTopicPerformance(input: {
    projectId: string;
    taskId: string;
    topic: string;
    correct: boolean;
    artifactId?: string;
  }): void {
    const now = new Date().toISOString();
    const id = randomUUID();
    const existing = this.db
      .prepare(
        `SELECT id, source_artifact_ids_json as sourceArtifactIdsJson
         FROM topic_performance
         WHERE project_id = ? AND topic = ?`
      )
      .get(input.projectId, input.topic) as
      | { id: string; sourceArtifactIdsJson: string }
      | undefined;

    if (existing) {
      const artifactIds: string[] = JSON.parse(existing.sourceArtifactIdsJson);
      if (input.artifactId && !artifactIds.includes(input.artifactId)) {
        artifactIds.push(input.artifactId);
      }
      this.db
        .prepare(
          `UPDATE topic_performance
           SET total_attempts = total_attempts + 1,
               correct_count = correct_count + ?,
               last_attempted_at = ?,
               source_artifact_ids_json = ?
           WHERE id = ?`
        )
        .run(input.correct ? 1 : 0, now, JSON.stringify(artifactIds), existing.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO topic_performance (id, project_id, task_id, topic, total_attempts, correct_count, last_attempted_at, source_artifact_ids_json)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
        )
        .run(
          id,
          input.projectId,
          input.taskId,
          input.topic,
          input.correct ? 1 : 0,
          now,
          JSON.stringify(input.artifactId ? [input.artifactId] : [])
        );
    }
  }

  listWeakTopics(projectId: string, limit = 10): TopicPerformanceRecord[] {
    return asRows<TopicPerformanceRecord>(
      this.db
        .prepare(
          `SELECT id, project_id as projectId, task_id as taskId, topic,
                  total_attempts as totalAttempts, correct_count as correctCount,
                  last_attempted_at as lastAttemptedAt,
                  source_artifact_ids_json as sourceArtifactIdsJson
           FROM topic_performance
           WHERE project_id = ? AND total_attempts > 0
           ORDER BY (CAST(correct_count AS REAL) / total_attempts) ASC,
                    total_attempts DESC
           LIMIT ?`
        )
        .all(projectId, limit)
    );
  }

  listTopicPerformance(projectId: string): TopicPerformanceRecord[] {
    return asRows<TopicPerformanceRecord>(
      this.db
        .prepare(
          `SELECT id, project_id as projectId, task_id as taskId, topic,
                  total_attempts as totalAttempts, correct_count as correctCount,
                  last_attempted_at as lastAttemptedAt,
                  source_artifact_ids_json as sourceArtifactIdsJson
           FROM topic_performance
           WHERE project_id = ?
           ORDER BY total_attempts DESC`
        )
        .all(projectId)
    );
  }

  /* ---- Aggregated Analytics ---- */

  getProjectLearningSummary(projectId: string): ProjectLearningSummary {
    // Total reviews and accuracy from card + quiz performance across all tasks in project
    const tasks = this.listTasksByProject(projectId);
    const taskIds = tasks.map((t) => t.id);

    let totalReviews = 0;
    let totalCorrect = 0;
    let cardsDue = 0;
    let totalArtifacts = 0;
    let lastStudiedAt: string | null = null;

    const now = new Date().toISOString();

    for (const taskId of taskIds) {
      const artifacts = this.listStudyArtifacts(taskId);
      totalArtifacts += artifacts.length;

      for (const artifact of artifacts) {
        if (artifact.kind === "flashcards") {
          const cards = this.listCardPerformance(artifact.id);
          for (const card of cards) {
            totalReviews += card.totalReviews;
            totalCorrect += card.correctCount;
            if (card.nextReviewDate <= now) cardsDue++;
          }
        }
        if (artifact.kind === "quiz") {
          const quizzes = this.listQuizPerformance(artifact.id);
          totalReviews += quizzes.length;
          totalCorrect += quizzes.filter((q) => q.isCorrect).length;
        }
      }
    }

    // Streak from study sessions
    const sessions = this.listStudySessions(projectId, 365);
    const streakDays = computeStreak(sessions);
    if (sessions.length > 0) {
      lastStudiedAt = sessions[0]!.startedAt;
    }

    const weakTopics = this.listWeakTopics(projectId, 5);
    const overallAccuracy = totalReviews > 0 ? totalCorrect / totalReviews : 0;

    return {
      projectId,
      totalReviews,
      overallAccuracy,
      streakDays,
      weakTopics,
      cardsDue,
      lastStudiedAt,
      totalArtifacts,
    };
  }

  getTaskPerformanceBreakdown(taskId: string): TaskPerformanceBreakdown {
    const artifacts = this.listStudyArtifacts(taskId);
    let cardsDue = 0;
    let totalCards = 0;
    let quizCorrect = 0;
    let totalQuizQuestions = 0;
    const now = new Date().toISOString();

    for (const artifact of artifacts) {
      if (artifact.kind === "flashcards") {
        const cards = this.listCardPerformance(artifact.id);
        totalCards += cards.length;
        for (const card of cards) {
          if (card.nextReviewDate <= now) cardsDue++;
        }
      }
      if (artifact.kind === "quiz") {
        const quizzes = this.listQuizPerformance(artifact.id);
        totalQuizQuestions += quizzes.length;
        quizCorrect += quizzes.filter((q) => q.isCorrect).length;
      }
    }

    return {
      taskId,
      cardsDue,
      quizAccuracy: totalQuizQuestions > 0 ? quizCorrect / totalQuizQuestions : 0,
      totalCards,
      totalQuizQuestions,
      artifactCount: artifacts.length,
    };
  }

  getStudyTimeline(projectId: string, days = 30): StudyTimelineEntry[] {
    const sessions = this.listStudySessions(projectId, 1000);
    const now = new Date();
    const entries: StudyTimelineEntry[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().slice(0, 10);

      const daySessions = sessions.filter(
        (s) => s.startedAt.slice(0, 10) === dateStr
      );

      const reviews = daySessions.reduce(
        (sum, s) => sum + s.cardsReviewed + s.questionsAnswered,
        0
      );
      const correct = daySessions.reduce((sum, s) => sum + s.correctCount, 0);

      entries.push({
        date: dateStr,
        sessions: daySessions.length,
        reviews,
        accuracy: reviews > 0 ? correct / reviews : 0,
      });
    }

    return entries;
  }

  // ---- Student Memory ----

  createStudentMemory(input: CreateStudentMemoryInput): StudentMemoryRecord {
    const now = new Date().toISOString();
    const id = randomUUID();

    // If a memory_key is provided, supersede existing memories with the same key
    if (input.memoryKey) {
      const existing = this.db
        .prepare(
          `SELECT id FROM student_memories
           WHERE memory_key = ? AND superseded_by IS NULL
           ORDER BY created_at DESC`
        )
        .all(input.memoryKey) as Array<{ id: string }>;

      for (const old of existing) {
        this.db
          .prepare(`UPDATE student_memories SET superseded_by = ? WHERE id = ?`)
          .run(id, old.id);
      }
    }

    const record: StudentMemoryRecord = {
      id,
      scopeType: input.scopeType,
      scopeId: input.scopeId ?? null,
      category: input.category,
      topic: input.topic ?? null,
      memoryKey: input.memoryKey ?? null,
      content: input.content,
      sourceKind: input.sourceKind,
      sourceMessageId: input.sourceMessageId ?? null,
      createdAt: now,
      eventDate: input.eventDate ?? null,
      expiresAt: input.expiresAt ?? null,
      supersededBy: null,
      accessCount: 0
    };

    this.db
      .prepare(
        `INSERT INTO student_memories
         (id, scope_type, scope_id, category, topic, memory_key, content, source_kind, source_message_id, created_at, event_date, expires_at, superseded_by, access_count)
         VALUES (@id, @scopeType, @scopeId, @category, @topic, @memoryKey, @content, @sourceKind, @sourceMessageId, @createdAt, @eventDate, @expiresAt, @supersededBy, @accessCount)`
      )
      .run(
        asSqlParams({
          id: record.id,
          scopeType: record.scopeType,
          scopeId: record.scopeId,
          category: record.category,
          topic: record.topic,
          memoryKey: record.memoryKey,
          content: record.content,
          sourceKind: record.sourceKind,
          sourceMessageId: record.sourceMessageId,
          createdAt: record.createdAt,
          eventDate: record.eventDate,
          expiresAt: record.expiresAt,
          supersededBy: record.supersededBy,
          accessCount: record.accessCount
        })
      );

    return record;
  }

  queryStudentMemories(projectId: string, limit = 12): StudentMemoryRecord[] {
    const now = new Date().toISOString();
    const rows = asRows<StudentMemoryRecord>(
      this.db
        .prepare(
          `SELECT
            id,
            scope_type as scopeType,
            scope_id as scopeId,
            category,
            topic,
            memory_key as memoryKey,
            content,
            source_kind as sourceKind,
            source_message_id as sourceMessageId,
            created_at as createdAt,
            event_date as eventDate,
            expires_at as expiresAt,
            superseded_by as supersededBy,
            access_count as accessCount
           FROM student_memories
           WHERE (scope_type = 'global' OR (scope_type = 'project' AND scope_id = ?))
             AND superseded_by IS NULL
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY
             CASE category
               WHEN 'progress' THEN 1
               WHEN 'goal' THEN 2
               WHEN 'preference' THEN 3
               WHEN 'fact' THEN 4
               WHEN 'context' THEN 5
             END,
             created_at DESC
           LIMIT ?`
        )
        .all(projectId, now, limit)
    );

    // Update access counts
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      for (const memId of ids) {
        this.db
          .prepare(`UPDATE student_memories SET access_count = access_count + 1 WHERE id = ?`)
          .run(memId);
      }
    }

    return rows;
  }

  hasStudentMemories(projectId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM student_memories
         WHERE scope_type = 'global' OR (scope_type = 'project' AND scope_id = ?)`
      )
      .get(projectId) as { cnt: number } | undefined;
    return (row?.cnt ?? 0) > 0;
  }

  close(): void {
    this.db.close();
  }

  private mapTask(row: DbTaskRow): TaskSpec {
    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      objective: row.objective,
      globalInstructionProfileId: row.globalInstructionProfileId,
      folderInstructionIds: JSON.parse(row.folderInstructionIdsJson),
      attachments: JSON.parse(row.attachmentsJson),
      networkPolicyId: row.networkPolicyId,
      authMode: row.authMode,
      browserEnabled: Boolean(row.browserEnabled),
      scheduleRRule: row.scheduleRRule,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  private mapTaskWorker(row: DbTaskWorkerRow): TaskWorkerRecord {
    return {
      id: row.id,
      parentTaskId: row.taskId,
      taskRunId: row.taskRunId,
      parentWorkerId: row.parentWorkerId,
      role: row.role,
      objective: row.objective,
      attachmentIds: JSON.parse(row.attachmentIdsJson),
      toolProfileId: row.toolProfileId,
      status: row.status,
      threadId: row.threadId,
      summary: row.summary,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt
    };
  }
}

function asRows<T>(rows: unknown): T[] {
  return rows as T[];
}

function groupMessagesByTask(messages: TaskMessageRecord[]) {
  const grouped = new Map<string, TaskMessageRecord[]>();
  for (const message of messages) {
    const taskMessages = grouped.get(message.taskId);
    if (taskMessages) {
      taskMessages.push(message);
      continue;
    }
    grouped.set(message.taskId, [message]);
  }
  return grouped;
}

function isLegacySyntheticAssistantMessage(content: string): boolean {
  return [
    /^No folders are attached yet, so the next step is to grant scope\./,
    /^I have \d+ scoped folder/,
    /^Browser automation is available if the local material is incomplete\./,
    /^I will stay inside local files unless you expand the task later\./,
    /^Noted\. I will treat that as a scope change/,
    /^Understood\. I will fold that into the deliverable plan/,
    /^Noted\. I will incorporate that into the next run and keep browser work inside the guest environment\./,
    /^Noted\. I will incorporate that into the next run and keep the task scoped to the approved local workspace\./
  ].some((pattern) => pattern.test(content));
}

function asSqlParams(
  value: Record<string, string | number | bigint | Uint8Array | null | undefined | boolean>
): Record<string, SQLInputValue> {
  return Object.fromEntries(
    Object.entries(value).map(([key, current]) => [
      key,
      typeof current === "boolean" ? Number(current) : current ?? null
    ])
  ) as Record<string, SQLInputValue>;
}

function buildIngestionScopeKey(taskId: string, taskRunId?: string): string {
  return taskRunId ? `${taskId}:${taskRunId}` : `${taskId}:global`;
}

const FTS_STOP_WORDS = new Set([
  "the", "is", "at", "in", "on", "an", "and", "or", "of", "to", "for",
  "it", "by", "be", "as", "do", "no", "so", "if", "up", "my", "me",
  "we", "he", "am", "are", "was", "has", "had", "not", "but", "you",
  "can", "its", "our", "his", "her", "all", "one", "two", "how", "what",
  "when", "who", "why", "from", "with", "this", "that", "they", "them",
  "will", "have", "been", "than", "into", "each", "also", "more",
  "about", "which", "their", "would", "could", "should", "these", "those",
]);

function tokenizeFtsQuery(value: string): string[] {
  return [...new Set(
    value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !FTS_STOP_WORDS.has(token))
    .slice(0, 20)
  )];
}

function computeStreak(sessions: StudySessionRecord[]): number {
  if (sessions.length === 0) return 0;

  const uniqueDays = new Set(sessions.map((s) => s.startedAt.slice(0, 10)));
  const sorted = [...uniqueDays].sort().reverse();

  const today = new Date().toISOString().slice(0, 10);
  // Streak must include today or yesterday
  if (sorted[0] !== today) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (sorted[0] !== yesterday) return 0;
  }

  let streak = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1]!);
    const curr = new Date(sorted[i]!);
    const diffMs = prev.getTime() - curr.getTime();
    if (diffMs <= 86400000 * 1.5) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

function buildFtsQueries(value: string): { strict: string; broad: string } | null {
  const tokens = tokenizeFtsQuery(value);
  if (tokens.length === 0) {
    return null;
  }

  const prefixedTerms = tokens.map((token) => `"${token}"*`);
  return {
    strict: prefixedTerms.join(" AND "),
    broad: prefixedTerms.join(" OR "),
  };
}
