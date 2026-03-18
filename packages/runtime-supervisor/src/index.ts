import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { LocalDatabase } from "@stuart/db";
import type {
  AttachmentMode,
  ApprovalRecord,
  ArtifactRecord,
  CreateProjectInput,
  CreateTaskInput,
  CreateWorkerInput,
  DiffOperation,
  DiffPreview,
  FileFingerprint,
  IngestionDocumentRecord,
  IngestionIndexStats,
  IngestionSearchResult,
  ProjectRecord,
  StagedAttachmentSnapshot,
  StudyArtifactRecord,
  TaskMessageRecord,
  TaskRunManifest,
  TaskRunRecord,
  TaskSpec,
  TaskWorkerRecord,
  TopicPerformanceRecord,
  UpdateTaskInput,
  VmStatus
} from "@stuart/shared";
import type { PreviewKind, WorkspaceEvent, WorkspaceFileRecord } from "@stuart/shared";
import { CodexAppServerClient } from "./codex-app-server.js";
import {
  buildChunkIdentifiers,
  isIngestiblePath,
  parseDocumentForIngestion
} from "./ingestion.js";
import { renderDocument } from "./document-renderer.js";
import { matchSkill } from "./skills.js";
import { SandboxExecutor } from "@stuart/sandbox-executor";
import {
  collectSystemDiagnostics,
  type SystemDiagnostics
} from "./diagnostics.js";

export { renderDocument } from "./document-renderer.js";
export {
  collectSystemDiagnostics,
  ensureLocalEnvFile,
  type SystemDiagnosticCheck,
  type SystemDiagnostics,
  type SystemDiagnosticStatus
} from "./diagnostics.js";

interface InventoryEntry extends FileFingerprint {
  absolutePath: string;
}

interface RuntimeOptions {
  dataDir: string;
  vmHelperBinaryPath?: string;
  workspaceRoot?: string;
}

export interface DemoCleanupResult {
  removedTaskCount: number;
  removedProjectCount: number;
  dedupedProjectCount: number;
}

interface SendTaskMessageResult {
  preparedRun: TaskRunRecord | null;
  userMessage: TaskMessageRecord;
  startedTurn: boolean;
}

interface PermissionGap {
  title: string;
  detail: string;
}

interface TaskExecutionContext {
  cwd: string;
  taskRun: TaskRunRecord | null;
  preparedRun: TaskRunRecord | null;
}

interface ActiveTurnState {
  taskId: string;
  threadId: string;
  turnId: string;
  kind: "task" | "worker";
  workerId?: string;
  assistantItemId?: string;
  assistantText: string;
  thinkingLabel: string;
  startedEmitted: boolean;
  /** The working directory for this turn (staging path) */
  cwd?: string;
  /** Whether this turn should trigger workspace re-indexing on completion */
  triggersReindex?: boolean;
}

interface ResolvedWorkspaceFile extends WorkspaceFileRecord {
  absolutePath: string;
  rootPath: string;
}

export class VmHelperClient {
  constructor(private readonly helperBinaryPath?: string) {}

  private async invoke(_command: "status" | "start" | "stop"): Promise<VmStatus> {
    // Simplified for student runtime: always report running locally.
    return {
      state: "running",
      detail: "Stuart local runtime"
    };
  }

  async status(): Promise<VmStatus> {
    return this.invoke("status");
  }

  async start(): Promise<VmStatus> {
    return this.invoke("start");
  }

  async ensureRunning(): Promise<VmStatus> {
    return {
      state: "running",
      detail: "Stuart local runtime"
    };
  }
}

export class StuartRuntime {
  readonly db: LocalDatabase;
  readonly vm: VmHelperClient;
  readonly dataDir: string;
  readonly sandbox: SandboxExecutor;
  private sandboxAvailable = false;
  private readonly stagingRoot: string;
  private readonly workspaceRoot: string;
  private readonly events = new EventEmitter();
  private readonly loadedThreadIds = new Set<string>();
  private readonly turns = new Map<string, ActiveTurnState>();
  private readonly codex: CodexAppServerClient;
  private readonly vmHelperBinaryPath?: string;
  private diagnosticsCache?: { expiresAt: number; value: SystemDiagnostics };

  constructor(options: RuntimeOptions) {
    this.dataDir = resolve(options.dataDir);
    this.workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
    this.stagingRoot = join(this.dataDir, "staging");
    this.db = new LocalDatabase(join(this.dataDir, "stuart.sqlite"));
    this.vmHelperBinaryPath = options.vmHelperBinaryPath;
    this.vm = new VmHelperClient(options.vmHelperBinaryPath);
    this.sandbox = new SandboxExecutor({
      outputRoot: join(this.dataDir, "generated-documents"),
    });
    this.codex = new CodexAppServerClient({
      onNotification: (notification) => {
        void this.handleCodexNotification(notification);
      },
      onServerRequest: (request) => this.handleCodexServerRequest(request),
      onStderr: (chunk) => {
        const filtered = filterCodexStderr(chunk);
        if (filtered) {
          process.stderr.write(filtered);
        }
      }
    });
  }

  async bootstrap(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(this.stagingRoot, { recursive: true });
    const cleanup = this.db.cleanupHistoricalTaskMessages();
    if (cleanup.deletedCount > 0) {
      process.stdout.write(
        `[stuart] cleaned ${cleanup.deletedCount} historical task message${cleanup.deletedCount === 1 ? "" : "s"}.\n`
      );
    }
    try {
      await this.codex.ensureReady();
    } catch (error) {
      process.stderr.write(
        `[stuart] failed to warm codex app-server: ${String(error)}\n`
      );
    }

    // Warm Docker sandbox (non-blocking — log warning if unavailable)
    try {
      this.sandboxAvailable = await this.sandbox.isAvailable();
      if (this.sandboxAvailable) {
        await this.sandbox.ensureImageReady();
        process.stdout.write("[stuart] sandbox executor ready (Docker available).\n");
      } else {
        process.stdout.write("[stuart] sandbox executor unavailable — Docker not running. Script-based document generation disabled.\n");
      }
    } catch (error) {
      this.sandboxAvailable = false;
      process.stderr.write(
        `[stuart] sandbox executor setup failed: ${String(error)}\n`
      );
    }
  }

  onEvent(listener: (event: WorkspaceEvent) => void): () => void {
    this.events.on("event", listener);
    return () => {
      this.events.off("event", listener);
    };
  }

  async getVmStatus(): Promise<VmStatus> {
    return this.vm.status();
  }

  async getSystemDiagnostics(): Promise<SystemDiagnostics> {
    if (this.diagnosticsCache && this.diagnosticsCache.expiresAt > Date.now()) {
      return this.diagnosticsCache.value;
    }

    const diagnostics = await collectSystemDiagnostics({
      workspaceRoot: this.workspaceRoot,
      dataDir: this.dataDir,
      codexBinaryPath: process.env.CODEX_BINARY_PATH,
      vmHelperBinaryPath: this.vmHelperBinaryPath,
      sandboxAvailable: this.sandboxAvailable,
    });
    this.diagnosticsCache = {
      expiresAt: Date.now() + 30_000,
      value: diagnostics,
    };
    return diagnostics;
  }

  listProjects() {
    return this.db.listProjects();
  }

  createProject(input: CreateProjectInput) {
    return this.db.createProject(input);
  }

  async deleteProject(projectId: string): Promise<boolean> {
    const tasks = this.db.listTasksByProject(projectId);
    for (const task of tasks) {
      await this.deleteTask(task.id);
    }
    return this.db.deleteProject(projectId);
  }

  listTasks() {
    return this.db.listTasks();
  }

  createTask(input: CreateTaskInput) {
    return this.db.createTask(input);
  }

  updateTask(taskId: string, input: UpdateTaskInput) {
    return this.db.updateTask(taskId, input);
  }

  listTaskWorkers(taskId: string) {
    return this.db.listTaskWorkers(taskId);
  }

