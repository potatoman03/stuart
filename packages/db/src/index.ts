import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  ApprovalRecord,
  ArtifactRecord,
  CanvasAssignmentRecord,
  CanvasConnectionRecord,
  CanvasCourseMappingRecord,
  CanvasModuleRecord,
  CanvasSyncedFileRecord,
  CardPerformanceRecord,
  CreateCanvasConnectionInput,
  CreateProjectInput,
  CreateStudentMemoryInput,
  CreateTaskInput,
  CreateWorkerInput,
  UpdateProjectInput,
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
  UpdateTaskInput,
  WorkspaceConfig
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
        file_path TEXT,
        preview_path TEXT,
        payload_version INTEGER NOT NULL DEFAULT 1,
        render_status TEXT,
        preview_status TEXT,
        render_error TEXT,
        preview_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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

    // Add study_artifact columns idempotently for older local DBs.
    try {
      this.db.exec(`ALTER TABLE study_artifacts ADD COLUMN file_path TEXT`);
    } catch {
      // Column already exists — safe to ignore
    }
    try {
      this.db.exec(`ALTER TABLE study_artifacts ADD COLUMN preview_path TEXT`);
    } catch {
      // Column already exists — safe to ignore
    }
    try {
      this.db.exec(`ALTER TABLE study_artifacts ADD COLUMN payload_version INTEGER NOT NULL DEFAULT 1`);
    } catch {
      // Column already exists — safe to ignore
    }
    try {
      this.db.exec(`ALTER TABLE study_artifacts ADD COLUMN render_status TEXT`);
    } catch {
      // Column already exists — safe to ignore
    }
    try {
      this.db.exec(`ALTER TABLE study_artifacts ADD COLUMN preview_status TEXT`);
    } catch {
      // Column already exists — safe to ignore
    }
    try {
      this.db.exec(`ALTER TABLE study_artifacts ADD COLUMN render_error TEXT`);
    } catch {
      // Column already exists — safe to ignore
    }
    try {
      this.db.exec(`ALTER TABLE study_artifacts ADD COLUMN preview_error TEXT`);
    } catch {
      // Column already exists — safe to ignore
    }
    try {
      this.db.exec(`ALTER TABLE study_artifacts ADD COLUMN updated_at TEXT`);
      this.db.exec(`UPDATE study_artifacts SET updated_at = created_at WHERE updated_at IS NULL`);
    } catch {
      // Column already exists — safe to ignore
    }

    // Workspace onboarding config on projects
    try {
      this.db.exec("ALTER TABLE projects ADD COLUMN config_json TEXT");
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

    // Canvas LMS integration tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS canvas_connections (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        base_url TEXT NOT NULL,
        user_display_name TEXT,
        user_id TEXT,
        token_encrypted TEXT,
        token_plaintext TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        last_verified_at TEXT,
        last_sync_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS canvas_course_mappings (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        canvas_course_id TEXT NOT NULL,
        canvas_course_name TEXT NOT NULL,
        canvas_course_code TEXT,
        canvas_term_name TEXT,
        project_id TEXT,
        root_path TEXT,
        sync_enabled INTEGER NOT NULL DEFAULT 1,
        last_synced_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(connection_id, canvas_course_id)
      );

      CREATE TABLE IF NOT EXISTS canvas_synced_files (
        id TEXT PRIMARY KEY,
        course_mapping_id TEXT NOT NULL,
        canvas_file_id TEXT NOT NULL,
        canvas_folder_path TEXT,
        filename TEXT NOT NULL,
        content_type TEXT,
        size INTEGER,
        canvas_updated_at TEXT NOT NULL,
        local_path TEXT NOT NULL,
        download_status TEXT NOT NULL DEFAULT 'pending',
        last_downloaded_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(course_mapping_id, canvas_file_id)
      );

      CREATE TABLE IF NOT EXISTS canvas_assignments (
        id TEXT PRIMARY KEY,
        course_mapping_id TEXT NOT NULL,
        canvas_assignment_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        due_at TEXT,
        points_possible REAL,
        submission_score REAL,
        submission_grade TEXT,
        submission_submitted_at TEXT,
        assignment_group_name TEXT,
        canvas_updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(course_mapping_id, canvas_assignment_id)
      );

      CREATE TABLE IF NOT EXISTS canvas_modules (
        id TEXT PRIMARY KEY,
        course_mapping_id TEXT NOT NULL,
        canvas_module_id TEXT NOT NULL,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        items_json TEXT NOT NULL DEFAULT '[]',
        canvas_updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(course_mapping_id, canvas_module_id)
      );

      CREATE TABLE IF NOT EXISTS codex_usage_snapshots (
        id TEXT PRIMARY KEY,
        captured_at TEXT NOT NULL DEFAULT (datetime('now')),
        primary_used_percent REAL,
        primary_resets_at TEXT,
        primary_window_mins INTEGER,
        secondary_used_percent REAL,
        secondary_resets_at TEXT,
        secondary_window_mins INTEGER,
        has_credits INTEGER,
        credits_unlimited INTEGER,
        credits_balance TEXT,
        plan_type TEXT,
        email TEXT,
        source TEXT DEFAULT 'rpc'
      );

      CREATE TABLE IF NOT EXISTS codex_turn_metrics (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        captured_at TEXT NOT NULL DEFAULT (datetime('now')),
        model TEXT,
        effort TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cached_input_tokens INTEGER DEFAULT 0,
        reasoning_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0
      );
    `);
  }

  listProjects(): ProjectRecord[] {
    const rows = asRows<ProjectRecord & { configJson?: string }>(
      this.db
      .prepare(
        `SELECT id, name, root_path as rootPath, config_json as configJson, created_at as createdAt, updated_at as updatedAt
         FROM projects
         ORDER BY updated_at DESC`
      )
      .all()
    );
    return rows.map(({ configJson, ...rest }) => ({
      ...rest,
      config: configJson ? JSON.parse(configJson) as WorkspaceConfig : undefined
    }));
  }

  createProject(input: CreateProjectInput): ProjectRecord {
    const now = new Date().toISOString();
    const record: ProjectRecord = {
      id: randomUUID(),
      name: input.name,
      rootPath: input.rootPath,
      config: input.config,
      createdAt: now,
      updatedAt: now
    };

    this.db
      .prepare(
        `INSERT INTO projects (id, name, root_path, config_json, created_at, updated_at)
         VALUES (@id, @name, @rootPath, @configJson, @createdAt, @updatedAt)`
      )
      .run(
        asSqlParams({
          id: record.id,
          name: record.name,
          rootPath: record.rootPath,
          configJson: record.config ? JSON.stringify(record.config) : null,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt
        })
      );

    return record;
  }

  getProject(projectId: string): ProjectRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, name, root_path as rootPath, config_json as configJson, created_at as createdAt, updated_at as updatedAt
         FROM projects
         WHERE id = ?`
      )
      .get(projectId) as (ProjectRecord & { configJson?: string }) | undefined;
    if (!row) return undefined;
    const { configJson, ...rest } = row;
    return {
      ...rest,
      config: configJson ? JSON.parse(configJson) as WorkspaceConfig : undefined
    };
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

  updateProject(projectId: string, input: UpdateProjectInput): ProjectRecord {
    const current = this.getProject(projectId);
    if (!current) {
      throw new Error(`Project ${projectId} not found.`);
    }

    const now = new Date().toISOString();
    const updatedName = input.name ?? current.name;
    const updatedConfig = input.config !== undefined ? input.config : current.config;

    this.db
      .prepare(
        `UPDATE projects
         SET name = @name,
             config_json = @configJson,
             updated_at = @updatedAt
         WHERE id = @id`
      )
      .run(asSqlParams({
        id: projectId,
        name: updatedName,
        configJson: updatedConfig ? JSON.stringify(updatedConfig) : null,
        updatedAt: now
      }));

    return {
      ...current,
      name: updatedName,
      config: updatedConfig,
      updatedAt: now
    };
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
      source?: string;
    }
  ): IngestionSearchResult[] {
    const queries = buildFtsQueries(query);
    if (!queries) {
      return [];
    }

    const scopeKey = buildIngestionScopeKey(taskId, options?.taskRunId);
    const limit = options?.limit ?? 8;
    const sourceFilter = options?.source?.trim();
    const sourceMatch = sourceFilter ? buildSourcePathMatch(sourceFilter) : null;
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
       WHERE ingestion_chunks MATCH ? AND scope_key = ?${
         sourceMatch ? " AND (relative_path = ? OR relative_path = ? OR relative_path LIKE ?)" : ""
       }
       ORDER BY score ASC
       LIMIT ?`
    );

    const merged = new Map<string, IngestionSearchResult>();
    const strictResults = asRows<IngestionSearchResult>(
      sourceMatch
        ? searchStatement.all(
            queries.strict,
            scopeKey,
            sourceMatch.exact,
            sourceMatch.stripped,
            sourceMatch.suffixLike,
            limit
          )
        : searchStatement.all(queries.strict, scopeKey, limit)
    );
    for (const result of strictResults) {
      merged.set(result.chunkId, result);
    }

    if (merged.size < limit && queries.broad !== queries.strict) {
      const broadResults = asRows<IngestionSearchResult>(
        sourceMatch
          ? searchStatement.all(
              queries.broad,
              scopeKey,
              sourceMatch.exact,
              sourceMatch.stripped,
              sourceMatch.suffixLike,
              Math.max(limit * 3, limit)
            )
          : searchStatement.all(queries.broad, scopeKey, Math.max(limit * 3, limit))
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

  getChunksBySource(
    taskId: string,
    relativePath: string,
    options?: { taskRunId?: string; limit?: number }
  ): IngestionSearchResult[] {
    const scopeKey = buildIngestionScopeKey(taskId, options?.taskRunId);
    const limit = options?.limit ?? 5;
    const sourceMatch = buildSourcePathMatch(relativePath);
    return asRows<IngestionSearchResult>(
      this.db.prepare(
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
          '' as snippet,
          0 as score
         FROM ingestion_chunks
         WHERE scope_key = ? AND (relative_path = ? OR relative_path = ? OR relative_path LIKE ?)
         ORDER BY CAST(REPLACE(REPLACE(locator, 'page ', ''), 'chunk ', '') AS INTEGER) ASC
         LIMIT ?`
      ).all(scopeKey, sourceMatch.exact, sourceMatch.stripped, sourceMatch.suffixLike, limit)
    );
  }

  createStudyArtifact(input: {
    taskId: string;
    kind: string;
    title: string;
    payload: string;
    filePath?: string;
    previewPath?: string;
    payloadVersion?: number;
    renderStatus?: StudyArtifactRecord["renderStatus"];
    previewStatus?: StudyArtifactRecord["previewStatus"];
    renderError?: string;
    previewError?: string;
  }): StudyArtifactRecord {
    const now = new Date().toISOString();
    const record: StudyArtifactRecord = {
      id: randomUUID(),
      taskId: input.taskId,
      kind: input.kind as StudyArtifactRecord["kind"],
      title: input.title,
      payload: input.payload,
      filePath: input.filePath ?? undefined,
      previewPath: input.previewPath ?? undefined,
      payloadVersion: input.payloadVersion ?? 1,
      renderStatus: input.renderStatus,
      previewStatus: input.previewStatus,
      renderError: input.renderError,
      previewError: input.previewError,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO study_artifacts (
          id,
          task_id,
          kind,
          title,
          payload,
          file_path,
          preview_path,
          payload_version,
          render_status,
          preview_status,
          render_error,
          preview_error,
          created_at,
          updated_at
        )
         VALUES (
          @id,
          @taskId,
          @kind,
          @title,
          @payload,
          @filePath,
          @previewPath,
          @payloadVersion,
          @renderStatus,
          @previewStatus,
          @renderError,
          @previewError,
          @createdAt,
          @updatedAt
        )`
      )
      .run(
        asSqlParams({
          id: record.id,
          taskId: record.taskId,
          kind: record.kind,
          title: record.title,
          payload: record.payload,
          filePath: record.filePath ?? null,
          previewPath: record.previewPath ?? null,
          payloadVersion: record.payloadVersion ?? 1,
          renderStatus: record.renderStatus ?? null,
          previewStatus: record.previewStatus ?? null,
          renderError: record.renderError ?? null,
          previewError: record.previewError ?? null,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt ?? record.createdAt,
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
            preview_path as previewPath,
            payload_version as payloadVersion,
            render_status as renderStatus,
            preview_status as previewStatus,
            render_error as renderError,
            preview_error as previewError,
            created_at as createdAt
            ,
            updated_at as updatedAt
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
          preview_path as previewPath,
          payload_version as payloadVersion,
          render_status as renderStatus,
          preview_status as previewStatus,
          render_error as renderError,
          preview_error as previewError,
          created_at as createdAt
          ,
          updated_at as updatedAt
         FROM study_artifacts
         WHERE id = ?`
      )
      .get(artifactId) as StudyArtifactRecord | undefined;
  }

  updateStudyArtifact(id: string, payload: string): StudyArtifactRecord | undefined {
    this.db
      .prepare(
        `UPDATE study_artifacts SET payload = ?, updated_at = ? WHERE id = ?`
      )
      .run(payload, new Date().toISOString(), id);
    return this.getStudyArtifact(id);
  }

  updateStudyArtifactFilePath(id: string, filePath: string): void {
    this.db
      .prepare(`UPDATE study_artifacts SET file_path = ?, updated_at = ? WHERE id = ?`)
      .run(filePath, new Date().toISOString(), id);
  }

  updateStudyArtifactLifecycle(
    id: string,
    updates: {
      payload?: string;
      filePath?: string | null;
      previewPath?: string | null;
      payloadVersion?: number;
      renderStatus?: StudyArtifactRecord["renderStatus"];
      previewStatus?: StudyArtifactRecord["previewStatus"];
      renderError?: string | null;
      previewError?: string | null;
    }
  ): StudyArtifactRecord | undefined {
    const current = this.getStudyArtifact(id);
    if (!current) {
      return undefined;
    }

    const next: StudyArtifactRecord = {
      ...current,
      payload: updates.payload ?? current.payload,
      filePath: updates.filePath === undefined ? current.filePath : updates.filePath ?? undefined,
      previewPath: updates.previewPath === undefined ? current.previewPath : updates.previewPath ?? undefined,
      payloadVersion: updates.payloadVersion ?? current.payloadVersion ?? 1,
      renderStatus: updates.renderStatus ?? current.renderStatus,
      previewStatus: updates.previewStatus ?? current.previewStatus,
      renderError: updates.renderError === undefined ? current.renderError : updates.renderError ?? undefined,
      previewError: updates.previewError === undefined ? current.previewError : updates.previewError ?? undefined,
      updatedAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `UPDATE study_artifacts
         SET payload = @payload,
             file_path = @filePath,
             preview_path = @previewPath,
             payload_version = @payloadVersion,
             render_status = @renderStatus,
             preview_status = @previewStatus,
             render_error = @renderError,
             preview_error = @previewError,
             updated_at = @updatedAt
         WHERE id = @id`
      )
      .run(
        asSqlParams({
          id: next.id,
          payload: next.payload,
          filePath: next.filePath ?? null,
          previewPath: next.previewPath ?? null,
          payloadVersion: next.payloadVersion ?? 1,
          renderStatus: next.renderStatus ?? null,
          previewStatus: next.previewStatus ?? null,
          renderError: next.renderError ?? null,
          previewError: next.previewError ?? null,
          updatedAt: next.updatedAt ?? new Date().toISOString(),
        })
      );
    return this.getStudyArtifact(id);
  }

  deleteStudyArtifact(id: string): { deleted: boolean; filePath?: string; previewPath?: string } {
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

    return {
      deleted: true,
      filePath: artifact.filePath ?? undefined,
      previewPath: artifact.previewPath ?? undefined,
    };
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
    // Read from card_performance and quiz_performance directly
    // (study_session counters have a known increment bug)
    const tasks = this.listTasks().filter((t) => t.projectId === projectId);
    const dayData: Record<string, { reviews: number; correct: number; sessions: number }> = {};

    for (const task of tasks) {
      const artifacts = this.listStudyArtifacts(task.id);
      for (const artifact of artifacts) {
        if (artifact.kind === "flashcards") {
          for (const card of this.listCardPerformance(artifact.id)) {
            if (!card.nextReviewDate || card.totalReviews === 0) continue;
            const date = card.nextReviewDate.slice(0, 10);
            if (!dayData[date]) dayData[date] = { reviews: 0, correct: 0, sessions: 0 };
            dayData[date]!.reviews++;
            if (card.correctCount > 0) dayData[date]!.correct++;
          }
        }
        if (artifact.kind === "quiz") {
          for (const q of this.listQuizPerformance(artifact.id)) {
            const date = q.attemptedAt?.slice(0, 10);
            if (!date) continue;
            if (!dayData[date]) dayData[date] = { reviews: 0, correct: 0, sessions: 0 };
            dayData[date]!.reviews++;
            if (q.isCorrect) dayData[date]!.correct++;
          }
        }
      }
    }

    for (const s of this.listStudySessions(projectId, 1000)) {
      const date = s.startedAt.slice(0, 10);
      if (!dayData[date]) dayData[date] = { reviews: 0, correct: 0, sessions: 0 };
      dayData[date]!.sessions++;
    }

    const now = new Date();
    const entries: StudyTimelineEntry[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const day = dayData[dateStr] ?? { reviews: 0, correct: 0, sessions: 0 };
      entries.push({
        date: dateStr,
        sessions: day.sessions,
        reviews: day.reviews,
        accuracy: day.reviews > 0 ? day.correct / day.reviews : 0,
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

  /* ---- Canvas LMS Integration ---- */

  createCanvasConnection(input: CreateCanvasConnectionInput): CanvasConnectionRecord {
    const now = new Date().toISOString();
    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO canvas_connections
         (id, label, base_url, token_plaintext, is_active, created_at, updated_at)
         VALUES (@id, @label, @baseUrl, @tokenPlaintext, 1, @createdAt, @updatedAt)`
      )
      .run(
        asSqlParams({
          id,
          label: input.label,
          baseUrl: input.baseUrl,
          tokenPlaintext: input.token,
          createdAt: now,
          updatedAt: now,
        })
      );

    return {
      id,
      label: input.label,
      baseUrl: input.baseUrl,
      userDisplayName: null,
      userId: null,
      isActive: true,
      lastVerifiedAt: null,
      lastSyncAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  listCanvasConnections(): CanvasConnectionRecord[] {
    return asRows<CanvasConnectionRecord>(
      this.db
        .prepare(
          `SELECT
            id,
            label,
            base_url as baseUrl,
            user_display_name as userDisplayName,
            user_id as userId,
            is_active as isActive,
            last_verified_at as lastVerifiedAt,
            last_sync_at as lastSyncAt,
            created_at as createdAt,
            updated_at as updatedAt
           FROM canvas_connections
           ORDER BY created_at DESC`
        )
        .all()
    ).map((r) => ({ ...r, isActive: Boolean(r.isActive) }));
  }

  getCanvasConnection(id: string): (CanvasConnectionRecord & { tokenPlaintext: string | null }) | undefined {
    const row = this.db
      .prepare(
        `SELECT
          id,
          label,
          base_url as baseUrl,
          user_display_name as userDisplayName,
          user_id as userId,
          token_plaintext as tokenPlaintext,
          is_active as isActive,
          last_verified_at as lastVerifiedAt,
          last_sync_at as lastSyncAt,
          created_at as createdAt,
          updated_at as updatedAt
         FROM canvas_connections
         WHERE id = ?`
      )
      .get(id) as (CanvasConnectionRecord & { tokenPlaintext: string | null }) | undefined;

    if (!row) return undefined;
    return { ...row, isActive: Boolean(row.isActive) };
  }

  updateCanvasConnection(
    id: string,
    updates: Partial<
      Pick<
        CanvasConnectionRecord,
        "label" | "baseUrl" | "userDisplayName" | "userId" | "isActive" | "lastVerifiedAt" | "lastSyncAt"
      > & { tokenPlaintext: string }
    >
  ): CanvasConnectionRecord | undefined {
    const current = this.getCanvasConnection(id);
    if (!current) return undefined;

    const now = new Date().toISOString();
    const sets: string[] = [];
    const values: SQLInputValue[] = [];

    if (updates.label !== undefined) { sets.push("label = ?"); values.push(updates.label); }
    if (updates.baseUrl !== undefined) { sets.push("base_url = ?"); values.push(updates.baseUrl); }
    if (updates.userDisplayName !== undefined) { sets.push("user_display_name = ?"); values.push(updates.userDisplayName); }
    if (updates.userId !== undefined) { sets.push("user_id = ?"); values.push(updates.userId); }
    if (updates.isActive !== undefined) { sets.push("is_active = ?"); values.push(updates.isActive ? 1 : 0); }
    if (updates.lastVerifiedAt !== undefined) { sets.push("last_verified_at = ?"); values.push(updates.lastVerifiedAt); }
    if (updates.lastSyncAt !== undefined) { sets.push("last_sync_at = ?"); values.push(updates.lastSyncAt); }
    if (updates.tokenPlaintext !== undefined) { sets.push("token_plaintext = ?"); values.push(updates.tokenPlaintext); }

    sets.push("updated_at = ?");
    values.push(now);
    values.push(id);

    this.db
      .prepare(`UPDATE canvas_connections SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values);

    const updated = this.getCanvasConnection(id);
    if (!updated) return undefined;
    // Return without token fields
    const { tokenPlaintext: _, ...record } = updated;
    return record;
  }

  deleteCanvasConnection(id: string): boolean {
    this.db.exec("BEGIN");
    try {
      // Get all course mappings for this connection
      const mappings = this.listCanvasCourseMappings(id);
      for (const mapping of mappings) {
        this.db.prepare(`DELETE FROM canvas_synced_files WHERE course_mapping_id = ?`).run(mapping.id);
        this.db.prepare(`DELETE FROM canvas_assignments WHERE course_mapping_id = ?`).run(mapping.id);
        this.db.prepare(`DELETE FROM canvas_modules WHERE course_mapping_id = ?`).run(mapping.id);
      }
      this.db.prepare(`DELETE FROM canvas_course_mappings WHERE connection_id = ?`).run(id);
      const result = this.db.prepare(`DELETE FROM canvas_connections WHERE id = ?`).run(id);
      this.db.exec("COMMIT");
      return Number((result as { changes: number }).changes) > 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertCanvasCourseMapping(input: {
    connectionId: string;
    canvasCourseId: string;
    canvasCourseName: string;
    canvasCourseCode?: string | null;
    canvasTermName?: string | null;
    projectId?: string | null;
    rootPath?: string | null;
    syncEnabled?: boolean;
  }): CanvasCourseMappingRecord {
    const now = new Date().toISOString();
    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO canvas_course_mappings
         (id, connection_id, canvas_course_id, canvas_course_name, canvas_course_code, canvas_term_name, project_id, root_path, sync_enabled, created_at, updated_at)
         VALUES (@id, @connectionId, @canvasCourseId, @canvasCourseName, @canvasCourseCode, @canvasTermName, @projectId, @rootPath, @syncEnabled, @createdAt, @updatedAt)
         ON CONFLICT(connection_id, canvas_course_id) DO UPDATE SET
           canvas_course_name = @canvasCourseName,
           canvas_course_code = @canvasCourseCode,
           canvas_term_name = @canvasTermName,
           project_id = COALESCE(@projectId, canvas_course_mappings.project_id),
           root_path = COALESCE(@rootPath, canvas_course_mappings.root_path),
           sync_enabled = @syncEnabled,
           updated_at = @updatedAt`
      )
      .run(
        asSqlParams({
          id,
          connectionId: input.connectionId,
          canvasCourseId: input.canvasCourseId,
          canvasCourseName: input.canvasCourseName,
          canvasCourseCode: input.canvasCourseCode ?? null,
          canvasTermName: input.canvasTermName ?? null,
          projectId: input.projectId ?? null,
          rootPath: input.rootPath ?? null,
          syncEnabled: input.syncEnabled !== false ? 1 : 0,
          createdAt: now,
          updatedAt: now,
        })
      );

    // Fetch the actual row (may be the existing one after ON CONFLICT)
    const row = this.db
      .prepare(
        `SELECT
          id,
          connection_id as connectionId,
          canvas_course_id as canvasCourseId,
          canvas_course_name as canvasCourseName,
          canvas_course_code as canvasCourseCode,
          canvas_term_name as canvasTermName,
          project_id as projectId,
          sync_enabled as syncEnabled,
          last_synced_at as lastSyncedAt,
          created_at as createdAt,
          updated_at as updatedAt
         FROM canvas_course_mappings
         WHERE connection_id = ? AND canvas_course_id = ?`
      )
      .get(input.connectionId, input.canvasCourseId) as CanvasCourseMappingRecord | undefined;

    return { ...row!, syncEnabled: Boolean(row!.syncEnabled) };
  }

  listCanvasCourseMappings(connectionId: string): CanvasCourseMappingRecord[] {
    return asRows<CanvasCourseMappingRecord>(
      this.db
        .prepare(
          `SELECT
            id,
            connection_id as connectionId,
            canvas_course_id as canvasCourseId,
            canvas_course_name as canvasCourseName,
            canvas_course_code as canvasCourseCode,
            canvas_term_name as canvasTermName,
            project_id as projectId,
            sync_enabled as syncEnabled,
            last_synced_at as lastSyncedAt,
            created_at as createdAt,
            updated_at as updatedAt
           FROM canvas_course_mappings
           WHERE connection_id = ?
           ORDER BY canvas_course_name ASC`
        )
        .all(connectionId)
    ).map((r) => ({ ...r, syncEnabled: Boolean(r.syncEnabled) }));
  }

  getCanvasCourseMapping(id: string): CanvasCourseMappingRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT
          id,
          connection_id as connectionId,
          canvas_course_id as canvasCourseId,
          canvas_course_name as canvasCourseName,
          canvas_course_code as canvasCourseCode,
          canvas_term_name as canvasTermName,
          project_id as projectId,
          sync_enabled as syncEnabled,
          last_synced_at as lastSyncedAt,
          created_at as createdAt,
          updated_at as updatedAt
         FROM canvas_course_mappings
         WHERE id = ?`
      )
      .get(id) as CanvasCourseMappingRecord | undefined;

    if (!row) return undefined;
    return { ...row, syncEnabled: Boolean(row.syncEnabled) };
  }

  upsertCanvasSyncedFile(input: {
    courseMappingId: string;
    canvasFileId: string;
    canvasFolderPath?: string | null;
    filename: string;
    contentType?: string | null;
    size?: number | null;
    canvasUpdatedAt: string;
    localPath: string;
    downloadStatus?: CanvasSyncedFileRecord["downloadStatus"];
  }): CanvasSyncedFileRecord {
    const now = new Date().toISOString();
    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO canvas_synced_files
         (id, course_mapping_id, canvas_file_id, canvas_folder_path, filename, content_type, size, canvas_updated_at, local_path, download_status, created_at, updated_at)
         VALUES (@id, @courseMappingId, @canvasFileId, @canvasFolderPath, @filename, @contentType, @size, @canvasUpdatedAt, @localPath, @downloadStatus, @createdAt, @updatedAt)
         ON CONFLICT(course_mapping_id, canvas_file_id) DO UPDATE SET
           canvas_folder_path = @canvasFolderPath,
           filename = @filename,
           content_type = @contentType,
           size = @size,
           canvas_updated_at = @canvasUpdatedAt,
           local_path = @localPath,
           download_status = @downloadStatus,
           updated_at = @updatedAt`
      )
      .run(
        asSqlParams({
          id,
          courseMappingId: input.courseMappingId,
          canvasFileId: input.canvasFileId,
          canvasFolderPath: input.canvasFolderPath ?? null,
          filename: input.filename,
          contentType: input.contentType ?? null,
          size: input.size ?? null,
          canvasUpdatedAt: input.canvasUpdatedAt,
          localPath: input.localPath,
          downloadStatus: input.downloadStatus ?? "pending",
          createdAt: now,
          updatedAt: now,
        })
      );

    return this.db
      .prepare(
        `SELECT
          id,
          course_mapping_id as courseMappingId,
          canvas_file_id as canvasFileId,
          canvas_folder_path as canvasFolderPath,
          filename,
          content_type as contentType,
          size,
          canvas_updated_at as canvasUpdatedAt,
          local_path as localPath,
          download_status as downloadStatus,
          last_downloaded_at as lastDownloadedAt,
          created_at as createdAt,
          updated_at as updatedAt
         FROM canvas_synced_files
         WHERE course_mapping_id = ? AND canvas_file_id = ?`
      )
      .get(input.courseMappingId, input.canvasFileId) as CanvasSyncedFileRecord;
  }

  listCanvasSyncedFiles(courseMappingId: string): CanvasSyncedFileRecord[] {
    return asRows<CanvasSyncedFileRecord>(
      this.db
        .prepare(
          `SELECT
            id,
            course_mapping_id as courseMappingId,
            canvas_file_id as canvasFileId,
            canvas_folder_path as canvasFolderPath,
            filename,
            content_type as contentType,
            size,
            canvas_updated_at as canvasUpdatedAt,
            local_path as localPath,
            download_status as downloadStatus,
            last_downloaded_at as lastDownloadedAt,
            created_at as createdAt,
            updated_at as updatedAt
           FROM canvas_synced_files
           WHERE course_mapping_id = ?
           ORDER BY canvas_folder_path ASC, filename ASC`
        )
        .all(courseMappingId)
    );
  }

  upsertCanvasAssignment(input: {
    courseMappingId: string;
    canvasAssignmentId: string;
    title: string;
    description?: string | null;
    dueAt?: string | null;
    pointsPossible?: number | null;
    submissionScore?: number | null;
    submissionGrade?: string | null;
    submissionSubmittedAt?: string | null;
    assignmentGroupName?: string | null;
    canvasUpdatedAt: string;
  }): CanvasAssignmentRecord {
    const now = new Date().toISOString();
    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO canvas_assignments
         (id, course_mapping_id, canvas_assignment_id, title, description, due_at, points_possible, submission_score, submission_grade, submission_submitted_at, assignment_group_name, canvas_updated_at, created_at, updated_at)
         VALUES (@id, @courseMappingId, @canvasAssignmentId, @title, @description, @dueAt, @pointsPossible, @submissionScore, @submissionGrade, @submissionSubmittedAt, @assignmentGroupName, @canvasUpdatedAt, @createdAt, @updatedAt)
         ON CONFLICT(course_mapping_id, canvas_assignment_id) DO UPDATE SET
           title = @title,
           description = @description,
           due_at = @dueAt,
           points_possible = @pointsPossible,
           submission_score = @submissionScore,
           submission_grade = @submissionGrade,
           submission_submitted_at = @submissionSubmittedAt,
           assignment_group_name = @assignmentGroupName,
           canvas_updated_at = @canvasUpdatedAt,
           updated_at = @updatedAt`
      )
      .run(
        asSqlParams({
          id,
          courseMappingId: input.courseMappingId,
          canvasAssignmentId: input.canvasAssignmentId,
          title: input.title,
          description: input.description ?? null,
          dueAt: input.dueAt ?? null,
          pointsPossible: input.pointsPossible ?? null,
          submissionScore: input.submissionScore ?? null,
          submissionGrade: input.submissionGrade ?? null,
          submissionSubmittedAt: input.submissionSubmittedAt ?? null,
          assignmentGroupName: input.assignmentGroupName ?? null,
          canvasUpdatedAt: input.canvasUpdatedAt,
          createdAt: now,
          updatedAt: now,
        })
      );

    return this.db
      .prepare(
        `SELECT
          id,
          course_mapping_id as courseMappingId,
          canvas_assignment_id as canvasAssignmentId,
          title,
          description,
          due_at as dueAt,
          points_possible as pointsPossible,
          submission_score as submissionScore,
          submission_grade as submissionGrade,
          submission_submitted_at as submissionSubmittedAt,
          assignment_group_name as assignmentGroupName,
          canvas_updated_at as canvasUpdatedAt,
          created_at as createdAt,
          updated_at as updatedAt
         FROM canvas_assignments
         WHERE course_mapping_id = ? AND canvas_assignment_id = ?`
      )
      .get(input.courseMappingId, input.canvasAssignmentId) as CanvasAssignmentRecord;
  }

  listCanvasAssignments(courseMappingId: string): CanvasAssignmentRecord[] {
    return asRows<CanvasAssignmentRecord>(
      this.db
        .prepare(
          `SELECT
            id,
            course_mapping_id as courseMappingId,
            canvas_assignment_id as canvasAssignmentId,
            title,
            description,
            due_at as dueAt,
            points_possible as pointsPossible,
            submission_score as submissionScore,
            submission_grade as submissionGrade,
            submission_submitted_at as submissionSubmittedAt,
            assignment_group_name as assignmentGroupName,
            canvas_updated_at as canvasUpdatedAt,
            created_at as createdAt,
            updated_at as updatedAt
           FROM canvas_assignments
           WHERE course_mapping_id = ?
           ORDER BY due_at ASC`
        )
        .all(courseMappingId)
    );
  }

  upsertCanvasModule(input: {
    courseMappingId: string;
    canvasModuleId: string;
    name: string;
    position: number;
    itemsJson?: string;
    canvasUpdatedAt: string;
  }): CanvasModuleRecord {
    const now = new Date().toISOString();
    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO canvas_modules
         (id, course_mapping_id, canvas_module_id, name, position, items_json, canvas_updated_at, created_at, updated_at)
         VALUES (@id, @courseMappingId, @canvasModuleId, @name, @position, @itemsJson, @canvasUpdatedAt, @createdAt, @updatedAt)
         ON CONFLICT(course_mapping_id, canvas_module_id) DO UPDATE SET
           name = @name,
           position = @position,
           items_json = @itemsJson,
           canvas_updated_at = @canvasUpdatedAt,
           updated_at = @updatedAt`
      )
      .run(
        asSqlParams({
          id,
          courseMappingId: input.courseMappingId,
          canvasModuleId: input.canvasModuleId,
          name: input.name,
          position: input.position,
          itemsJson: input.itemsJson ?? "[]",
          canvasUpdatedAt: input.canvasUpdatedAt,
          createdAt: now,
          updatedAt: now,
        })
      );

    return this.db
      .prepare(
        `SELECT
          id,
          course_mapping_id as courseMappingId,
          canvas_module_id as canvasModuleId,
          name,
          position,
          items_json as itemsJson,
          canvas_updated_at as canvasUpdatedAt,
          created_at as createdAt,
          updated_at as updatedAt
         FROM canvas_modules
         WHERE course_mapping_id = ? AND canvas_module_id = ?`
      )
      .get(input.courseMappingId, input.canvasModuleId) as CanvasModuleRecord;
  }

  listCanvasModules(courseMappingId: string): CanvasModuleRecord[] {
    return asRows<CanvasModuleRecord>(
      this.db
        .prepare(
          `SELECT
            id,
            course_mapping_id as courseMappingId,
            canvas_module_id as canvasModuleId,
            name,
            position,
            items_json as itemsJson,
            canvas_updated_at as canvasUpdatedAt,
            created_at as createdAt,
            updated_at as updatedAt
           FROM canvas_modules
           WHERE course_mapping_id = ?
           ORDER BY position ASC`
        )
        .all(courseMappingId)
    );
  }

  // ─── Codex usage tracking ──────────────────────────────────────────

  insertUsageSnapshot(data: {
    primaryUsedPercent?: number | null;
    primaryResetsAt?: string | null;
    primaryWindowMins?: number | null;
    secondaryUsedPercent?: number | null;
    secondaryResetsAt?: string | null;
    secondaryWindowMins?: number | null;
    hasCredits?: boolean | null;
    creditsUnlimited?: boolean | null;
    creditsBalance?: string | null;
    planType?: string | null;
    email?: string | null;
    source?: string | null;
  }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO codex_usage_snapshots (
          id, captured_at, primary_used_percent, primary_resets_at, primary_window_mins,
          secondary_used_percent, secondary_resets_at, secondary_window_mins,
          has_credits, credits_unlimited, credits_balance, plan_type, email, source
        ) VALUES (
          @id, @capturedAt, @primaryUsedPercent, @primaryResetsAt, @primaryWindowMins,
          @secondaryUsedPercent, @secondaryResetsAt, @secondaryWindowMins,
          @hasCredits, @creditsUnlimited, @creditsBalance, @planType, @email, @source
        )`
      )
      .run(
        asSqlParams({
          id,
          capturedAt: now,
          primaryUsedPercent: data.primaryUsedPercent ?? null,
          primaryResetsAt: data.primaryResetsAt ?? null,
          primaryWindowMins: data.primaryWindowMins ?? null,
          secondaryUsedPercent: data.secondaryUsedPercent ?? null,
          secondaryResetsAt: data.secondaryResetsAt ?? null,
          secondaryWindowMins: data.secondaryWindowMins ?? null,
          hasCredits: data.hasCredits != null ? Number(data.hasCredits) : null,
          creditsUnlimited: data.creditsUnlimited != null ? Number(data.creditsUnlimited) : null,
          creditsBalance: data.creditsBalance ?? null,
          planType: data.planType ?? null,
          email: data.email ?? null,
          source: data.source ?? "rpc",
        })
      );

    return this.db
      .prepare(
        `SELECT id, captured_at as capturedAt,
          primary_used_percent as primaryUsedPercent,
          primary_resets_at as primaryResetsAt,
          primary_window_mins as primaryWindowMins,
          secondary_used_percent as secondaryUsedPercent,
          secondary_resets_at as secondaryResetsAt,
          secondary_window_mins as secondaryWindowMins,
          has_credits as hasCredits,
          credits_unlimited as creditsUnlimited,
          credits_balance as creditsBalance,
          plan_type as planType,
          email, source
         FROM codex_usage_snapshots WHERE id = ?`
      )
      .get(id) as Record<string, unknown>;
  }

  getLatestUsageSnapshot() {
    return (
      this.db
        .prepare(
          `SELECT id, captured_at as capturedAt,
            primary_used_percent as primaryUsedPercent,
            primary_resets_at as primaryResetsAt,
            primary_window_mins as primaryWindowMins,
            secondary_used_percent as secondaryUsedPercent,
            secondary_resets_at as secondaryResetsAt,
            secondary_window_mins as secondaryWindowMins,
            has_credits as hasCredits,
            credits_unlimited as creditsUnlimited,
            credits_balance as creditsBalance,
            plan_type as planType,
            email, source
           FROM codex_usage_snapshots
           ORDER BY captured_at DESC
           LIMIT 1`
        )
        .get() as Record<string, unknown> | undefined
    ) ?? null;
  }

  getUsageHistory(hours = 24) {
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    return asRows<Record<string, unknown>>(
      this.db
        .prepare(
          `SELECT id, captured_at as capturedAt,
            primary_used_percent as primaryUsedPercent,
            primary_resets_at as primaryResetsAt,
            primary_window_mins as primaryWindowMins,
            secondary_used_percent as secondaryUsedPercent,
            secondary_resets_at as secondaryResetsAt,
            secondary_window_mins as secondaryWindowMins,
            has_credits as hasCredits,
            credits_unlimited as creditsUnlimited,
            credits_balance as creditsBalance,
            plan_type as planType,
            email, source
           FROM codex_usage_snapshots
           WHERE captured_at >= ?
           ORDER BY captured_at DESC`
        )
        .all(since)
    );
  }

  insertTurnMetrics(data: {
    taskId?: string | null;
    threadId?: string | null;
    turnId?: string | null;
    model?: string | null;
    effort?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO codex_turn_metrics (
          id, task_id, thread_id, turn_id, captured_at,
          model, effort, input_tokens, output_tokens,
          cached_input_tokens, reasoning_tokens, total_tokens
        ) VALUES (
          @id, @taskId, @threadId, @turnId, @capturedAt,
          @model, @effort, @inputTokens, @outputTokens,
          @cachedInputTokens, @reasoningTokens, @totalTokens
        )`
      )
      .run(
        asSqlParams({
          id,
          taskId: data.taskId ?? null,
          threadId: data.threadId ?? null,
          turnId: data.turnId ?? null,
          capturedAt: now,
          model: data.model ?? null,
          effort: data.effort ?? null,
          inputTokens: data.inputTokens ?? 0,
          outputTokens: data.outputTokens ?? 0,
          cachedInputTokens: data.cachedInputTokens ?? 0,
          reasoningTokens: data.reasoningTokens ?? 0,
          totalTokens: data.totalTokens ?? 0,
        })
      );
  }

  getTurnMetrics(taskId?: string, limit = 50) {
    if (taskId) {
      return asRows<Record<string, unknown>>(
        this.db
          .prepare(
            `SELECT id, task_id as taskId, thread_id as threadId, turn_id as turnId,
              captured_at as capturedAt, model, effort,
              input_tokens as inputTokens, output_tokens as outputTokens,
              cached_input_tokens as cachedInputTokens,
              reasoning_tokens as reasoningTokens,
              total_tokens as totalTokens
             FROM codex_turn_metrics
             WHERE task_id = ?
             ORDER BY captured_at DESC
             LIMIT ?`
          )
          .all(taskId, limit)
      );
    }

    return asRows<Record<string, unknown>>(
      this.db
        .prepare(
          `SELECT id, task_id as taskId, thread_id as threadId, turn_id as turnId,
            captured_at as capturedAt, model, effort,
            input_tokens as inputTokens, output_tokens as outputTokens,
            cached_input_tokens as cachedInputTokens,
            reasoning_tokens as reasoningTokens,
            total_tokens as totalTokens
           FROM codex_turn_metrics
           ORDER BY captured_at DESC
           LIMIT ?`
        )
        .all(limit)
    );
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

function buildSourcePathMatch(value: string): {
  exact: string;
  stripped: string;
  suffixLike: string;
} {
  const exact = value.trim().replace(/\\/g, "/").replace(/[?#].*$/, "").replace(/^file:\/\//, "");
  const stripped = exact.replace(/^\.?\//, "");
  return {
    exact,
    stripped,
    suffixLike: `%/${stripped}`,
  };
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