  async createTaskWorker(taskId: string, input: CreateWorkerInput): Promise<TaskWorkerRecord> {
    const task = this.db.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found.`);
    }

    const objective = input.objective.trim();
    if (!objective) {
      throw new Error("Worker objective is required.");
    }

    const context = await this.resolveTaskExecutionContext(task);
    const worker = this.db.createTaskWorker(taskId, {
      ...input,
      objective,
      attachmentIds:
        input.attachmentIds?.length ? input.attachmentIds : task.attachments.map((item) => item.id),
      taskRunId: input.taskRunId ?? context.taskRun?.id
    });

    this.recordRuntimeMessage(
      task.id,
      `Spawning a ${worker.role} worker to handle part of this task.\n\n${worker.objective}`
    );

    const threadId = await this.ensureWorkerThread(task, worker, context.cwd);
    const retrievedContext = await this.buildRetrievedContext(task, context.taskRun, worker.objective);
    const inputItems = [
      ...(retrievedContext
        ? [
            {
              type: "text" as const,
              text: retrievedContext,
              text_elements: []
            }
          ]
        : []),
      {
        type: "text" as const,
        text: buildWorkerPrompt(task, worker),
        text_elements: []
      }
    ];
    const turn = await this.codex.request<{ turn: { id: string } }>("turn/start", {
      threadId,
      cwd: context.cwd,
      approvalPolicy: "never",
      effort: "medium",
      input: inputItems
    });

    const runningWorker: TaskWorkerRecord = {
      ...worker,
      status: "running",
      threadId,
      taskRunId: context.taskRun?.id ?? worker.taskRunId,
      updatedAt: new Date().toISOString()
    };
    this.db.updateTaskWorker(runningWorker);
    this.turns.set(turn.turn.id, {
      taskId,
      threadId,
      turnId: turn.turn.id,
      kind: "worker",
      workerId: worker.id,
      assistantText: "",
      thinkingLabel: buildWorkerThinkingLabel(worker),
      startedEmitted: true
    });
    this.emitEvent({
      type: "task.worker",
      taskId,
      workerId: worker.id,
      status: "running",
      role: worker.role
    });
    return runningWorker;
  }

  /** Resolve the project's root path from a taskId, or null if not found. */
  private resolveProjectRoot(taskId: string): string | null {
    try {
      const task = this.db.getTask(taskId);
      if (task) {
        const project = this.db.getProject(task.projectId);
        if (project?.rootPath && existsSync(project.rootPath)) {
          return project.rootPath;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Resolve the output directory for generated documents.
   * Writes into the project's workspace root so the user can see the files.
   * Falls back to the internal data dir if the project root can't be resolved.
   */
  private resolveDocumentOutputDir(taskId: string): string {
    return this.resolveProjectRoot(taskId) ?? join(this.dataDir, "generated-documents", taskId);
  }

  /**
   * Ensure a document artifact has its binary file rendered on disk.
   * Renders on-demand if the file is missing. Returns the file path or null.
   */
  async ensureDocumentFile(artifactId: string): Promise<string | null> {
    const artifact = this.db.getStudyArtifact(artifactId);
    if (!artifact || !artifact.kind.startsWith("document_")) return null;

    if (artifact.filePath && existsSync(artifact.filePath)) {
      return artifact.filePath;
    }

    try {
      const data = JSON.parse(artifact.payload);
      const outputDir = this.resolveDocumentOutputDir(artifact.taskId);

      // Script-based artifact: re-execute through sandbox
      if (data.script && data.language && data.outputFilename && this.sandboxAvailable) {
        const result = await this.sandbox.executeScript({
          language: data.language,
          script: data.script,
          outputFilename: data.outputFilename,
          taskId: artifact.taskId,
          outputDir,
          sourcesDir: outputDir,
        });
        if (result.success && result.outputPath) {
          this.db.updateStudyArtifactFilePath(artifact.id, result.outputPath);
          return result.outputPath;
        }
        console.error(`[stuart] sandbox re-execution failed for artifact ${artifactId}: exit=${result.exitCode}`);
        return null;
      }

      // JSON-render path
      const safeFilename = (artifact.title || "document")
        .replace(/[^a-zA-Z0-9_\- ]/g, "")
        .replace(/\s+/g, "_")
        .slice(0, 80);
      const filePath = await renderDocument(artifact.kind, data, outputDir, safeFilename);
      this.db.updateStudyArtifactFilePath(artifact.id, filePath);
      return filePath;
    } catch (err) {
      console.error(`[stuart] document render failed for artifact ${artifactId}:`, err);
      return null;
    }
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const threadId = this.db.getTaskThreadId(taskId);
    if (threadId) {
      this.loadedThreadIds.delete(threadId);
    }
    for (const worker of this.db.listTaskWorkers(taskId)) {
      if (worker.threadId) {
        this.loadedThreadIds.delete(worker.threadId);
      }
    }

    for (const [turnId, state] of this.turns.entries()) {
      if (state.taskId === taskId) {
        this.turns.delete(turnId);
      }
    }

    const deletion = this.db.deleteTask(taskId);
    if (!deletion.deleted) {
      return false;
    }

    await Promise.all([
      ...deletion.stagingPaths.map((stagingPath) =>
        rm(stagingPath, { recursive: true, force: true }).catch(() => undefined)
      ),
      rm(join(this.dataDir, "generated-documents", taskId), { recursive: true, force: true }).catch(() => undefined),
    ]);
    return true;
  }

  async cleanupDemoData(): Promise<DemoCleanupResult> {
    const smokePattern = /\bsmoke\b/i;
    let removedTaskCount = 0;
    let removedProjectCount = 0;
    let dedupedProjectCount = 0;

    const tasks = this.db.listTasks();
    for (const task of tasks) {
      if (smokePattern.test(task.title) || smokePattern.test(task.objective)) {
        if (await this.deleteTask(task.id)) {
          removedTaskCount += 1;
        }
      }
    }

    const projects = this.db.listProjects();
    const projectsBySignature = new Map<string, typeof projects>();
    for (const project of projects) {
      const key = `${project.name}::${project.rootPath}`;
      const existing = projectsBySignature.get(key);
      if (existing) {
        existing.push(project);
      } else {
        projectsBySignature.set(key, [project]);
      }
    }

    for (const groupedProjects of projectsBySignature.values()) {
      if (groupedProjects.length <= 1) {
        continue;
      }

      const sorted = [...groupedProjects].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt)
      );
      for (const duplicate of sorted.slice(1)) {
        if (this.db.listTasksByProject(duplicate.id).length > 0) {
          continue;
        }
        if (this.db.deleteProject(duplicate.id)) {
          dedupedProjectCount += 1;
        }
      }
    }

    for (const project of this.db.listProjects()) {
      const isSmokeProject =
        smokePattern.test(project.name) || project.rootPath.includes("/.tmp/preview-smoke");
      if (!isSmokeProject) {
        continue;
      }
      if (await this.deleteProject(project.id)) {
        removedProjectCount += 1;
      }
    }

    return {
      removedTaskCount,
      removedProjectCount,
      dedupedProjectCount
    };
  }

  listTaskMessages(taskId: string) {
    return this.db.listTaskMessages(taskId);
  }

  async sendTaskMessage(taskId: string, content: string): Promise<SendTaskMessageResult> {
    const task = this.db.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found.`);
    }

    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error("Task message content is required.");
    }

    const userMessage = this.db.createTaskMessage({
      taskId,
      role: "user",
      content: trimmed
    });

    const permissionGap = assessPermissionGap(task, trimmed);
    if (permissionGap) {
      this.recordRuntimeMessage(
        task.id,
        `${permissionGap.title}\n\n${permissionGap.detail}`
      );
      return {
        preparedRun: null,
        userMessage,
        startedTurn: false
      };
    }

    const context = await this.resolveTaskExecutionContext(task);
    if (context.preparedRun) {
      this.recordRuntimeMessage(
        task.id,
        `Prepared a staged workspace for this task at \`${context.preparedRun.stagingPath}\`.`
      );
    }
    const threadId = await this.ensureTaskThread(task, context.cwd);
    const retrievedContext = await this.buildRetrievedContext(task, context.taskRun, trimmed);

    // For large material sets, add file-targeting hints to the context
    const targetedFiles = extractTargetedFiles(trimmed);
    const fileTargetHint = targetedFiles.length > 0
      ? `\n\nHINT: The student is asking about specific material. Focus on files matching: ${[...new Set(targetedFiles)].slice(0, 6).join(", ")}. Use grep to find these files first before exploring broadly.`
      : "";

    // Check if this is a large material set that would benefit from parallel exploration
    const stats = context.taskRun ? this.db.getIngestionStats(task.id, context.taskRun.id) : null;
    const isLargeMaterialSet = stats && stats.documentsIndexed > 8;

    // Match a skill to inject detailed formatting/workflow instructions.
    const skill = matchSkill(trimmed, this.sandboxAvailable);
    if (skill) {
      this.recordRuntimeMessage(task.id, `Loaded skill: ${skill.id}`);
    }

    // Determine model + effort per turn based on what's needed.
    // Skills that generate code or do deep research → flagship gpt-5.4 + high effort.
    // Everything else → gpt-5.4-mini (set on thread) with dynamic effort.
    const needsFlagship = skill && (
      skill.requiresSandbox       // scripted document generation (code output)
      || skill.id === "research"  // research + curriculum building
      || skill.id === "interactive" // interactive HTML/JS apps
    );
    const isSimpleQuery = /^explain|^what is|^define|^describe|^tell me about/i.test(trimmed) && trimmed.length < 200;
    const turnModel = needsFlagship ? "gpt-5.4" : undefined; // undefined = use thread default (mini)
    const effort = needsFlagship ? "high"
      : isSimpleQuery ? "low"
      : isLargeMaterialSet && !targetedFiles.length ? "high"
      : "medium";

    // Detect weak-topic intent and inject performance context
    const isWeakTopicRequest = /\bweak\s*(topic|area)s?\b|\bstruggl|\bfocus.*weak|\bworst\b/i.test(trimmed);
    let performanceContext = "";
    if (isWeakTopicRequest) {
      performanceContext = buildPerformanceContext(this.db, task);
    }

    const input = [
      ...(retrievedContext
        ? [
            {
              type: "text" as const,
              text: retrievedContext + fileTargetHint,
              text_elements: []
            }
          ]
        : fileTargetHint
          ? [
              {
                type: "text" as const,
                text: fileTargetHint.trim(),
                text_elements: []
              }
            ]
          : []),
      ...(performanceContext
        ? [
            {
              type: "text" as const,
              text: performanceContext,
              text_elements: []
            }
          ]
        : []),
      ...(skill
        ? [
            {
              type: "text" as const,
              text: skill.prompt,
              text_elements: []
            }
          ]
        : []),
      {
        type: "text" as const,
        text: trimmed,
        text_elements: []
      }
    ];
    const turn = await this.codex.request<{ turn: { id: string } }>("turn/start", {
      threadId,
      cwd: context.cwd,
      approvalPolicy: "never",
      ...(turnModel ? { model: turnModel } : {}),
      effort,
      input
    });

    // For large material sets with complex queries, spawn parallel explore workers
    if (isLargeMaterialSet && !targetedFiles.length && !isSimpleQuery) {
      void this.spawnExploreWorkers(task, context, trimmed).catch(() => {
        // Non-critical — the main turn will still work
      });
    }

    this.turns.set(turn.turn.id, {
      taskId,
      threadId,
      turnId: turn.turn.id,
      kind: "task",
      assistantText: "",
      thinkingLabel: inferThinkingLabel(task, trimmed),
      startedEmitted: true,
      cwd: context.cwd,
      triggersReindex: skill?.triggersReindex,
    });

    this.emitEvent({
      type: "codex.turn.started",
      taskId,
      threadId,
      turnId: turn.turn.id,
      label: inferThinkingLabel(task, trimmed)
    });

    return {
      preparedRun: context.preparedRun,
      userMessage,
      startedTurn: true
    };
  }

  listTaskRuns(taskId: string) {
    return this.db.listTaskRuns(taskId);
  }

  listArtifacts(taskRunId: string) {
    return this.db.listArtifacts(taskRunId);
  }

  async listWorkspaceFiles(
    taskId: string,
    taskRunId?: string
  ): Promise<WorkspaceFileRecord[]> {
    return (await this.collectWorkspaceFiles(taskId, taskRunId)).map(
      ({ absolutePath: _absolutePath, rootPath: _rootPath, ...entry }) => entry
    );
  }

  async resolveWorkspaceFile(
    taskId: string,
    entryId: string,
    taskRunId?: string
  ): Promise<ResolvedWorkspaceFile> {
    const entries = await this.collectWorkspaceFiles(taskId, taskRunId);
    const entry = entries.find((candidate) => candidate.id === entryId);
    if (!entry) {
      throw new Error(`Workspace file ${entryId} not found for task ${taskId}.`);
    }
    return entry;
  }

  async resolveWorkspaceLink(
    taskId: string,
    reference: string,
    taskRunId?: string
  ): Promise<ResolvedWorkspaceFile | null> {
    const normalized = normalizeWorkspaceReference(reference);
    if (!normalized) {
      return null;
    }

    const entries = await this.collectWorkspaceFiles(taskId, taskRunId, 5000);
    const direct =
      entries.find((entry) => entry.absolutePath === normalized) ??
      entries.find((entry) => entry.relativePath === normalized) ??
      entries.find((entry) => stripRelativePrefix(entry.relativePath) === stripRelativePrefix(normalized));
    if (direct) {
      return direct;
    }

    const suffixMatch = entries.find((entry) =>
      entry.relativePath.endsWith(`/${stripRelativePrefix(normalized)}`)
    );
    if (suffixMatch) {
      return suffixMatch;
    }

    const basenameMatch = entries.filter((entry) => entry.name === basename(normalized));
    if (basenameMatch.length === 1) {
      return basenameMatch[0] ?? null;
    }

    return basenameMatch.sort((left, right) => left.relativePath.length - right.relativePath.length)[0] ?? null;
  }

  listApprovals(taskRunId: string) {
    return this.db.listApprovals(taskRunId);
  }

  listIngestionDocuments(taskId: string, taskRunId?: string): IngestionDocumentRecord[] {
    return this.db.listIngestionDocuments(taskId, taskRunId);
  }

  getIngestionStats(taskId: string, taskRunId?: string): IngestionIndexStats {
    return this.db.getIngestionStats(taskId, taskRunId);
  }

  searchIngestionIndex(
    taskId: string,
    query: string,
    options?: { taskRunId?: string; limit?: number }
  ): IngestionSearchResult[] {
    return this.db.searchIngestionChunks(taskId, query, options);
  }

  async buildTaskIngestionIndex(
    taskId: string,
    options?: {
      taskRunId?: string;
      force?: boolean;
    }
  ): Promise<IngestionIndexStats> {
    const existing = this.db.getIngestionStats(taskId, options?.taskRunId);
    if (!options?.force && existing.documentsIndexed > 0) {
      return existing;
    }

    const files = (await this.collectWorkspaceFiles(taskId, options?.taskRunId, 5000)).filter(
      (entry) => isIngestiblePath(entry.absolutePath)
    );
    this.db.clearIngestionScope(taskId, options?.taskRunId);

    for (const file of files) {
      const documentId = createHash("sha1")
        .update(`${taskId}:${options?.taskRunId ?? "global"}:${file.absolutePath}`)
        .digest("hex");
      const parsed = await parseDocumentForIngestion(file.absolutePath);
      const documentRecord: IngestionDocumentRecord = {
        id: documentId,
        taskId,
        taskRunId: options?.taskRunId,
        sourcePath: file.absolutePath,
        relativePath: file.relativePath,
        fileType: parsed.fileType,
        parser: parsed.parser,
        chunkCount: parsed.chunks.length,
        size: file.size,
        status: parsed.status,
        error: parsed.status === "failed" ? parsed.error : undefined,
        indexedAt: new Date().toISOString()
      };
      this.db.upsertIngestionDocument(documentRecord);

      if (parsed.status !== "indexed" || parsed.chunks.length === 0) {
        continue;
      }

      for (const chunk of buildChunkIdentifiers(documentId, parsed.chunks)) {
        this.db.insertIngestionChunk({
          chunkId: chunk.chunkId,
          documentId,
          taskId,
          taskRunId: options?.taskRunId,
          sourcePath: file.absolutePath,
          relativePath: file.relativePath,
          fileType: parsed.fileType,
          heading: chunk.heading,
          locator: chunk.locator,
          text: chunk.text
        });
      }
    }

    const stats = this.db.getIngestionStats(taskId, options?.taskRunId);
    if (options?.taskRunId) {
      const task = this.db.getTask(taskId);
      const run = this.db.getTaskRun(options.taskRunId);
      if (task && run) {
        try {
          const manifest = await this.readManifest(run.stagingPath);
          await this.updateWorkspaceScaffold(task, options.taskRunId, manifest);
        } catch {
          // Ignore metadata sync errors so indexing remains usable.
        }
      }
    }

    return stats;
  }

  async prepareTaskRun(taskId: string): Promise<TaskRunRecord> {
    const task = this.db.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found.`);
    }

    const previousRun = this.db
      .listTaskRuns(taskId)
      .find((candidate) => candidate.status !== "failed");
    const runDir = join(this.stagingRoot, randomUUID());
    await mkdir(runDir, { recursive: true });
    const run = this.db.createTaskRun(taskId, runDir);

    try {
      const manifest = await this.stageTask(task, run.id, runDir);
      await this.writeWorkspaceScaffold(task, run, manifest, previousRun ?? null);
      await writeFile(
        join(runDir, "manifest.json"),
        JSON.stringify(manifest, null, 2),
        "utf8"
      );
      await this.seedRunMetadata(task, run.id, manifest);
      this.db.updateTaskRun({
        ...run,
        status: "ready",
        updatedAt: new Date().toISOString()
      });
      try {
        const stats = await this.buildTaskIngestionIndex(task.id, {
          taskRunId: run.id,
          force: true
        });
        if (stats.documentsIndexed > 0) {
          this.recordRuntimeMessage(
            task.id,
            `Prepared the Codex context index with ${stats.documentsIndexed} document${stats.documentsIndexed === 1 ? "" : "s"} and ${stats.chunksIndexed} chunks.`
          );
          await this.updateWorkspaceScaffold(task, run.id, manifest);
        }
      } catch (error) {
        this.recordRuntimeMessage(
          task.id,
          `The local context index could not be prebuilt for this run.\n\n${error instanceof Error ? error.message : String(error)}`
        );
      }
      return this.db.getTaskRun(run.id)!;
    } catch (error) {
      this.db.updateTaskRun({
        ...run,
        status: "failed",
        updatedAt: new Date().toISOString()
      });
      await rm(runDir, { recursive: true, force: true });
      throw error;
    }
  }

  resolveApproval(
    taskRunId: string,
    approvalId: string,
    status: ApprovalRecord["status"]
  ): ApprovalRecord {
    const approval = this.db
      .listApprovals(taskRunId)
      .find((candidate) => candidate.id === approvalId);
    if (!approval) {
      throw new Error(`Approval ${approvalId} not found for run ${taskRunId}.`);
    }

    const updated: ApprovalRecord = {
      ...approval,
      status,
      resolvedAt: status === "pending" ? undefined : new Date().toISOString()
    };
    this.db.upsertApproval(updated);
    return updated;
  }

  async previewTaskDiff(taskRunId: string): Promise<DiffPreview> {
    const run = this.db.getTaskRun(taskRunId);
    if (!run) {
      throw new Error(`Task run ${taskRunId} not found.`);
    }

    const manifest = await this.readManifest(run.stagingPath);
    const operations: DiffOperation[] = [];

    for (const attachment of manifest.attachments) {
      if (attachment.mode === "reference") {
        continue;
      }

      const hostInventory = await inventoryPath(attachment.hostPath);
      const stageInventory = await inventoryPath(attachment.stagingPath);
      const snapshotInventory = attachment.files;
      operations.push(
        ...buildDiffOperations(
          attachment.attachmentId,
          hostInventory,
          stageInventory,
          snapshotInventory
        )
      );
    }

    return {
      taskRunId,
      generatedAt: new Date().toISOString(),
      operations: operations.sort((left, right) => {
        const leftPath = left.targetPath ?? left.sourcePath ?? left.relativePath ?? "";
        const rightPath =
          right.targetPath ?? right.sourcePath ?? right.relativePath ?? "";
        return leftPath.localeCompare(rightPath);
      })
    };
  }

  private async stageTask(
    task: TaskSpec,
    taskRunId: string,
    runDir: string
  ): Promise<TaskRunManifest> {
    const attachmentsDir = join(runDir, "attachments");
    await mkdir(attachmentsDir, { recursive: true });

    const snapshots: StagedAttachmentSnapshot[] = [];

    for (const attachment of task.attachments) {
      const stagingPath = join(attachmentsDir, `${attachment.id}-${basename(attachment.hostPath)}`);
      await mkdir(stagingPath, { recursive: true });

      if (existsSync(attachment.hostPath)) {
        await cp(attachment.hostPath, stagingPath, { recursive: true });
      }

      snapshots.push({
        attachmentId: attachment.id,
        mode: attachment.mode,
        hostPath: attachment.hostPath,
        stagingPath,
        files: await inventoryPath(attachment.hostPath)
      });
    }

    return {
      taskRunId,
      taskId: task.id,
      createdAt: new Date().toISOString(),
      attachments: snapshots
    };
  }

  private async readManifest(runDir: string): Promise<TaskRunManifest> {
    const raw = await readFile(join(runDir, "manifest.json"), "utf8");
    return JSON.parse(raw) as TaskRunManifest;
  }

  private async seedRunMetadata(
    task: TaskSpec,
    taskRunId: string,
    manifest: TaskRunManifest
  ): Promise<void> {
    const outputAttachments = manifest.attachments.filter(
      (attachment) => attachment.mode === "output"
    );

    // Auto-approve all permissions for student users — no approval prompts.
    const now = new Date().toISOString();
    const approvals: ApprovalRecord[] = [
      {
        id: randomUUID(),
        taskRunId,
        kind: "command",
        status: "approved",
        title: "Allow Codex to use task-local tools",
        detail: "Auto-approved for Stuart student runtime.",
        createdAt: now,
        resolvedAt: now
      },
      {
        id: randomUUID(),
        taskRunId,
        kind: "file",
        status: "approved",
        title: "Allow staged filesystem changes",
        detail: "Auto-approved for Stuart student runtime.",
        createdAt: now,
        resolvedAt: now
      }
    ];

    for (const approval of approvals) {
      this.db.upsertApproval(approval);
    }

    for (const attachment of outputAttachments) {
      this.db.upsertArtifact({
        id: randomUUID(),
        taskRunId,
        guestPath: attachment.stagingPath,
        proposedHostPath: attachment.hostPath,
        type: "folder",
        status: "draft",
        createdAt: new Date().toISOString()
      });
    }
  }

  private emitEvent(event: WorkspaceEvent): void {
    this.events.emit("event", event);
  }

  private resolveThreadOwner(
    threadId: string
  ): { taskId: string; worker?: TaskWorkerRecord } | null {
    const taskId = this.db.getTaskIdByThreadId(threadId);
    if (taskId) {
      return { taskId };
    }

    const workerId = this.db.getTaskWorkerIdByThreadId(threadId);
    if (!workerId) {
      return null;
    }

    const worker = this.db.getTaskWorker(workerId);
    if (!worker) {
      return null;
    }

    return {
      taskId: worker.parentTaskId,
      worker
    };
  }

  private emitWorkerEvent(worker: TaskWorkerRecord): void {
    this.emitEvent({
      type: "task.worker",
      taskId: worker.parentTaskId,
      workerId: worker.id,
      status: worker.status,
      role: worker.role,
      summary: worker.summary
    });
  }

  private async resolveTaskExecutionContext(task: TaskSpec): Promise<TaskExecutionContext> {
    const latestRun = this.db
      .listTaskRuns(task.id)
      .find((candidate) => candidate.status !== "failed");
    if (latestRun && (await this.runMatchesTaskScope(task, latestRun))) {
      return {
        cwd: latestRun.stagingPath,
        taskRun: latestRun,
        preparedRun: null
      };
    }

    const preparedRun = await this.prepareTaskRun(task.id);
    return {
      cwd: preparedRun.stagingPath,
      taskRun: preparedRun,
      preparedRun
    };
  }

  private async spawnExploreWorkers(
    task: TaskSpec,
    context: TaskExecutionContext,
    question: string
  ): Promise<void> {
    // Get all indexed documents and group them into exploration batches
    const docs = context.taskRun
      ? this.db.listIngestionDocuments(task.id, context.taskRun.id)
      : [];
    if (docs.length < 8) return;

    // Group files into batches of ~5 for parallel exploration
    const batchSize = 5;
    const batches: string[][] = [];
    const sortedDocs = docs
      .filter((d) => d.status === "indexed")
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    for (let i = 0; i < sortedDocs.length; i += batchSize) {
      batches.push(sortedDocs.slice(i, i + batchSize).map((d) => cleanSourceName(d.relativePath)));
    }

    // Spawn up to 3 parallel explore workers
    const maxWorkers = Math.min(batches.length, 3);
    const workerPromises: Promise<void>[] = [];

    for (let i = 0; i < maxWorkers; i++) {
      const batchFiles = batches[i]!;
      const objective = `Explore these study materials and extract key concepts relevant to: "${question}". Focus on: ${batchFiles.join(", ")}. Summarize what you find concisely.`;

      workerPromises.push(
        this.createTaskWorker(task.id, {
          role: "explorer",
          objective,
          taskRunId: context.taskRun?.id,
        }).then(() => undefined)
      );
    }

    await Promise.allSettled(workerPromises);
    this.emitEvent({
      type: "task.agent",
      taskId: task.id,
      agentId: "explore-swarm",
      status: "running",
      label: `Exploring ${docs.length} sources across ${maxWorkers} agents`,
    });
  }

  private async runMatchesTaskScope(task: TaskSpec, run: TaskRunRecord): Promise<boolean> {
    try {
      const manifest = await this.readManifest(run.stagingPath);
      if (manifest.attachments.length !== task.attachments.length) {
        return false;
      }

      const currentScope = task.attachments
        .map((attachment) => `${attachment.id}:${attachment.mode}:${attachment.hostPath}`)
        .sort();
      const runScope = manifest.attachments
        .map((attachment) => `${attachment.attachmentId}:${attachment.mode}:${attachment.hostPath}`)
        .sort();

      return currentScope.every((entry, index) => entry === runScope[index]);
    } catch {
      return false;
    }
  }

  private async ensureTaskThread(task: TaskSpec, cwd: string): Promise<string> {
    const project = this.db.getProject(task.projectId);
    const persistedThreadId = this.db.getTaskThreadId(task.id);
    if (persistedThreadId) {
      if (!this.loadedThreadIds.has(persistedThreadId)) {
        try {
          await this.codex.request("thread/resume", {
            threadId: persistedThreadId,
            cwd,
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            personality: "pragmatic",
            developerInstructions: buildTeachingInstructions(project ?? { id: "", name: "Study", rootPath: cwd, createdAt: "", updatedAt: "" }, task, this.db),
            persistExtendedHistory: true
          });
        } catch (err) {
          // Thread no longer exists in Codex (e.g. after server restart) — clear and start fresh
          process.stderr.write(`[stuart] thread/resume failed for ${persistedThreadId}, starting fresh: ${String(err)}\n`);
          this.loadedThreadIds.delete(persistedThreadId);
          this.db.clearTaskThreadId(task.id);
          return this.startTaskThread(task, cwd);
        }
        this.loadedThreadIds.add(persistedThreadId);
        this.recordRuntimeMessage(task.id, "Resumed the existing Stuart thread.");
      }
      return persistedThreadId;
    }

    return this.startTaskThread(task, cwd);
  }

  private async startTaskThread(task: TaskSpec, cwd: string): Promise<string> {
    const project = this.db.getProject(task.projectId);
    const started = await this.codex.request<{
      thread: { id: string };
    }>("thread/start", {
      cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      personality: "pragmatic",
      model: "gpt-5.4-mini",
      developerInstructions: buildTeachingInstructions(project ?? { id: "", name: "Study", rootPath: cwd, createdAt: "", updatedAt: "" }, task, this.db),
      serviceName: "Stuart",
      persistExtendedHistory: true,
      config: {
        web_search: "live",
      },
    });
    this.db.setTaskThreadId(task.id, started.thread.id);
    this.loadedThreadIds.add(started.thread.id);
    this.recordRuntimeMessage(task.id, "Started a new Stuart thread for this task.");
    return started.thread.id;
  }

  private async ensureWorkerThread(
    task: TaskSpec,
    worker: TaskWorkerRecord,
    cwd: string
  ): Promise<string> {
    if (worker.threadId) {
      if (!this.loadedThreadIds.has(worker.threadId)) {
        try {
          await this.codex.request("thread/resume", {
            threadId: worker.threadId,
            cwd,
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            personality: "pragmatic",
            developerInstructions: buildWorkerDeveloperInstructions(task, worker),
            persistExtendedHistory: true
          });
        } catch {
          this.loadedThreadIds.delete(worker.threadId);
          return this.startWorkerThread(task, worker, cwd);
        }
        this.loadedThreadIds.add(worker.threadId);
      }
      return worker.threadId;
    }

    return this.startWorkerThread(task, worker, cwd);
  }

  private async startWorkerThread(
    task: TaskSpec,
    worker: TaskWorkerRecord,
    cwd: string
  ): Promise<string> {
    const started = await this.codex.request<{
      thread: { id: string };
    }>("thread/start", {
      cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      personality: "pragmatic",
      model: "gpt-5.4-mini",
      developerInstructions: buildWorkerDeveloperInstructions(task, worker),
      serviceName: `Stuart Worker:${worker.role}`,
      persistExtendedHistory: true
    });
    this.db.setTaskWorkerThreadId(worker.id, started.thread.id);
    this.loadedThreadIds.add(started.thread.id);
    return started.thread.id;
  }

  private async handleCodexNotification(notification: {
    method: string;
    params?: unknown;
  }): Promise<void> {
    switch (notification.method) {
      case "turn/started": {
        const params = notification.params as {
          threadId: string;
          turn: { id: string };
        };
        const owner = this.resolveThreadOwner(params.threadId);
        if (!owner) {
          return;
        }

        const state = this.turns.get(params.turn.id);
        if (!state) {
          this.turns.set(params.turn.id, {
            taskId: owner.taskId,
            threadId: params.threadId,
            turnId: params.turn.id,
            kind: owner.worker ? "worker" : "task",
            workerId: owner.worker?.id,
            assistantText: "",
            thinkingLabel: owner.worker
              ? buildWorkerThinkingLabel(owner.worker)
              : "Thinking through the request",
            startedEmitted: true
          });
          if (owner.worker) {
            this.emitWorkerEvent({
              ...owner.worker,
              status: "running",
              updatedAt: new Date().toISOString()
            });
          } else {
            this.emitEvent({
              type: "codex.turn.started",
              taskId: owner.taskId,
              threadId: params.threadId,
              turnId: params.turn.id,
              label: "Thinking through the request"
            });
          }
          return;
        }

        if (!state.startedEmitted && state.kind === "task") {
          state.startedEmitted = true;
          this.emitEvent({
            type: "codex.turn.started",
            taskId: state.taskId,
            threadId: state.threadId,
            turnId: state.turnId,
            label: state.thinkingLabel
          });
        }
        return;
      }

      case "item/reasoning/summaryTextDelta": {
        const params = notification.params as {
          threadId: string;
          turnId: string;
          delta: string;
        };
        const state = this.turns.get(params.turnId);
        if (!state || !params.delta.trim()) {
          return;
        }

        state.thinkingLabel = summarizeThinkingDelta(
          `${state.thinkingLabel} ${params.delta}`.trim()
        );
        if (state.kind === "worker") {
          return;
        }
        this.emitEvent({
          type: "codex.thinking",
          taskId: state.taskId,
          threadId: state.threadId,
          turnId: state.turnId,
          label: state.thinkingLabel
        });
        return;
      }

      case "item/agentMessage/delta": {
        const params = notification.params as {
          threadId: string;
          turnId: string;
          itemId: string;
          delta: string;
        };
        const state = this.turns.get(params.turnId);
        if (!state) {
          return;
        }

        state.assistantItemId = params.itemId;
        state.assistantText += params.delta;

        // Stream the delta to the UI for real-time display
        if (state.kind === "task") {
          this.emitEvent({
            type: "codex.message.delta",
            taskId: state.taskId,
            threadId: state.threadId,
            turnId: state.turnId,
            itemId: params.itemId,
            delta: params.delta
          });
        }
        return;
      }

      case "item/started": {
        const params = notification.params as {
          threadId: string;
          turnId: string;
          item: Record<string, unknown> & {
            id: string;
            type: string;
          };
        };
        const state = this.turns.get(params.turnId);
        const owner = state
          ? {
              taskId: state.taskId,
              worker: state.workerId ? this.db.getTaskWorker(state.workerId) : undefined
            }
          : this.resolveThreadOwner(params.threadId);
        if (!owner) {
          return;
        }

        // Detect context compaction starting
        const itemType = (params.item.type ?? "").toString().toLowerCase();
        if (itemType === "contextcompaction" || itemType === "context_compaction") {
          if (state && state.kind === "task") {
            this.emitEvent({
              type: "task.context_compacting",
              taskId: state.taskId,
              active: true,
              message: "Compacting conversation context..."
            });
            state.thinkingLabel = "Compacting conversation context...";
            this.emitEvent({
              type: "codex.thinking",
              taskId: state.taskId,
              threadId: state.threadId,
              turnId: state.turnId,
              label: state.thinkingLabel
            });
          }
          return;
        }

        const detail = describeRuntimeItem(params.item, "started");
        const agentEvent = buildCodexAgentEvent(params.item, "started");
        if (agentEvent) {
          this.emitEvent({
            type: "task.agent",
            taskId: owner.taskId,
            agentId: agentEvent.agentId,
            status: agentEvent.status,
            label: agentEvent.label,
            detail: agentEvent.detail
          });
        }

        // Update the thinking label so the UI shows what Codex is doing
        if (detail && state && state.kind === "task") {
          state.thinkingLabel = summarizeActivityForStudent(detail);
          this.emitEvent({
            type: "codex.thinking",
            taskId: state.taskId,
            threadId: state.threadId,
            turnId: state.turnId,
            label: state.thinkingLabel
          });
        }

        if (!detail) {
          return;
        }

        this.recordRuntimeMessage(owner.taskId, detail, `runtime:item:${params.item.id}:started`);
        return;
      }

      case "item/completed": {
        const params = notification.params as {
          threadId: string;
          turnId: string;
          item: Record<string, unknown> & {
            type: string;
            id: string;
            text?: string;
            phase?: "commentary" | "final_answer" | null;
          };
        };
        const state = this.turns.get(params.turnId);
        if (
          params.item.type === "agentMessage" &&
          params.item.phase === "commentary" &&
          typeof params.item.text === "string"
        ) {
          if (state) {
            state.thinkingLabel = summarizeThinkingDelta(params.item.text);
            if (state.kind === "task") {
              this.emitEvent({
                type: "codex.thinking",
                taskId: state.taskId,
                threadId: state.threadId,
                turnId: state.turnId,
                label: state.thinkingLabel
              });
            }
          }
          return;
        }

        const owner =
          state
            ? {
                taskId: state.taskId,
                worker: state.workerId ? this.db.getTaskWorker(state.workerId) : undefined
              }
            : this.resolveThreadOwner(params.threadId);
        if (!owner) {
          return;
        }

        if (params.item.type !== "agentMessage" || typeof params.item.text !== "string") {
          const agentEvent = buildCodexAgentEvent(params.item, "completed");
          if (agentEvent) {
            this.emitEvent({
              type: "task.agent",
              taskId: owner.taskId,
              agentId: agentEvent.agentId,
              status: agentEvent.status,
              label: agentEvent.label,
              detail: agentEvent.detail
            });
          }
          const detail = describeRuntimeItem(params.item, "completed");
          if (detail) {
            this.recordRuntimeMessage(
              owner.taskId,
              detail,
              `runtime:item:${params.item.id}:completed`
            );
          }
          return;
        }

        if (state?.kind === "worker" && state.workerId) {
          state.assistantText = params.item.text;
          return;
        }

        // Store the final assistant text for artifact detection in turn/completed
        if (state) {
          state.assistantText = params.item.text;
        }

        const message = this.db.upsertTaskMessage({
          id: params.item.id,
          taskId: owner.taskId,
          role: "assistant",
          content: params.item.text
        });
        this.emitEvent({
          type: "codex.message.completed",
          taskId: owner.taskId,
          threadId: params.threadId,
          turnId: params.turnId,
          message
        });
        return;
      }

      case "turn/completed": {
        const params = notification.params as {
          threadId: string;
          turn: {
            id: string;
            status: string;
            error?: { message?: string } | null;
          };
        };
        const state =
          this.turns.get(params.turn.id) ??
          (() => {
            const owner = this.resolveThreadOwner(params.threadId);
            return owner
              ? {
                  taskId: owner.taskId,
                  threadId: params.threadId,
                  turnId: params.turn.id,
                  kind: owner.worker ? "worker" : "task",
                  workerId: owner.worker?.id,
                  assistantText: "",
                  thinkingLabel: "",
                  startedEmitted: true,
                  cwd: undefined,
                  triggersReindex: undefined,
                }
              : null;
          })();

        if (!state) {
          return;
        }

        if (state.kind === "worker" && state.workerId) {
          const worker = this.db.getTaskWorker(state.workerId);
          if (worker) {
            const completedWorker: TaskWorkerRecord = {
              ...worker,
              status: params.turn.status === "failed" ? "failed" : "completed",
              summary:
                params.turn.status === "failed"
                  ? params.turn.error?.message ?? "Worker failed."
                  : state.assistantText.trim() || worker.summary,
              threadId: state.threadId,
              updatedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              taskRunId: worker.taskRunId
            };
            this.db.updateTaskWorker(completedWorker);
            this.emitWorkerEvent(completedWorker);
            if (params.turn.status === "failed") {
              this.recordRuntimeMessage(
                state.taskId,
                `${formatWorkerLabel(worker.role)} worker could not finish.\n\n${completedWorker.summary ?? "Unknown failure."}`
              );
            } else {
              this.recordRuntimeMessage(
                state.taskId,
                `${formatWorkerLabel(worker.role)} worker finished.\n\n${truncateForLog(
                  completedWorker.summary ?? "Done.",
                  600
                )}`
              );
            }
          }
          this.turns.delete(params.turn.id);
          return;
        }

        if (params.turn.status === "failed") {
          const detail = params.turn.error?.message ?? "Codex could not finish this turn.";
          this.db.createTaskMessage({
            taskId: state.taskId,
            role: "system",
            content: `Codex could not finish this turn.\n\n${detail}`
          });
          this.emitEvent({
            type: "task.message",
            taskId: state.taskId
          });
          this.emitEvent({
            type: "codex.turn.completed",
            taskId: state.taskId,
            threadId: state.threadId,
            turnId: state.turnId,
            status: "failed",
            error: detail
          });
        } else {
          this.emitEvent({
            type: "codex.turn.completed",
            taskId: state.taskId,
            threadId: state.threadId,
            turnId: state.turnId,
            status: "completed"
          });

          // Artifact detection: try to parse any assistant response that contains JSON or script artifacts
          try {
            const assistantText = state.assistantText.trim();
            if (assistantText) {
              const parsed = tryParseArtifactJson(assistantText);
              if (parsed) {
                const artifact = this.db.createStudyArtifact({
                  taskId: state.taskId,
                  kind: parsed.kind,
                  title: parsed.title,
                  payload: JSON.stringify(parsed.data)
                });
                this.recordRuntimeMessage(
                  state.taskId,
                  `Detected and stored a ${parsed.kind} study artifact: "${parsed.title}".`
                );

                // Render document kinds to binary files
                if (parsed.kind.startsWith("document_")) {
                  try {
                    const safeFilename = (parsed.title || "document")
                      .replace(/[^a-zA-Z0-9_\- ]/g, "")
                      .replace(/\s+/g, "_")
                      .slice(0, 80);
                    const outputDir = this.resolveDocumentOutputDir(state.taskId);
                    const filePath = await renderDocument(
                      parsed.kind,
                      parsed.data,
                      outputDir,
                      safeFilename
                    );
                    this.db.updateStudyArtifactFilePath(artifact.id, filePath);
                    const ext = parsed.kind.replace("document_", "").toUpperCase();
                    this.recordRuntimeMessage(
                      state.taskId,
                      `Generated ${ext} document: "${parsed.title}".`
                    );
                  } catch (renderErr) {
                    // Rendering is non-fatal — artifact JSON is still stored
                    this.recordRuntimeMessage(
                      state.taskId,
                      `Note: document rendering failed but the artifact data was saved. Error: ${String(renderErr)}`
                    );
                  }
                }
              } else if (this.sandboxAvailable) {
                // No JSON artifact found — try script-based execution path
                const script = tryExtractScript(assistantText);
                if (script) {
                  const ext = script.outputFilename.split(".").pop() ?? "";
                  const kindMap: Record<string, string> = {
                    pdf: "document_pdf",
                    docx: "document_docx",
                    xlsx: "document_xlsx",
                    pptx: "document_pptx",
                  };
                  const kind = kindMap[ext] ?? `document_${ext}`;

                  // Store the artifact with script payload
                  const artifact = this.db.createStudyArtifact({
                    taskId: state.taskId,
                    kind,
                    title: script.title,
                    payload: JSON.stringify({
                      script: script.script,
                      language: script.language,
                      outputFilename: script.outputFilename,
                    })
                  });
                  this.recordRuntimeMessage(
                    state.taskId,
                    `Detected scripted ${ext.toUpperCase()} artifact: "${script.title}". Executing in sandbox...`
                  );

                  this.emitEvent({
                    type: "sandbox.execution.started",
                    taskId: state.taskId,
                    language: script.language,
                    outputFilename: script.outputFilename,
                  });

                  try {
                    const docOutputDir = this.resolveDocumentOutputDir(state.taskId);
                    const result = await this.sandbox.executeScript({
                      language: script.language,
                      script: script.script,
                      outputFilename: script.outputFilename,
                      taskId: state.taskId,
                      outputDir: docOutputDir,
                      sourcesDir: state.cwd,
                    });

                    this.emitEvent({
                      type: "sandbox.execution.completed",
                      taskId: state.taskId,
                      success: result.success,
                      outputFilename: script.outputFilename,
                      durationMs: result.durationMs,
                      error: result.success ? undefined : result.stderr,
                    });

                    if (result.success && result.outputPath) {
                      this.db.updateStudyArtifactFilePath(artifact.id, result.outputPath);
                      this.recordRuntimeMessage(
                        state.taskId,
                        `Generated ${ext.toUpperCase()} document via sandbox: "${script.title}" (${result.durationMs}ms).`
                      );
                    } else {
                      this.recordRuntimeMessage(
                        state.taskId,
                        `Sandbox execution failed (exit ${result.exitCode}): ${truncateForLog(result.stderr || result.stdout, 300)}`
                      );
                    }
                  } catch (sandboxErr) {
                    this.emitEvent({
                      type: "sandbox.execution.completed",
                      taskId: state.taskId,
                      success: false,
                      outputFilename: script.outputFilename,
                      durationMs: 0,
                      error: String(sandboxErr),
                    });
                    this.recordRuntimeMessage(
                      state.taskId,
                      `Sandbox execution error: ${String(sandboxErr)}`
                    );
                  }
                }
              }
            }
          } catch {
            // Artifact detection is best-effort; don't block the turn.
          }

          // If this turn wrote new research files (sources/, curriculum.md),
          // copy them from staging to the project root so the user can see them.
          const shouldSyncFiles = state.triggersReindex
            || /\bsources\//i.test(state.assistantText)
            || /\bcurriculum\.md\b/i.test(state.assistantText)
            || /(?:created|wrote|saved)\s+\d+\s+(?:files?|documents?|sources?)/i.test(state.assistantText);
          if (shouldSyncFiles && state.cwd) {
            try {
              const projectRoot = this.resolveProjectRoot(state.taskId);
              if (projectRoot && projectRoot !== state.cwd) {
                // Copy sources/ directory
                const stagingSources = join(state.cwd, "sources");
                if (existsSync(stagingSources)) {
                  const destSources = join(projectRoot, "sources");
                  await cp(stagingSources, destSources, { recursive: true, force: true });
                }
                // Copy curriculum.md
                const stagingCurriculum = join(state.cwd, "curriculum.md");
                if (existsSync(stagingCurriculum)) {
                  await cp(stagingCurriculum, join(projectRoot, "curriculum.md"), { force: true });
                }
                this.recordRuntimeMessage(
                  state.taskId,
                  `Synced research files to your project folder.`
                );
              }
            } catch {
              // Non-critical — files still available in staging
            }

            // Re-index workspace with new files
            try {
              await this.buildTaskIngestionIndex(state.taskId, { force: true });
              this.recordRuntimeMessage(
                state.taskId,
                "Re-indexed workspace — new materials are now available for study."
              );
            } catch {
              // Non-critical — indexing will happen lazily on next retrieval
            }
          }
        }

        this.turns.delete(params.turn.id);
        return;
      }

      case "thread/compacted": {
        const params = notification.params as {
          threadId: string;
          turnId?: string;
        };
        const owner = this.resolveThreadOwner(params.threadId);
        if (owner && !owner.worker) {
          this.emitEvent({
            type: "task.context_compacting",
            taskId: owner.taskId,
            active: false,
            message: "Context compacted — earlier conversation history has been condensed."
          });
          this.recordRuntimeMessage(
            owner.taskId,
            "Context compaction completed. The conversation history has been condensed to stay within the model's context window."
          );
        }
        return;
      }

      default:
        return;
    }
  }

  private handleCodexServerRequest(request: {
    method: string;
    params?: unknown;
  }): unknown {
    // Auto-approve everything for student users — no approval prompts.
    const params = request.params as Record<string, unknown> | undefined;
    const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    const taskId = threadId ? this.resolveThreadOwner(threadId)?.taskId : undefined;

    switch (request.method) {
      case "item/commandExecution/requestApproval": {
        if (taskId) {
          const command = readFirstString(params, ["command", "cmd"]);
          this.recordRuntimeMessage(
            taskId,
            command
              ? `Running: \`${truncateForLog(command, 120)}\``
              : "Running a command."
          );
        }
        return { decision: "accept" };
      }
      case "item/fileChange/requestApproval":
        return { decision: "accept" };
      case "item/tool/requestUserInput":
        return { answers: {} };
      case "mcpServer/elicitation/request":
        return { action: "accept" };
      case "item/tool/call":
        return { decision: "accept" };
      default:
        // Accept any unknown approval requests as well
        return { decision: "accept" };
    }
  }

  private async collectWorkspaceFiles(
    taskId: string,
    taskRunId?: string,
    limit = 250
  ): Promise<ResolvedWorkspaceFile[]> {
    const task = this.db.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found.`);
    }

    const run =
      (taskRunId ? this.db.getTaskRun(taskRunId) : undefined) ??
      this.db.listTaskRuns(taskId)[0];
    const roots: Array<{
      rootPath: string;
      sourceLabel: string;
      sourceKind: "project" | "attachment" | "staging";
      attachmentMode?: AttachmentMode;
    }> = [];

    if (run) {
      roots.push({
        rootPath: run.stagingPath,
        sourceLabel: "Staged workspace",
        sourceKind: "staging"
      });
    } else if (task.attachments.length > 0) {
      for (const attachment of task.attachments) {
        roots.push({
          rootPath: attachment.hostPath,
          sourceLabel: `${attachment.mode} attachment`,
          sourceKind: "attachment",
          attachmentMode: attachment.mode
        });
      }
    } else {
      const project = this.db.getProject(task.projectId);
      if (project) {
        roots.push({
          rootPath: project.rootPath,
          sourceLabel: "Project root",
          sourceKind: "project"
        });
      }
    }

    const entries: ResolvedWorkspaceFile[] = [];
    for (const root of roots) {
      entries.push(
        ...(await collectWorkspaceFilesFromRoot(taskId, run?.id, root.rootPath, {
          sourceLabel: root.sourceLabel,
          sourceKind: root.sourceKind,
          attachmentMode: root.attachmentMode
        }))
      );
    }

    return entries
      .filter((entry) => !shouldHideWorkspacePath(entry.relativePath))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
      .slice(0, limit);
  }

  private async buildRetrievedContext(
    task: TaskSpec,
    taskRun: TaskRunRecord | null,
    message: string
  ): Promise<string | null> {
    if (!taskRun || !shouldUseLocalRetrieval(task, message)) {
      return null;
    }

    const statsBefore = this.db.getIngestionStats(task.id, taskRun.id);
    const stats =
      statsBefore.documentsIndexed > 0
        ? statsBefore
        : await this.buildTaskIngestionIndex(task.id, { taskRunId: taskRun.id, force: true });

    if (statsBefore.documentsIndexed === 0 && stats.documentsIndexed > 0) {
      this.recordRuntimeMessage(
        task.id,
        `Indexed ${stats.documentsIndexed} local document${stats.documentsIndexed === 1 ? "" : "s"} into the context store (${stats.chunksIndexed} chunks).`
      );
    }

    // Smart file targeting: if user mentions specific chapters/lectures, prioritize those files
    const targetedFiles = extractTargetedFiles(message);

    // Strip artifact-generation noise from the search query to improve retrieval relevance
    // "create 10 flashcards on chapter 6 ANS" → "chapter 6 ANS"
    const cleanedQuery = sanitizeRetrievalQuery(message);
    const searchQuery = cleanedQuery.length >= 3 ? cleanedQuery : message;

    // Fetch more chunks and use the full text rather than snippets
    let results = this.db.searchIngestionChunks(task.id, searchQuery, {
      taskRunId: taskRun.id,
      limit: 30
    });

    // If we detected specific file targets, boost results from those files
    if (targetedFiles.length > 0) {
      const boosted = results.sort((a, b) => {
        const aMatch = targetedFiles.some((t) => a.relativePath.toLowerCase().includes(t));
        const bMatch = targetedFiles.some((t) => b.relativePath.toLowerCase().includes(t));
        if (aMatch && !bMatch) return -1;
        if (!aMatch && bMatch) return 1;
        return 0;
      });
      results = boosted;
    }

    // Deduplicate overlapping chunks from the same document section
    const seen = new Set<string>();
    results = results.filter((r) => {
      const key = `${r.relativePath}:${r.heading ?? ""}:${r.text.slice(0, 80)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (results.length === 0) {
      return null;
    }

    const uniqueDocs = new Set(results.map((result) => result.relativePath));
    this.recordRuntimeMessage(
      task.id,
      `Retrieved ${results.length} relevant context chunk${results.length === 1 ? "" : "s"} from ${uniqueDocs.size} local document${uniqueDocs.size === 1 ? "" : "s"}.`
    );

    const recentMessages = this.db.listTaskMessages(task.id).slice(-10);
    const conversationContext = recentMessages.length > 0
      ? [
          "Recent conversation turns:",
          ...recentMessages.map((msg) => `[${msg.role}]: ${truncateForLog(msg.content, 300)}`)
        ].join("\n")
      : "";

    // Use full chunk text (not snippets) for richer context — truncate only very long chunks
    return [
      "Local retrieved context from the staged workspace. Use these excerpts as your primary source material. Cite source names when relying on them. If you need more detail on a specific section, use grep/cat to read the full file.",
      ...results.map((result, index) =>
        [
          `--- [${index + 1}] ${cleanSourceName(result.relativePath)}${result.heading ? ` — ${result.heading}` : ""}${result.locator ? ` (${result.locator})` : ""} ---`,
          result.text.length > 2000 ? result.text.slice(0, 2000) + "\n[...truncated]" : result.text
        ].join("\n")
      ),
      ...(conversationContext ? [conversationContext] : [])
    ].join("\n\n");
  }

  private async writeWorkspaceScaffold(
    task: TaskSpec,
    run: TaskRunRecord,
    manifest: TaskRunManifest,
    previousRun: TaskRunRecord | null
  ): Promise<void> {
    const metaDir = join(run.stagingPath, ".stuart");
    await mkdir(metaDir, { recursive: true });

    let previousMemory = "";
    if (previousRun) {
      for (const candidate of [".stuart", ".codex-cowork", ".codex-stuart"]) {
        try {
          previousMemory = await readFile(
            join(previousRun.stagingPath, candidate, "workspace-memory.md"),
            "utf8"
          );
          break;
        } catch {
          previousMemory = "";
        }
      }
    }

    const scopeLines = manifest.attachments.map((attachment) =>
      `- ${attachment.mode}: ${attachment.hostPath} -> ${relative(run.stagingPath, attachment.stagingPath)}`
    );

    const memorySections = [
      "# Stuart Workspace Memory",
      "",
      "This file lives inside the staged workspace so Codex can preserve durable task memory across turns and across restaged workspaces.",
      "",
      "## Task",
      `- Title: ${task.title}`,
      `- Objective: ${task.objective}`,
      `- Auth: ${task.authMode === "chatgpt" ? "ChatGPT sign-in" : "API key"}`,
      `- Browser: ${task.browserEnabled ? "enabled" : "disabled"}`,
      "",
      "## Scope",
      ...(scopeLines.length > 0 ? scopeLines : ["- No scoped folders attached yet."]),
      "",
      "## Working Notes",
      "- Add durable facts, evolving plans, and handoff notes here when the task spans multiple turns.",
      "- Keep this concise and update it when the plan or discovered facts change.",
      ""
    ];

    if (previousMemory.trim()) {
      memorySections.push(
        "## Previous Memory",
        "",
        previousMemory.trim().slice(0, 4000),
        ""
      );
    }

    await writeFile(join(metaDir, "workspace-memory.md"), memorySections.join("\n"), "utf8");
    await writeFile(
      join(metaDir, "workspace-map.json"),
      JSON.stringify(
        {
          taskId: task.id,
          taskTitle: task.title,
          taskObjective: task.objective,
          runId: run.id,
          stagingPath: run.stagingPath,
          attachments: manifest.attachments.map((attachment) => ({
            attachmentId: attachment.attachmentId,
            mode: attachment.mode,
            hostPath: attachment.hostPath,
            stagingPath: attachment.stagingPath
          }))
        },
        null,
        2
      ),
      "utf8"
    );
  }

  private async updateWorkspaceScaffold(
    task: TaskSpec,
    taskRunId: string,
    manifest: TaskRunManifest
  ): Promise<void> {
    const run = this.db.getTaskRun(taskRunId);
    if (!run) {
      return;
    }

    const stats = this.db.getIngestionStats(task.id, taskRunId);
    const metaDir = join(run.stagingPath, ".stuart");
    await mkdir(metaDir, { recursive: true });
    await writeFile(
      join(metaDir, "context-index.json"),
      JSON.stringify(
        {
          taskId: task.id,
          taskRunId,
          generatedAt: new Date().toISOString(),
          stats,
          documents: this.db.listIngestionDocuments(task.id, taskRunId),
          attachments: manifest.attachments.map((attachment) => ({
            attachmentId: attachment.attachmentId,
            mode: attachment.mode,
            hostPath: attachment.hostPath,
            stagingPath: attachment.stagingPath
          }))
        },
        null,
        2
      ),
      "utf8"
    );
  }

  private recordRuntimeMessage(taskId: string, content: string, id?: string): void {
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }

    this.db.upsertTaskMessage({
      id,
      taskId,
      role: "system",
      content: trimmed
    });
    this.emitEvent({
      type: "task.message",
      taskId
    });
  }

  async close(): Promise<void> {
    await this.sandbox.close();
    await this.codex.close();
    this.db.close();
  }
}

export async function inventoryPath(rootPath: string): Promise<Record<string, FileFingerprint>> {
  if (!existsSync(rootPath)) {
    return {};
  }

  const entries = await walk(rootPath);
  return Object.fromEntries(
    entries.map((entry) => [
      entry.relativePath,
      {
        relativePath: entry.relativePath,
        size: entry.size,
        sha1: entry.sha1,
        mtimeMs: entry.mtimeMs
      }
    ])
  );
}

async function walk(rootPath: string): Promise<InventoryEntry[]> {
  const normalizedRoot = resolve(rootPath);
  const results: InventoryEntry[] = [];

  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const absolutePath = join(directory, child.name);
      if (child.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!child.isFile()) {
        continue;
      }

      const fileStat = await stat(absolutePath);
      const relativePath = relative(normalizedRoot, absolutePath);
      const content = await readFile(absolutePath);
      const sha1 = createHash("sha1").update(content).digest("hex");
      results.push({
        absolutePath,
        relativePath,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        sha1
      });
    }
  }

  await visit(normalizedRoot);
  return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function buildDiffOperations(
  attachmentId: string,
  hostInventory: Record<string, FileFingerprint>,
  stageInventory: Record<string, FileFingerprint>,
  snapshotInventory: Record<string, FileFingerprint>
): DiffOperation[] {
  const operations: DiffOperation[] = [];
  const createOps: DiffOperation[] = [];
  const deleteOps: DiffOperation[] = [];

  const hostPaths = new Set(Object.keys(hostInventory));
  const stagePaths = new Set(Object.keys(stageInventory));

  for (const relativePath of new Set([...hostPaths, ...stagePaths])) {
    const host = hostInventory[relativePath];
    const stage = stageInventory[relativePath];
    const snapshot = snapshotInventory[relativePath];

    if (host && stage) {
      if (host.sha1 !== stage.sha1) {
        operations.push({
          id: randomUUID(),
          attachmentId,
          kind: "modify",
          relativePath,
          sourcePath: relativePath,
          targetPath: relativePath,
          size: stage.size,
          sha1: stage.sha1,
          stale: Boolean(snapshot && snapshot.sha1 !== host.sha1),
          reason:
            snapshot && snapshot.sha1 !== host.sha1
              ? "Host file changed after staging started."
              : undefined
        });
      }
      continue;
    }

    if (!host && stage) {
      createOps.push({
        id: randomUUID(),
        attachmentId,
        kind: "create",
        relativePath,
        targetPath: relativePath,
        size: stage.size,
        sha1: stage.sha1,
        stale: Boolean(snapshot),
        reason: snapshot
          ? "Host path existed at staging time but is now missing or changed."
          : undefined
      });
      continue;
    }

    if (host && !stage) {
      deleteOps.push({
        id: randomUUID(),
        attachmentId,
        kind: "delete",
        relativePath,
        sourcePath: relativePath,
        size: host.size,
        sha1: host.sha1,
        stale: Boolean(snapshot && snapshot.sha1 !== host.sha1),
        reason:
          snapshot && snapshot.sha1 !== host.sha1
            ? "Host file changed after staging started."
            : undefined
      });
    }
  }

  const pairedDeletes = new Set<string>();
  const pairedCreates = new Set<string>();
  for (const createOp of createOps) {
    const match = deleteOps.find(
      (candidate) =>
        !pairedDeletes.has(candidate.id) &&
        candidate.sha1 === createOp.sha1 &&
        candidate.size === createOp.size
    );
    if (!match) {
      continue;
    }

    pairedDeletes.add(match.id);
    pairedCreates.add(createOp.id);
    operations.push({
      id: randomUUID(),
      attachmentId,
      kind: "move",
      sourcePath: match.sourcePath,
      targetPath: createOp.targetPath,
      size: createOp.size,
      sha1: createOp.sha1,
      stale: createOp.stale || match.stale,
      reason: createOp.reason ?? match.reason
    });
  }

  operations.push(
    ...createOps.filter((operation) => !pairedCreates.has(operation.id)),
    ...deleteOps.filter((operation) => !pairedDeletes.has(operation.id))
  );

  return operations;
}

export function summarizeDiff(preview: DiffPreview): Record<DiffOperation["kind"], number> {
  return preview.operations.reduce<Record<DiffOperation["kind"], number>>(
    (summary, operation) => {
      summary[operation.kind] += 1;
      return summary;
    },
    {
      create: 0,
      modify: 0,
      delete: 0,
      move: 0
    }
  );
}

export function createPlaceholderArtifact(taskRunId: string, guestPath: string): ArtifactRecord {
  return {
    id: randomUUID(),
    taskRunId,
    guestPath,
    type: "other",
    status: "draft",
    createdAt: new Date().toISOString()
  };
}

function buildDeveloperInstructions(task: TaskSpec): string {
  const scopeSummary =
    task.attachments.length === 0
      ? "No host folders are attached to this task yet. Work only inside the isolated scratch workspace until the user grants folder access."
      : `The task currently includes ${task.attachments.length} scoped folder attachment${task.attachments.length === 1 ? "" : "s"}, each staged under the local attachments directory. Reference folders are readable copies, while editable and output folders are writable staged copies.`;
  const browserSummary = task.browserEnabled
    ? "Browser automation is enabled for this task."
    : "Browser automation is disabled for this task.";

  return [
    "You are Stuart, a local task assistant built on Codex.",
    "Work from the approved local workspace, stay concise, and keep outputs directly useful.",
    "When local retrieved context is supplied, use it first and cite relative workspace paths in your answer when helpful.",
    "Use `.stuart/workspace-map.json` to understand the staged workspace layout and attachment mapping before touching files.",
    "Use `.stuart/workspace-memory.md` as the durable task memory file for important discovered facts, plans, and handoff notes when the task spans multiple turns.",
    "Read and write files only inside the staged workspace. Editable and output changes stay staged until the host apply step reviews them.",
    scopeSummary,
    browserSummary
  ].join(" ");
}

function buildPerformanceContext(db: LocalDatabase, task: TaskSpec): string {
  try {
    const summary = db.getProjectLearningSummary(task.projectId);
    const weakTopics = db.listWeakTopics(task.projectId, 8);

    const lines: string[] = [
      "## Student Performance Context",
      `Overall accuracy: ${(summary.overallAccuracy * 100).toFixed(0)}% across ${summary.totalReviews} reviews`,
      `Study streak: ${summary.streakDays} day(s) | Cards due: ${summary.cardsDue}`,
    ];

    if (weakTopics.length > 0) {
      lines.push("", "### Weak topics (lowest accuracy first):");
      for (const t of weakTopics) {
        const acc = t.totalAttempts > 0 ? ((t.correctCount / t.totalAttempts) * 100).toFixed(0) : "0";
        lines.push(`- **${t.topic}**: ${acc}% (${t.correctCount}/${t.totalAttempts})`);
      }
      lines.push("", "Focus generated content on these weak areas. Prioritise the lowest-accuracy topics.");
    }

    return lines.join("\n");
  } catch {
    return "";
  }
}

function buildPerformanceSnapshot(db: LocalDatabase, task: TaskSpec): string {
  try {
    const summary = db.getProjectLearningSummary(task.projectId);
    if (summary.totalReviews === 0) return "";

    const acc = (summary.overallAccuracy * 100).toFixed(0);
    const weakNames = summary.weakTopics.slice(0, 3).map((t) => t.topic).join(", ");
    const lines = [
      `\n\n## Student snapshot`,
      `Accuracy: ${acc}% | Reviews: ${summary.totalReviews} | Streak: ${summary.streakDays}d | Due: ${summary.cardsDue}`,
    ];
    if (weakNames) lines.push(`Weak areas: ${weakNames}`);
    return lines.join("\n");
  } catch {
    return "";
  }
}

function buildTeachingInstructions(project: ProjectRecord, task: TaskSpec, db?: LocalDatabase): string {
  // Load cross-session memory if it exists
  const memoryPath = join(project.rootPath, ".stuart-memory.md");
  let memoryContext = "";
  try {
    if (existsSync(memoryPath)) {
      const content = require("node:fs").readFileSync(memoryPath, "utf8") as string;
      if (content.trim()) {
        memoryContext = `\n\n## Cross-session memory\nThe following notes were saved from previous study sessions with this student. Use them to personalise your teaching.\n\n${content.trim()}`;
      }
    }
  } catch { /* ignore */ }

  // Lightweight performance snapshot
  const perfSnapshot = db ? buildPerformanceSnapshot(db, task) : "";

  return `You are Stuart, an interactive study tutor inside a local workspace.

## Core behaviour
- Teach from the workspace evidence. Stay grounded in indexed material.
- If the evidence does not cover the question, say so honestly.
- Cite sources by name. Prefer lecture slides, chapters, notes, and study guides over code/config files.
- Synthesize concepts clearly — don't dump raw excerpts. Use markdown with headings and bullets.
- When the student references a specific chapter/lecture/week number, search for matching filenames first (e.g. "Lecture 01", "Chapter 1") before exploring broadly.

## Web research
You have web search enabled. Use it when:
- The student asks about something not covered in their local materials.
- The student explicitly asks you to research a topic online.
- You need additional context, definitions, or current information to give a better answer.
- The student asks for comparisons with external resources.
Always clearly indicate when information comes from the web vs. their local study materials.

## Cross-session memory
You can remember things across study sessions by writing to the file \`.stuart-memory.md\` in the project root.
- When the student tells you about their learning preferences, exam dates, weak areas, or study goals, save a brief note to this file.
- When the student says "remember this" or similar, write it to the memory file.
- Keep the file concise and organized — use headings and bullet points.
- Read this file at the start of each session to recall the student's context.

## Capabilities
You can generate study artifacts (flashcards, quizzes, mind maps, diagrams, mock exams, interactive apps, PDF/DOCX/XLSX/PPTX documents). When asked to create one, you will receive detailed formatting instructions in the context. Always output artifacts as a single JSON code block with a "kind" and "title" field.

You can also research new topics, fetch content from URLs and repos, and build structured curricula with saved source files — detailed instructions will be provided when the student asks for this.${memoryContext}${perfSnapshot}`;
}

function buildWorkerDeveloperInstructions(task: TaskSpec, worker: TaskWorkerRecord): string {
  return [
    buildDeveloperInstructions(task),
    `You are the ${worker.role} worker for this task.`,
    "Focus only on the assigned subtask and return a concise completion summary when done.",
    "Prefer leaving concrete files or edits in the staged workspace over long narrative updates when the task calls for outputs.",
    "Do not re-plan the whole task. Execute the assigned slice, summarize the result, and stop."
  ].join(" ");
}

function buildWorkerPrompt(task: TaskSpec, worker: TaskWorkerRecord): string {
  return [
    `Parent task: ${task.title}`,
    `Parent objective: ${task.objective}`,
    `Worker role: ${worker.role}`,
    `Assigned subtask: ${worker.objective}`,
    "Use the current staged workspace and any supplied retrieved context.",
    "When you finish, provide a concise summary of what you found, changed, or created."
  ].join("\n\n");
}

function buildWorkerThinkingLabel(worker: TaskWorkerRecord): string {
  return `Working on the ${worker.role} subtask`;
}

function inferThinkingLabel(task: TaskSpec, message: string): string {
  if (/pdf|docx|report|memo|summary|study/i.test(message)) {
    return "Planning the deliverable";
  }
  if (/folder|file|scope|attach|editable|reference|output/i.test(message)) {
    return "Checking workspace scope";
  }
  if (task.browserEnabled && /browse|browser|website|search|chrome|page/i.test(message)) {
    return "Reviewing the task and browser context";
  }
  return "Thinking through the request";
}

function formatWorkerLabel(role: string): string {
  return role
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function summarizeActivityForStudent(detail: string): string {
  // Convert technical runtime messages into student-friendly labels
  if (/web.*search|searching.*web/i.test(detail)) return "Searching the web...";
  if (/running command/i.test(detail)) {
    if (/\brg\b|grep|search/i.test(detail)) return "Searching through your materials...";
    if (/\bcat\b|\bsed\b|\bhead\b|\btail\b/i.test(detail)) return "Reading a source file...";
    if (/\bls\b|\bfind\b/i.test(detail)) return "Browsing your study folder...";
    return "Analyzing your materials...";
  }
  if (/command finished/i.test(detail)) return "Processing results...";
  if (/reading|opening/i.test(detail)) return "Reading source content...";
  if (/writing|creating/i.test(detail)) return "Preparing your answer...";
  if (/stuart-memory/i.test(detail)) return "Updating study memory...";
  // Truncate and clean
  const cleaned = detail.replace(/`[^`]+`/g, "").replace(/\s+/g, " ").trim();
  return cleaned.length > 60 ? cleaned.slice(0, 57) + "..." : cleaned || "Working...";
}

function extractTargetedFiles(message: string): string[] {
  const targets: string[] = [];
  // Match patterns like "chapter 1", "lecture 03", "week 5", "topic 2", "unit 4", "module 3"
  const patterns = [
    /\b(?:chapter|chap|ch)\s*(\d+)/gi,
    /\b(?:lecture|lec)\s*(\d+)/gi,
    /\b(?:week|wk)\s*(\d+)/gi,
    /\b(?:topic)\s*(\d+)/gi,
    /\b(?:unit)\s*(\d+)/gi,
    /\b(?:module|mod)\s*(\d+)/gi,
    /\b(?:slide|slides)\s*(\d+)/gi,
    /\b(?:session)\s*(\d+)/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(message)) !== null) {
      const num = match[1]!;
      const paddedNum = num.padStart(2, "0");
      const keyword = match[0]!.split(/\s/)[0]!.toLowerCase();
      // Generate multiple search variants
      targets.push(`${keyword} ${num}`);
      targets.push(`${keyword} ${paddedNum}`);
      targets.push(`${keyword}${num}`);
      targets.push(`${keyword}${paddedNum}`);
      // Also match just the number in context
      targets.push(`${paddedNum}`);
    }
  }

  return targets;
}

export function sanitizeRetrievalQuery(message: string): string {
  return message
    .replace(/\b(create|generate|make|give me|can you|please|build|produce)\b/gi, "")
    .replace(/\b\d+\s*(flashcards?|cards?|questions?|quizzes?|quiz)\b/gi, "")
    .replace(/\b(flashcards?|flash\s*cards?|cloze|anki|quiz|quizzes?|mind\s*map|mindmap|diagram|mock\s*exam|test me)\b/gi, "")
    .replace(/\b(basic|advanced|simple|comprehensive|detailed|short|quick)\b/gi, "")
    .replace(/\b(a|an|on|about|for|from|based on|regarding|covering)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function cleanSourceName(path: string): string {
  // Strip "attachments/UUID-prefix/" patterns from staged workspace paths
  const cleaned = path.replace(/^attachments\/[a-f0-9-]+-/i, '');
  // Return just the filename if it's deeply nested
  const parts = cleaned.split('/');
  return parts[parts.length - 1] || cleaned;
}

function assessPermissionGap(_task: TaskSpec, _message: string): PermissionGap | null {
  // Auto-approve everything for student users — no permission prompts.
  return null;
}

function shouldUseLocalRetrieval(task: TaskSpec, message: string): boolean {
  if (task.attachments.length === 0) {
    return false;
  }

  const scope = `${task.objective} ${message}`.toLowerCase();
  return /\b(read|open|scan|search|find|summari[sz]e|review|inspect|analy[sz]e|compare|extract|cite|from the files|from the docs|workspace|directory|folder|document|documents|packet|pdf|docx|xlsx|pptx|slides|notes|study|report|memo|brief|question|answer)\b/i.test(
    scope
  );
}

async function collectWorkspaceFilesFromRoot(
  taskId: string,
  taskRunId: string | undefined,
  rootPath: string,
  metadata: {
    sourceLabel: string;
    sourceKind: "project" | "attachment" | "staging";
    attachmentMode?: AttachmentMode;
  }
): Promise<ResolvedWorkspaceFile[]> {
  if (!existsSync(rootPath)) {
    return [];
  }

  const normalizedRoot = resolve(rootPath);
  const entries: ResolvedWorkspaceFile[] = [];

  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const absolutePath = join(directory, child.name);
      const relativePath = relative(normalizedRoot, absolutePath);

      if (child.isDirectory()) {
        if (shouldHideWorkspacePath(relativePath)) {
          continue;
        }
        await visit(absolutePath);
        continue;
      }
      if (!child.isFile()) {
        continue;
      }

      const fileStat = await stat(absolutePath);
      if (shouldHideWorkspacePath(relativePath)) {
        continue;
      }
      entries.push({
        id: createHash("sha1")
          .update(`${taskId}:${taskRunId ?? "no-run"}:${absolutePath}`)
          .digest("hex"),
        taskId,
        taskRunId,
        absolutePath,
        rootPath: normalizedRoot,
        name: basename(absolutePath),
        relativePath,
        sourceLabel: metadata.sourceLabel,
        sourceKind: metadata.sourceKind,
        attachmentMode: metadata.attachmentMode,
        size: fileStat.size,
        modifiedAt: new Date(fileStat.mtimeMs).toISOString(),
        previewKind: inferPreviewKind(absolutePath)
      });
    }
  }

  await visit(normalizedRoot);
  return entries;
}

export function shouldHideWorkspacePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized === ".") {
    return false;
  }

  const segments = normalized
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());

  const ignoredSegments = new Set([
    ".git",
    ".svn",
    ".hg",
    ".stuart",
    ".codex-cowork",
    ".codex-stuart",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    ".parcel-cache",
    ".venv",
    "venv",
    "env",
    "node_modules",
    "site-packages",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    "dist",
    "build",
    "coverage",
    ".idea",
    ".vscode",
  ]);

  return (
    normalized === "manifest.json" ||
    normalized === ".ds_store" ||
    segments.some((segment) => segment === ".ds_store" || segment.startsWith("._")) ||
    segments.some((segment) => ignoredSegments.has(segment))
  );
}

function normalizeWorkspaceReference(value: string): string {
  return decodeURIComponent(value.trim())
    .replace(/^file:\/\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\\/g, "/");
}

function stripRelativePrefix(value: string): string {
  return value.replace(/^\.?\//, "");
}

function inferPreviewKind(filePath: string): PreviewKind {
  switch (extname(filePath).toLowerCase()) {
    case ".pdf":
      return "pdf";
    case ".docx":
      return "docx";
    case ".xlsx":
    case ".xls":
      return "xlsx";
    case ".html":
    case ".htm":
      return "html";
    case ".jsx":
    case ".tsx":
      return "jsx";
    case ".md":
    case ".txt":
    case ".json":
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".ts":
    case ".css":
    case ".xml":
    case ".yml":
    case ".yaml":
    case ".csv":
      return "text";
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif":
    case ".webp":
    case ".svg":
      return "image";
    default:
      return "unsupported";
  }
}

function describeRuntimeItem(
  item: Record<string, unknown> & { type: string },
  phase: "started" | "completed"
): string | null {
  const normalizedType = item.type.toLowerCase();
  if (
    normalizedType === "agentmessage" ||
    normalizedType.includes("reasoning") ||
    normalizedType.includes("plan")
  ) {
    return null;
  }

  if (
    normalizedType.includes("subagent") ||
    normalizedType.includes("worker") ||
    (normalizedType.includes("agent") && normalizedType !== "agentmessage")
  ) {
    return phase === "started"
      ? "Spawning a focused agent to handle part of this task."
      : "A focused agent finished its part of the task.";
  }

  if (normalizedType.includes("command")) {
    const command = readFirstString(item, ["command", "cmd", "title", "description"]);
    return phase === "started"
      ? command
        ? `Running command in the staged workspace: \`${truncateForLog(command, 120)}\``
        : "Running a command in the staged workspace."
      : command
        ? `Command finished: \`${truncateForLog(command, 120)}\``
        : "Command finished inside the staged workspace.";
  }

  if (normalizedType.includes("tool")) {
    const toolName = readFirstString(item, ["toolName", "name", "title"]);
    return phase === "started"
      ? toolName
        ? `Using tool \`${truncateForLog(toolName, 80)}\` to work on the task.`
        : "Using a tool to work on the task."
      : toolName
        ? `Finished tool call: \`${truncateForLog(toolName, 80)}\``
        : "Finished a tool call.";
  }

  if (normalizedType.includes("mcp")) {
    const toolName = readFirstString(item, ["serverName", "toolName", "name"]);
    return phase === "started"
      ? toolName
        ? `Calling connector \`${truncateForLog(toolName, 80)}\`.`
        : "Calling a connector."
      : toolName
        ? `Connector call finished: \`${truncateForLog(toolName, 80)}\``
        : "Connector call finished.";
  }

  if (normalizedType.includes("file")) {
    return phase === "started"
      ? "Reviewing staged file updates inside the workspace."
      : "Recorded staged file updates for later review.";
  }

  return phase === "started"
    ? `Working on ${humanizeRuntimeType(item.type)}.`
    : null;
}

function humanizeRuntimeType(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .toLowerCase();
}

function readFirstString(
  value: Record<string, unknown> | undefined,
  keys: string[]
): string | null {
  if (!value) {
    return null;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function buildCodexAgentEvent(
  item: Record<string, unknown> & { type: string; id?: string },
  phase: "started" | "completed"
): {
  agentId: string;
  status: "running" | "completed" | "failed";
  label: string;
  detail?: string;
} | null {
  const normalizedType = item.type.toLowerCase();
  if (
    !normalizedType.includes("subagent") &&
    !normalizedType.includes("worker") &&
    !(normalizedType.includes("agent") && normalizedType !== "agentmessage")
  ) {
    return null;
  }

  const label = humanizeAgentLabel(
    readFirstString(item, ["label", "role", "name", "title", "description"]) ??
      inferAgentLabelFromType(normalizedType)
  );

  return {
    agentId: typeof item.id === "string" && item.id.trim() ? item.id : randomUUID(),
    status: phase === "started" ? "running" : "completed",
    label: label || "Focused helper",
    detail:
      phase === "completed"
        ? readFirstString(item, ["summary", "result", "status", "description"]) ?? undefined
        : undefined
  };
}

function inferAgentLabelFromType(type: string): string {
  if (type.includes("browser")) {
    return "Browser helper";
  }
  if (type.includes("research")) {
    return "Research helper";
  }
  if (type.includes("review")) {
    return "Review helper";
  }
  if (type.includes("write") || type.includes("document")) {
    return "Writing helper";
  }
  return "Focused helper";
}

function humanizeAgentLabel(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function truncateForLog(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 3).trimEnd()}...` : value;
}

function summarizeThinkingDelta(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "Thinking through the request";
  }
  return compact.length > 140 ? `${compact.slice(0, 137).trimEnd()}...` : compact;
}

const ARTIFACT_PATTERN = /\b(flashcards?|quiz|mind\s*map|mindmap|diagram|mock[\s_-]*exam|interactive)\b/i;

function tryParseArtifactJson(
  text: string
): { kind: string; title: string; data: unknown } | null {
  // Try to extract a JSON block from the assistant response
  const jsonBlockMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  let candidate = jsonBlockMatch ? jsonBlockMatch[1]! : text.trim();

  // If the text starts with { try to find the JSON object directly
  if (!jsonBlockMatch && candidate.includes("{")) {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidate = candidate.slice(firstBrace, lastBrace + 1);
    }
  }

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;

    // Normalize the kind field — Codex may use various names
    let rawKind =
      typeof parsed.kind === "string"
        ? parsed.kind
        : typeof parsed.type === "string"
          ? parsed.type
          : typeof parsed.artifactType === "string"
            ? parsed.artifactType
            : null;

    if (!rawKind) return null;

    // Normalize variations: mind_map → mindmap, flash_cards → flashcards, etc.
    const kindMap: Record<string, string> = {
      mind_map: "mindmap",
      mindmap: "mindmap",
      "mind map": "mindmap",
      flashcard: "flashcards",
      flashcards: "flashcards",
      flash_cards: "flashcards",
      quiz: "quiz",
      quizzes: "quiz",
      diagram: "diagram",
      diagrams: "diagram",
      custom: "custom",
      mock_exam: "mock_exam",
      "mock exam": "mock_exam",
      mockexam: "mock_exam",
      "mock-exam": "mock_exam",
      interactive: "interactive",
      "interactive app": "interactive",
      "interactive artifact": "interactive",
      document_docx: "document_docx",
      docx: "document_docx",
      "word document": "document_docx",
      "study guide": "document_docx",
      document_xlsx: "document_xlsx",
      xlsx: "document_xlsx",
      spreadsheet: "document_xlsx",
      document_pptx: "document_pptx",
      pptx: "document_pptx",
      presentation: "document_pptx",
      document_pdf: "document_pdf",
      pdf_document: "document_pdf",
    };

    const kind = kindMap[rawKind.toLowerCase()] ?? null;
    if (!kind) return null;

    const title =
      typeof parsed.title === "string" && parsed.title.trim()
        ? parsed.title.trim()
        : typeof parsed.topic === "string" && parsed.topic.trim()
          ? parsed.topic.trim()
          : typeof parsed.name === "string" && parsed.name.trim()
            ? parsed.name.trim()
            : `Untitled ${kind}`;

    // Normalize the data structure — wrap in the expected format if needed
    const normalized: Record<string, unknown> = { ...parsed, kind, title };

    // If Codex used "root" instead of "nodes" for mindmap
    if (kind === "mindmap" && !normalized.nodes && parsed.root) {
      normalized.nodes = [parsed.root];
    }

    return { kind, title, data: normalized };
  } catch {
    return null;
  }
}

/**
 * Try to extract a sandboxed script from the assistant response.
 * Looks for Python or JS code blocks with a `# stuart-output: filename.ext`
 * (Python) or `// stuart-output: filename.ext` (JS) header comment.
 */
function tryExtractScript(
  text: string
): { language: "python" | "javascript"; script: string; outputFilename: string; title: string } | null {
  // Match a fenced code block (python/py or javascript/js/node)
  const codeBlockPattern = /```(?:python|py|javascript|js|node)\s*\n([\s\S]*?)\n```/;
  const blockMatch = text.match(codeBlockPattern);
  if (!blockMatch) return null;

  const script = blockMatch[1]!.trim();
  if (!script) return null;

  // Detect language from the fence info string
  const fenceInfo = text.match(/```(python|py|javascript|js|node)\s*\n/)?.[1] ?? "";
  const language: "python" | "javascript" =
    fenceInfo === "javascript" || fenceInfo === "js" || fenceInfo === "node"
      ? "javascript"
      : "python";

  // Extract the stuart-output directive from the first line
  const firstLine = script.split("\n")[0] ?? "";
  const pythonDirective = firstLine.match(/^#\s*stuart-output:\s*(.+)/);
  const jsDirective = firstLine.match(/^\/\/\s*stuart-output:\s*(.+)/);
  const directive = pythonDirective ?? jsDirective;
  if (!directive) return null;

  const outputFilename = directive[1]!.trim();
  if (!outputFilename) return null;

  // Derive a title from the filename
  const title = outputFilename
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return { language, script, outputFilename, title };
}

function filterCodexStderr(chunk: string): string {
  const filtered = chunk
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.trim()) {
        return false;
      }

      return !line.includes("codex_core::skills::loader: failed to stat skills entry");
    })
    .join("\n")
    .trim();

  return filtered ? `${filtered}\n` : "";
}
