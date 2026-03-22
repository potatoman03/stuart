import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
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
import { fileURLToPath } from "node:url";
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
  type ParsedIngestionDocument
} from "./ingestion.js";
import { renderDocument } from "./document-renderer.js";
import { matchSkills, type Skill } from "./skills.js";
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

interface SendTaskMessageOptions {
  retryCount?: number;
  imageBase64?: string;
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
  startedAt?: string;
  lastActivityAt: number;
  stallTimeoutMs?: number;
  kind: "task" | "worker";
  workerId?: string;
  assistantItemId?: string;
  assistantText: string;
  thinkingLabel: string;
  startedEmitted: boolean;
  retryCount?: number;
  /** The working directory for this turn (staging path) */
  cwd?: string;
  /** Whether this turn should trigger workspace re-indexing on completion */
  triggersReindex?: boolean;
  /** The user's original message for this turn (used for memory extraction) */
  userMessage?: string;
  /** Whether this is a memory extraction turn (ephemeral, parse result as memories) */
  memoryExtraction?: boolean;
  /** Quiz validation context — if set, this turn is checking quiz accuracy */
  quizValidation?: { artifactId: string; originalPayload: string };
  /** If set, resolves a quickComplete promise when the turn finishes */
  quickCompleteResolve?: (text: string) => void;
}

interface ResolvedWorkspaceFile extends WorkspaceFileRecord {
  absolutePath: string;
  rootPath: string;
}

const ingestionConcurrency = Math.max(
  1,
  Math.min(4, Number(process.env.STUART_INGESTION_CONCURRENCY ?? 2) || 2)
);
const defaultTurnStallMs = Math.max(30_000, Number(process.env.STUART_TURN_STALL_MS ?? 120_000) || 120_000);
const complexTurnStallMs = Math.max(defaultTurnStallMs, Number(process.env.STUART_COMPLEX_TURN_STALL_MS ?? 300_000) || 300_000);

function resolveIngestionWorkerConfig() {
  const jsUrl = new URL("./ingestion-worker.js", import.meta.url);
  if (existsSync(fileURLToPath(jsUrl))) {
    return {
      url: jsUrl,
      execArgv: undefined as string[] | undefined,
    };
  }

  return {
    url: new URL("./ingestion-worker.ts", import.meta.url),
    execArgv: ["--import", "tsx"],
  };
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
  private readonly ingestionBuilds = new Map<string, Promise<IngestionIndexStats>>();
  private readonly codex: CodexAppServerClient;
  private readonly vmHelperBinaryPath?: string;
  private diagnosticsCache?: { expiresAt: number; value: SystemDiagnostics };
  private turnWatchdog?: ReturnType<typeof setInterval>;

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

    // Start turn watchdog — detects stalled turns and reconnects
    this.turnWatchdog = setInterval(() => {
      void this.checkStaleTurns();
    }, 15_000);
    this.turnWatchdog.unref();
  }

  /**
   * Check for stalled turns and reconnect if needed.
   * A turn is stale if it has not received any per-turn activity for too long.
   * This is tracked per turn rather than globally because the Codex app-server
   * may still be active for other tasks while one turn is silently hung.
   */
  private async checkStaleTurns(): Promise<void> {
    if (this.turns.size === 0) return;
    if (!this.codex.isConnected) return;

    // Only check task turns, not workers or memory extraction
    const taskTurns = [...this.turns.values()].filter(
      (t) => t.kind === "task" && !t.memoryExtraction
    );
    if (taskTurns.length === 0) return;

    const now = Date.now();
    const staleTurns = taskTurns.filter((turn) => {
      const lastActivityAt = turn.lastActivityAt || (turn.startedAt ? new Date(turn.startedAt).getTime() : now);
      const stallTimeoutMs = turn.stallTimeoutMs ?? defaultTurnStallMs;
      return now - lastActivityAt >= stallTimeoutMs;
    });
    if (staleTurns.length === 0) return;

    // Only reconnect if every active task turn is stale. This avoids killing
    // healthy turns just because one task is lagging.
    if (staleTurns.length !== taskTurns.length) {
      return;
    }

    const staleSecs = Math.floor(
      Math.max(...staleTurns.map((turn) => now - (turn.lastActivityAt || now))) / 1000
    );

    process.stderr.write(
      `[stuart] detected ${staleTurns.length} stale task turn(s) (oldest idle ${staleSecs}s, codex connection idle ${this.codex.idleSeconds}s). Reconnecting...\n`
    );

    // Collect stalled turns for retry
    const retryQueue: Array<{ taskId: string; message: string; retryCount: number }> = [];

    for (const state of staleTurns) {
      this.recordRuntimeMessage(
        state.taskId,
        `Stuart stalled after ${Math.max(1, Math.floor((now - state.lastActivityAt) / 1000))}s without progress. Reconnecting and retrying automatically...`
      );
      this.emitEvent({
        type: "codex.turn.completed",
        taskId: state.taskId,
        threadId: state.threadId,
        turnId: state.turnId,
        status: "failed",
        error: "Turn timed out — connection stalled."
      });
      if (state.userMessage && (state.retryCount ?? 0) < 1) {
        retryQueue.push({
          taskId: state.taskId,
          message: state.userMessage,
          retryCount: (state.retryCount ?? 0) + 1
        });
      } else if (state.userMessage) {
        this.recordRuntimeMessage(
          state.taskId,
          "Automatic retry was already attempted for this turn. Please resend your message if you still want this artifact."
        );
      }
    }

    // Clear all in-flight turns
    this.turns.clear();
    this.loadedThreadIds.clear();

    // Reconnect
    try {
      await this.codex.reconnect();
    } catch (err) {
      process.stderr.write(`[stuart] reconnect failed: ${String(err)}\n`);
      return;
    }

    // Auto-retry the stalled messages (one at a time)
    for (const retry of retryQueue) {
      try {
        this.recordRuntimeMessage(retry.taskId, "Retrying your last message...");
        this.emitEvent({
          type: "task.message",
          taskId: retry.taskId
        });
        await this.sendTaskMessage(retry.taskId, retry.message, {
          retryCount: retry.retryCount
        });
      } catch (retryErr) {
        this.recordRuntimeMessage(
          retry.taskId,
          `Retry failed: ${String(retryErr)}. Please resend your message manually.`
        );
      }
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
      surface: process.env.STUART_RUNTIME_MODE === "desktop" || process.env.STUART_RUNTIME_MODE === "standalone" ? "desktop" : "developer",
      managedCodex: process.env.STUART_DESKTOP_MANAGED_CODEX === "1",
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
      startedAt: new Date().toISOString(),
      lastActivityAt: Date.now(),
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
   * Extract student memories from a completed turn.
   * Runs a cheap ephemeral Codex thread to identify preferences, facts, goals, and progress.
   * Fire-and-forget — errors are silently ignored.
   */
  private async extractStudentMemories(
    taskId: string,
    userMessage: string,
    assistantText: string
  ): Promise<void> {
    // Gate: skip trivial messages
    if (userMessage.length < 15 && !userMessage.includes("?")) return;
    if (/^(yes|ok|okay|sure|thanks|thank you|got it|continue|go ahead|next|yep|yeah|no|nah)\.?$/i.test(userMessage.trim())) return;

    const task = this.db.getTask(taskId);
    if (!task) return;

    const today = new Date().toISOString().split("T")[0];
    const extractionPrompt = `Extract new facts about this student from their message. Only extract what the student explicitly stated or confirmed. Do not infer or guess. Return ONLY a JSON code block with an array (or [] if nothing new).

Each item: { "scope_type": "global"|"project", "category": "preference"|"fact"|"goal"|"progress"|"context", "topic": "short label", "memory_key": "unique-key-for-contradictions", "content": "the memory", "event_date": "YYYY-MM-DD or null", "expires_at": "YYYY-MM-DD or null" }

Rules:
- "prefers X" or "I like X" → global preference
- "I'm studying X", "my exam is on X" → project goal/context
- "I understand X now" → project progress
- Today is ${today}. Convert relative dates to absolute.
- Do NOT store assistant guesses or inferences.

Student message: ${userMessage}

Assistant response (for confirmation detection only): ${assistantText.slice(0, 500)}`;

    try {
      // Start an ephemeral thread for extraction (separate from teaching thread)
      const thread = await this.codex.request<{ thread: { id: string } }>("thread/start", {
        cwd: this.dataDir,
        approvalPolicy: "never",
        model: "gpt-5.4-mini",
        personality: "pragmatic",
        ephemeral: true,
      });

      const extractionThreadId = thread.thread.id;

      // Track the turn so the completion handler can parse the result
      const turn = await this.codex.request<{ turn: { id: string } }>("turn/start", {
        threadId: extractionThreadId,
        cwd: this.dataDir,
        approvalPolicy: "never",
        effort: "low",
        input: [{ type: "text" as const, text: extractionPrompt, text_elements: [] }]
      });

      // Store metadata so the turn/completed handler can process the extraction
      this.turns.set(turn.turn.id, {
        taskId,
        threadId: extractionThreadId,
        turnId: turn.turn.id,
        startedAt: new Date().toISOString(),
        lastActivityAt: Date.now(),
        kind: "worker" as const,
        assistantText: "",
        thinkingLabel: "Extracting memories",
        startedEmitted: false,
        memoryExtraction: true,
      });
    } catch {
      // Extraction is best-effort — never block the main flow
    }
  }

  /**
   * Run a quick ephemeral Codex completion and return the result text.
   * Uses gpt-5.4-mini at low effort for fast inline results (slash commands, etc.).
   * Times out after 15 seconds and returns the fallback.
   */
  async quickComplete(prompt: string, fallback: string = ""): Promise<string> {
    try {
      await this.codex.ensureReady();
      const thread = await this.codex.request<{ thread: { id: string } }>("thread/start", {
        cwd: this.dataDir,
        approvalPolicy: "never",
        model: "gpt-5.4-mini",
        personality: "pragmatic",
        ephemeral: true,
      });

      const turn = await this.codex.request<{ turn: { id: string } }>("turn/start", {
        threadId: thread.thread.id,
        cwd: this.dataDir,
        approvalPolicy: "never",
        effort: "low",
        input: [{ type: "text" as const, text: prompt, text_elements: [] }],
      });

      // Wait for the turn to complete via a promise
      const result = await new Promise<string>((resolve) => {
        const timeout = setTimeout(() => resolve(fallback), 15_000);
        this.turns.set(turn.turn.id, {
          taskId: "",
          threadId: thread.thread.id,
          turnId: turn.turn.id,
          lastActivityAt: Date.now(),
          kind: "worker",
          assistantText: "",
          thinkingLabel: "",
          startedEmitted: false,
          memoryExtraction: true, // prevents storing as chat message
          quickCompleteResolve: (text: string) => {
            clearTimeout(timeout);
            resolve(text);
          },
        });
      });

      return result.trim() || fallback;
    } catch {
      return fallback;
    }
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

  async sendTaskMessage(
    taskId: string,
    content: string,
    options: SendTaskMessageOptions = {}
  ): Promise<SendTaskMessageResult> {
    const task = this.db.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found.`);
    }

    // Check if a turn is already in-flight for this task
    const activeTurn = [...this.turns.values()].find(
      (t) => t.taskId === taskId && t.kind === "task" && !t.memoryExtraction
    );
    if (activeTurn) {
      throw new Error("A turn is already in progress for this task. Please wait for it to complete.");
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
    const skills = matchSkills(trimmed, this.sandboxAvailable);
    if (skills.length > 0) {
      this.recordRuntimeMessage(task.id, `Loaded skill${skills.length === 1 ? "" : "s"}: ${skills.map((skill) => skill.id).join(", ")}`);
    }

    // Determine model + effort per turn based on what's needed.
    // Sandbox scripts (Python/JS doc gen) → flagship gpt-5.4 + high effort.
    // Research, interactive, artifacts → gpt-5.4-mini at high effort.
    // Everything else → gpt-5.4-mini (set on thread) with dynamic effort.
    const needsFlagship = skills.some((skill) =>
      skill.requiresSandbox
    );
    const isResearch = skills.some((skill) => skill.id === "research");
    const isCodeGen = skills.some((skill) => skill.id === "interactive");
    const isArtifactTurn = skills.some((skill) => skill.id !== "research");
    const isSimpleQuery = /^explain|^what is|^define|^describe|^tell me about/i.test(trimmed) && trimmed.length < 200;
    const turnModel = needsFlagship ? "gpt-5.4" : undefined; // undefined = use thread default (mini)
    const effort = needsFlagship ? "high"
      : (isResearch || isCodeGen) ? "high"
      : isSimpleQuery ? "low"
      : isLargeMaterialSet && !targetedFiles.length ? "high"
      : "medium";
    const stallTimeoutMs =
      isResearch || isArtifactTurn || isLargeMaterialSet
        ? complexTurnStallMs
        : defaultTurnStallMs;

    // Detect weak-topic intent and inject performance context
    const isWeakTopicRequest = /\bweak\s*(topic|area)s?\b|\bstruggl|\bfocus.*weak|\bworst\b/i.test(trimmed);
    let performanceContext = "";
    if (isWeakTopicRequest) {
      performanceContext = buildPerformanceContext(this.db, task);
    }

    const artifactTurnContract = buildArtifactTurnContract(skills);

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
      ...((skills.length > 0)
        ? skills.map((skill) => ({
            type: "text" as const,
            text: skill.prompt,
            text_elements: []
          }))
        : []),
      ...(artifactTurnContract
        ? [
            {
              type: "text" as const,
              text: artifactTurnContract,
              text_elements: []
            }
          ]
        : []),
      {
        type: "text" as const,
        text: trimmed,
        text_elements: []
      },
      // Include image as multimodal input if provided
      ...(options.imageBase64
        ? [
            {
              type: "image" as const,
              url: options.imageBase64,
            }
          ]
        : [])
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
    if (isLargeMaterialSet && !targetedFiles.length && !isSimpleQuery && !isResearch) {
      void this.spawnExploreWorkers(task, context, trimmed).catch(() => {
        // Non-critical — the main turn will still work
      });
    }

    // For research tasks, spawn research workers to fetch content in parallel
    if (isResearch) {
      void this.spawnResearchWorkers(task, context, trimmed).catch(() => {
        // Non-critical — the main turn will still handle research
      });
    }

    this.turns.set(turn.turn.id, {
      taskId,
      threadId,
      turnId: turn.turn.id,
      startedAt: new Date().toISOString(),
      lastActivityAt: Date.now(),
      kind: "task",
      assistantText: "",
      thinkingLabel: inferThinkingLabel(task, trimmed),
      startedEmitted: true,
      stallTimeoutMs,
      cwd: context.cwd,
      triggersReindex: skills.some((skill) => skill.triggersReindex),
      userMessage: trimmed,
      retryCount: options.retryCount ?? 0,
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
    return this.runTaskIngestionIndex(taskId, options);
  }

  private getIngestionBuildKey(taskId: string, taskRunId?: string): string {
    return `${taskId}:${taskRunId ?? "global"}`;
  }

  private scheduleTaskIngestionIndex(
    task: TaskSpec,
    options?: {
      taskRunId?: string;
      force?: boolean;
      reason?: string;
    }
  ): void {
    const key = this.getIngestionBuildKey(task.id, options?.taskRunId);
    if (this.ingestionBuilds.has(key)) {
      return;
    }

    if (options?.reason) {
      this.recordRuntimeMessage(task.id, options.reason);
    }

    void this.runTaskIngestionIndex(task.id, options)
      .then((stats) => {
        if (stats.documentsIndexed > 0) {
          this.recordRuntimeMessage(
            task.id,
            `The local context index is ready with ${stats.documentsIndexed} document${stats.documentsIndexed === 1 ? "" : "s"} and ${stats.chunksIndexed} chunks.`
          );
        }
      })
      .catch((error) => {
        this.recordRuntimeMessage(
          task.id,
          `Background indexing hit a problem, so Stuart will keep working directly from the workspace files.\n\n${error instanceof Error ? error.message : String(error)}`
        );
      });
  }

  private async runTaskIngestionIndex(
    taskId: string,
    options?: {
      taskRunId?: string;
      force?: boolean;
    }
  ): Promise<IngestionIndexStats> {
    const key = this.getIngestionBuildKey(taskId, options?.taskRunId);
    const inFlight = this.ingestionBuilds.get(key);
    if (inFlight) {
      return inFlight;
    }

    const build = (async () => {
    const existing = this.db.getIngestionStats(taskId, options?.taskRunId);
    if (!options?.force && existing.documentsIndexed > 0) {
      return existing;
    }

    const files = (await this.collectWorkspaceFiles(taskId, options?.taskRunId, 5000)).filter(
      (entry) => isIngestiblePath(entry.absolutePath)
    );
    this.db.clearIngestionScope(taskId, options?.taskRunId);
    let nextFileIndex = 0;
    const processNextFile = async (): Promise<void> => {
      while (true) {
        const currentIndex = nextFileIndex;
        nextFileIndex += 1;
        if (currentIndex >= files.length) {
          return;
        }

        const file = files[currentIndex]!;
        const documentId = createHash("sha1")
          .update(`${taskId}:${options?.taskRunId ?? "global"}:${file.absolutePath}`)
          .digest("hex");
        const parsed = await this.parseDocumentForIngestionIsolated(file.absolutePath);
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
    };

    await Promise.all(
      Array.from({ length: Math.min(ingestionConcurrency, Math.max(1, files.length)) }, () =>
        processNextFile()
      )
    );

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
    })();

    this.ingestionBuilds.set(key, build);
    build.finally(() => {
      if (this.ingestionBuilds.get(key) === build) {
        this.ingestionBuilds.delete(key);
      }
    });
    return build;
  }

  private async parseDocumentForIngestionIsolated(filePath: string): Promise<ParsedIngestionDocument> {
    return new Promise((resolve, reject) => {
      const workerConfig = resolveIngestionWorkerConfig();
      const worker = new Worker(workerConfig.url, {
        ...(workerConfig.execArgv ? { execArgv: workerConfig.execArgv } : {}),
        workerData: { filePath },
      });

      const cleanup = () => {
        worker.removeAllListeners("message");
        worker.removeAllListeners("error");
        worker.removeAllListeners("exit");
      };

      worker.once("message", (payload: { ok: boolean; parsed?: ParsedIngestionDocument; error?: string }) => {
        cleanup();
        void worker.terminate().catch(() => undefined);
        if (payload.ok && payload.parsed) {
          resolve(payload.parsed);
          return;
        }
        reject(new Error(payload.error || `Failed to parse ${filePath}`));
      });

      worker.once("error", (error) => {
        cleanup();
        reject(error);
      });

      worker.once("exit", (code) => {
        cleanup();
        if (code !== 0) {
          reject(new Error(`Ingestion worker exited early with code ${code} while parsing ${filePath}`));
        }
      });
    });
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
      this.scheduleTaskIngestionIndex(task, {
        taskRunId: run.id,
        force: true,
        reason: "Stuart is warming the local context index in the background while your workspace opens."
      });
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

  /**
   * Validate a quiz artifact by running a checking agent.
   * Fixes incorrect answers, ambiguous questions, and MRQ completeness.
   * Updates the artifact in-place if corrections are needed.
   */
  private async validateQuizArtifact(artifactId: string, taskId: string): Promise<void> {
    const artifact = this.db.getStudyArtifact(artifactId);
    if (!artifact) return;

    let data: { questions?: Array<Record<string, unknown>> };
    try {
      data = JSON.parse(artifact.payload);
    } catch { return; }

    if (!data.questions || data.questions.length === 0) return;

    // Build a compact representation for the checker
    const questionsForReview = data.questions.map((q, i) => ({
      index: i,
      id: q.id,
      prompt: q.prompt,
      options: q.options,
      answer: q.answer,
    }));

    const checkPrompt = `You are a quiz quality checker. Review these quiz questions and identify any problems.

For each question, check:
1. Is the stated answer actually correct? If not, what should it be?
2. Is there ambiguity where multiple options could be correct (for MCQ)?
3. For MRQ (comma-separated answers), are all correct options included?
4. Is any question misleading or poorly worded?

Return a JSON array of corrections needed. If a question is fine, don't include it.
Return [] if all questions are correct.

Format:
[{ "index": 0, "issue": "description of the problem", "correctedAnswer": "Option B" }]

Questions to review:
${JSON.stringify(questionsForReview, null, 2)}`;

    try {
      const thread = await this.codex.request<{ thread: { id: string } }>("thread/start", {
        cwd: this.dataDir,
        approvalPolicy: "never",
        model: "gpt-5.4-mini",
        personality: "pragmatic",
        ephemeral: true,
      });

      const turn = await this.codex.request<{ turn: { id: string } }>("turn/start", {
        threadId: thread.thread.id,
        cwd: this.dataDir,
        approvalPolicy: "never",
        effort: "medium",
        input: [{ type: "text" as const, text: checkPrompt, text_elements: [] }]
      });

      // Track the validation turn
      this.turns.set(turn.turn.id, {
        taskId,
        threadId: thread.thread.id,
        turnId: turn.turn.id,
        startedAt: new Date().toISOString(),
        lastActivityAt: Date.now(),
        kind: "worker" as const,
        assistantText: "",
        thinkingLabel: "Checking quiz accuracy",
        startedEmitted: false,
        quizValidation: { artifactId, originalPayload: artifact.payload },
      });
    } catch {
      // Validation is best-effort
    }
  }

  /**
   * Spawn parallel research workers to fetch content from the web.
   * Each worker handles a specific research subtask (Tier 1 sources, repo analysis, etc.)
   * so the main thread can focus on synthesis and writing.
   */
  private async spawnResearchWorkers(
    task: TaskSpec,
    context: TaskExecutionContext,
    question: string
  ): Promise<void> {
    // Extract URLs from the student's message
    const urlPattern = /https?:\/\/[^\s)]+/gi;
    const urls = question.match(urlPattern) ?? [];
    const hasGithub = urls.some((u) => u.includes("github.com"));

    const workers: Array<{ role: string; objective: string }> = [];

    // Worker 1: Fetch Tier 1 educational sources
    workers.push({
      role: "researcher",
      objective: `Search the web for the best Tier 1 educational sources on: "${question}". Focus on university course materials (CS231N, fast.ai, MIT OCW), official documentation (PyTorch, TensorFlow), and authoritative textbooks (D2L, Deep Learning Book). For each good source found, use curl to fetch the full content and save it as a file in the research/ directory. Save at least 3-5 high-quality source files. Use \`wc -l\` to verify each file has substantial content (>100 lines).`,
    });

    // Worker 2: Fetch secondary sources and references
    workers.push({
      role: "researcher",
      objective: `Search the web for Tier 2 educational sources on: "${question}". Focus on well-known technical blogs (Andrej Karpathy, Lilian Weng, Jay Alammar, Sebastian Raschka, Distill.pub), conference tutorials, and interactive notebooks. For each good source, use curl to fetch content and save to research/ directory. Also compile a references.md with links to the best video lectures (with durations), interactive notebooks (Colab/Kaggle), and recommended textbooks.`,
    });

    // Worker 3: If a GitHub URL was provided, deep-dive the repo
    if (hasGithub) {
      const repoUrl = urls.find((u) => u.includes("github.com")) ?? "";
      workers.push({
        role: "researcher",
        objective: `Clone and analyze the repository: ${repoUrl}. Read the README, key source files, and documentation. Write a detailed analysis of the codebase architecture, key concepts it demonstrates, and how it connects to the broader topic. Save your analysis as research/repo-analysis.md. Include code snippets with explanations.`,
      });
    }

    const workerPromises = workers.map((w) =>
      this.createTaskWorker(task.id, {
        role: w.role,
        objective: w.objective,
        taskRunId: context.taskRun?.id,
      }).then(() => undefined)
    );

    await Promise.allSettled(workerPromises);
    this.emitEvent({
      type: "task.agent",
      taskId: task.id,
      agentId: "research-swarm",
      status: "running",
      label: `Researching with ${workers.length} parallel agents`,
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

    // One-time migration: import .stuart-memory.md into structured memory
    if (project && !this.db.hasStudentMemories(task.projectId)) {
      try {
        const legacyPath = join(project.rootPath, ".stuart-memory.md");
        if (existsSync(legacyPath)) {
          const content = require("node:fs").readFileSync(legacyPath, "utf8") as string;
          if (content.trim()) {
            // Split into lines and create one memory per meaningful line
            const lines = content.split("\n").filter((l: string) => l.trim() && !l.startsWith("#"));
            for (const line of lines) {
              const cleaned = line.replace(/^[-*•]\s*/, "").trim();
              if (cleaned.length < 5) continue;
              this.db.createStudentMemory({
                scopeType: "project",
                scopeId: task.projectId,
                category: "context",
                content: cleaned,
                sourceKind: "migration",
              });
            }
            // Rename to mark as migrated
            const { renameSync } = require("node:fs");
            renameSync(legacyPath, `${legacyPath}.migrated`);
            process.stdout.write(`[stuart] migrated .stuart-memory.md to structured memory (${lines.length} entries).\n`);
          }
        }
      } catch {
        // Migration is best-effort
      }
    }

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
            startedAt: new Date().toISOString(),
            lastActivityAt: Date.now(),
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
          state.lastActivityAt = Date.now();
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

        state.lastActivityAt = Date.now();
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

        state.lastActivityAt = Date.now();
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

        if (state) {
          state.lastActivityAt = Date.now();
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

        if (state) {
          state.lastActivityAt = Date.now();
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

        // Internal helper turns: capture text but don't store as a chat message
        if (state?.memoryExtraction || state?.quizValidation) {
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
                  lastActivityAt: Date.now(),
                  kind: owner.worker ? "worker" : "task",
                  workerId: owner.worker?.id,
                  assistantText: "",
                  thinkingLabel: "",
                  startedEmitted: true,
                  cwd: undefined,
                  triggersReindex: undefined,
                  userMessage: undefined,
                  memoryExtraction: undefined,
                  quizValidation: undefined,
                  quickCompleteResolve: undefined,
                }
              : null;
          })();

        if (!state) {
          return;
        }

        // Quick-complete turns: resolve the promise and clean up
        if (state.quickCompleteResolve) {
          state.quickCompleteResolve(state.assistantText);
          this.turns.delete(state.turnId);
          return;
        }

        // Memory extraction turn completed — parse and store memories
        if (state.memoryExtraction) {
          try {
            const text = state.assistantText.trim();
            const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ?? text.match(/(\[[\s\S]*\])/);
            if (jsonMatch?.[1]) {
              const task = this.db.getTask(state.taskId);
              const memories = JSON.parse(jsonMatch[1]) as Array<{
                scope_type?: string;
                category?: string;
                topic?: string;
                memory_key?: string;
                content?: string;
                event_date?: string | null;
                expires_at?: string | null;
              }>;
              for (const mem of memories) {
                if (!mem.content || !mem.category) continue;
                this.db.createStudentMemory({
                  scopeType: (mem.scope_type === "global" ? "global" : "project") as "global" | "project",
                  scopeId: mem.scope_type === "global" ? null : task?.projectId ?? null,
                  category: mem.category as "preference" | "fact" | "goal" | "progress" | "context",
                  topic: mem.topic ?? null,
                  memoryKey: mem.memory_key ?? null,
                  content: mem.content,
                  sourceKind: "user_message",
                  eventDate: mem.event_date ?? null,
                  expiresAt: mem.expires_at ?? null,
                });
              }
              if (memories.length > 0) {
                process.stdout.write(`[stuart] extracted ${memories.length} student memor${memories.length === 1 ? "y" : "ies"} from turn.\n`);
              }
            }
          } catch {
            // Extraction parsing failed — non-critical
          }
          this.turns.delete(params.turn.id);
          return;
        }

        // Quiz validation turn completed — apply corrections if any
        if (state.quizValidation) {
          try {
            const text = state.assistantText.trim();
            const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ?? text.match(/(\[[\s\S]*\])/);
            if (jsonMatch?.[1]) {
              const corrections = JSON.parse(jsonMatch[1]) as Array<{
                index: number;
                issue: string;
                correctedAnswer?: string;
              }>;
              if (corrections.length > 0) {
                const payload = JSON.parse(state.quizValidation.originalPayload) as { questions: Array<Record<string, unknown>> };
                let fixed = 0;
                for (const correction of corrections) {
                  const q = payload.questions[correction.index];
                  if (q && correction.correctedAnswer) {
                    q.answer = correction.correctedAnswer;
                    fixed++;
                  }
                }
                if (fixed > 0) {
                  this.db.updateStudyArtifact(state.quizValidation.artifactId, JSON.stringify(payload));
                  this.recordRuntimeMessage(
                    state.taskId,
                    `Quiz checker fixed ${fixed} question${fixed === 1 ? "" : "s"} with incorrect answers.`
                  );
                  process.stdout.write(`[stuart] quiz validation: fixed ${fixed} question(s) in artifact ${state.quizValidation.artifactId}.\n`);
                } else {
                  process.stdout.write(`[stuart] quiz validation: ${corrections.length} issue(s) noted but no answer corrections needed.\n`);
                }
              } else {
                process.stdout.write("[stuart] quiz validation: all questions passed.\n");
              }
            }
          } catch {
            // Validation parsing failed — non-critical
          }
          this.turns.delete(params.turn.id);
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

          // Resolve cwd if missing (can happen on resumed threads)
          if (!state.cwd) {
            const latestRun = this.db.listTaskRuns(state.taskId)[0];
            if (latestRun) {
              state.cwd = latestRun.stagingPath;
            }
          }

          // Artifact detection: try to parse any assistant response that contains JSON or script artifacts
          try {
            const assistantText = state.assistantText.trim();
            if (assistantText) {
              const parsed = tryParseArtifactJson(assistantText, state.cwd);
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

                // Validate quiz questions with a checking agent
                if (parsed.kind === "quiz") {
                  void this.validateQuizArtifact(artifact.id, state.taskId).catch(() => {});
                }

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

          // Fallback: if no artifact was detected but Codex wrote HTML files to the workspace,
          // create interactive artifacts from them automatically.
          if (state.cwd) {
            try {
              const turnStartedAt = state.startedAt ? new Date(state.startedAt) : new Date(0);
              const htmlArtifacts = discoverInteractiveHtmlFiles(state.cwd, turnStartedAt);
              const referencedArtifacts = state.assistantText
                ? discoverReferencedInteractiveHtmlFiles(state.cwd, state.assistantText)
                : [];
              const candidates = new Map<string, (typeof htmlArtifacts)[number]>();
              for (const file of [...referencedArtifacts, ...htmlArtifacts]) {
                candidates.set(file.relativePath, file);
              }
              process.stdout.write(
                `[stuart] HTML file scan in ${state.cwd}: found ${htmlArtifacts.length} recent interactive HTML artifact candidate(s) and ${referencedArtifacts.length} assistant-referenced candidate(s): ${[...candidates.values()].map((file) => file.relativePath).join(", ") || "(none)"}\n`
              );
              for (const file of candidates.values()) {
                const existing = this.db.listStudyArtifacts(state.taskId).some(
                  (artifact) =>
                    artifact.kind === "interactive" &&
                    (artifact.payload.includes(file.relativePath) || artifact.payload.includes(file.title))
                );
                if (existing) {
                  process.stdout.write(`[stuart] HTML scan: skipping ${file.relativePath} — already has artifact\n`);
                  continue;
                }

                this.db.createStudyArtifact({
                  taskId: state.taskId,
                  kind: "interactive",
                  title: file.title,
                  payload: JSON.stringify({
                    kind: "interactive",
                    title: file.title,
                    html: file.html,
                    sourcePath: file.relativePath
                  })
                });
                this.recordRuntimeMessage(
                  state.taskId,
                  `Detected interactive artifact from workspace file: "${file.title}".`
                );
              }
            } catch { /* workspace scan is best-effort */ }
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
                // Copy curriculum files
                for (const currFile of ["curriculum.md", "curriculum.json"]) {
                  const stagingPath = join(state.cwd, currFile);
                  if (existsSync(stagingPath)) {
                    await cp(stagingPath, join(projectRoot, currFile), { force: true });
                  }
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

          // Extract student memories from this turn (fire-and-forget)
          if (state.userMessage) {
            void this.extractStudentMemories(
              state.taskId,
              state.userMessage,
              state.assistantText
            ).catch(() => {});
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
    if (statsBefore.documentsIndexed === 0) {
      this.scheduleTaskIngestionIndex(task, {
        taskRunId: taskRun.id,
        force: true,
        reason: "The local index is still warming, so Stuart will start from the staged workspace files and layer in indexed context as it becomes ready."
      });
      return this.buildWorkspaceObservationContext(task, taskRun, message);
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
    const isArtifactTurn =
      ARTIFACT_PATTERN.test(message) ||
      /\b(visuali[sz]er?|simulator?|simulation|explorable|playground|widget)\b/i.test(message);
    const contextPreamble = isArtifactTurn
      ? "Local retrieved context from the staged workspace. Use these excerpts to determine the exact concepts, labels, rules, examples, and terminology that should appear in the artifact you build. Ground the artifact in this material, and if you need more detail on a specific section, use grep/cat to read the full file. Do not just summarize these excerpts back to the student."
      : "Local retrieved context from the staged workspace. Use these excerpts as your primary source material. Cite source names when relying on them. If you need more detail on a specific section, use grep/cat to read the full file.";

    // Use full chunk text (not snippets) for richer context — truncate only very long chunks
    return [
      contextPreamble,
      ...results.map((result, index) =>
        [
          `--- [${index + 1}] ${cleanSourceName(result.relativePath)}${result.heading ? ` — ${result.heading}` : ""}${result.locator ? ` (${result.locator})` : ""} ---`,
          result.text.length > 2000 ? result.text.slice(0, 2000) + "\n[...truncated]" : result.text
        ].join("\n")
      ),
      ...(conversationContext ? [conversationContext] : [])
    ].join("\n\n");
  }

  private async buildWorkspaceObservationContext(
    task: TaskSpec,
    taskRun: TaskRunRecord,
    message: string
  ): Promise<string | null> {
    const files = await this.collectWorkspaceFiles(task.id, taskRun.id, 500);
    if (files.length === 0) {
      return null;
    }

    const targetedFiles = extractTargetedFiles(message).map((value) => value.toLowerCase());
    const queryTokens = [...new Set(
      sanitizeRetrievalQuery(message)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3)
    )];
    const studyLikePattern = /\b(lecture|chapter|week|notes?|slides?|tutorial|assignment|quiz|exam|syllabus|reading|module|lab|worksheet)\b/i;

    const ranked = files
      .map((entry) => {
        const relativePath = entry.relativePath.toLowerCase();
        let score = 0;
        for (const target of targetedFiles) {
          if (relativePath.includes(target)) {
            score += 24;
          }
        }
        for (const token of queryTokens) {
          if (relativePath.includes(token)) {
            score += 6;
          }
        }
        if (studyLikePattern.test(relativePath)) {
          score += 3;
        }
        if (/\.(pdf|docx|pptx|xlsx|md|txt|html)$/i.test(entry.relativePath)) {
          score += 2;
        }
        return { entry, score };
      })
      .sort((left, right) =>
        right.score - left.score ||
        left.entry.relativePath.length - right.entry.relativePath.length
      );

    const prioritized = ranked
      .filter((candidate) => candidate.score > 0)
      .slice(0, 12)
      .map((candidate) => candidate.entry);
    const fallback = files
      .filter((entry) =>
        studyLikePattern.test(entry.relativePath) ||
        /\.(pdf|docx|pptx|xlsx|md|txt|html)$/i.test(entry.relativePath)
      )
      .slice(0, 12);
    const shortlist = prioritized.length > 0 ? prioritized : fallback;

    if (shortlist.length === 0) {
      return [
        "The workspace is mounted locally and available to inspect directly.",
        "The background index is still warming, so use `rg`, `ls`, `cat`, and targeted file opens in the staged workspace rather than waiting for indexed excerpts.",
      ].join("\n");
    }

    return [
      "The workspace is mounted locally and available to inspect directly.",
      "The background index is still warming, so inspect the staged files directly instead of waiting for indexed excerpts.",
      targetedFiles.length > 0
        ? `Prioritise files matching: ${[...new Set(targetedFiles)].slice(0, 6).join(", ")}.`
        : "Start from the most relevant study materials below.",
      "Suggested files to inspect first:",
      ...shortlist.map((entry) => `- ${entry.relativePath}`),
      `Visible workspace files: ${files.length}.`,
    ].join("\n");
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
    if (this.turnWatchdog) {
      clearInterval(this.turnWatchdog);
      this.turnWatchdog = undefined;
    }
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
    "When local retrieved context is supplied, use it first and cite source names, lecture titles, or short relative file labels when helpful.",
    "Never expose absolute staging paths, local filesystem prefixes, or raw `/Users/...` paths in student-facing answers.",
    "If you include a markdown link to a local source, use compact markdown with no space before the opening parenthesis, for example `[Lecture 2](Lecture 2 - Solving Problems by Searching.pdf)`.",
    "When the student asks you to build an artifact, the artifact itself is the main deliverable. Do not stop at prose alone.",
    "If you create an HTML interactive or generated file, save it inside the staged workspace and end with exactly one JSON code block describing the artifact handoff.",
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

function buildCurriculumContext(projectRootPath: string): string {
  try {
    const specPath = join(projectRootPath, "curriculum.json");
    const progressPath = join(projectRootPath, "curriculum-progress.json");
    if (!existsSync(specPath)) return "";

    const spec = JSON.parse(require("node:fs").readFileSync(specPath, "utf8") as string) as {
      title?: string;
      phases?: Array<{ id: string; title: string; checkpoints?: Array<{ id: string; topic: string }> }>;
    };
    if (!spec.phases?.length) return "";

    let progress: { currentPhase?: string; phases?: Record<string, { status?: string; checkpoints?: Record<string, { passed?: boolean }> }> } | null = null;
    try {
      if (existsSync(progressPath)) {
        progress = JSON.parse(require("node:fs").readFileSync(progressPath, "utf8") as string);
      }
    } catch { /* ignore */ }

    const lines: string[] = [];
    for (const phase of spec.phases) {
      const pp = progress?.phases?.[phase.id];
      const status = pp?.status ?? "locked";
      const icon = status === "complete" ? "done" : status === "in_progress" ? "current" : "locked";
      const checkpoints = phase.checkpoints ?? [];
      const passed = checkpoints.filter((c) => pp?.checkpoints?.[c.id]?.passed).length;
      lines.push(`- [${icon}] ${phase.title} (${passed}/${checkpoints.length} checkpoints)`);
    }

    return `\n\n## Curriculum: ${spec.title ?? "Active"}\nCurrent phase: ${progress?.currentPhase ?? spec.phases[0]!.id}\n${lines.join("\n")}\n\nThe student can say "check my understanding of [phase]" to take a checkpoint quiz. When they do, generate a quiz targeting that phase's checkpoint topics.`;
  } catch {
    return "";
  }
}

function buildStudentMemoryContext(db: LocalDatabase | undefined, projectId: string): string {
  if (!db) return "";
  try {
    const rawMemories = db.queryStudentMemories(projectId, 40);
    if (rawMemories.length === 0) return "";

    const limits: Record<string, number> = {
      preference: 2,
      progress: 2,
      goal: 2,
      fact: 2,
      context: 1,
    };
    const counts = new Map<string, number>();
    const categoryOrder = ["preference", "progress", "goal", "fact", "context"];
    const memories = [...rawMemories]
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .filter((memory) => {
        const current = counts.get(memory.category) ?? 0;
        const limit = limits[memory.category] ?? 1;
        if (current >= limit) {
          return false;
        }
        counts.set(memory.category, current + 1);
        return true;
      })
      .sort((left, right) => {
        const categoryDelta =
          categoryOrder.indexOf(left.category) - categoryOrder.indexOf(right.category);
        if (categoryDelta !== 0) {
          return categoryDelta;
        }
        return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
      });

    const lines = memories.map((m) => {
      const age = Math.floor((Date.now() - new Date(m.createdAt).getTime()) / 86400000);
      const ageLabel = age === 0 ? "today" : age === 1 ? "yesterday" : `${age}d ago`;
      return `- [${m.category}] ${m.content} (${ageLabel})`;
    });

    return `\n\n## About this student\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

function buildArtifactTurnContract(skills: Skill[]): string {
  const artifactSkills = skills.filter((skill) => skill.id !== "research");
  if (artifactSkills.length === 0) {
    return "";
  }

  const hasInteractive = artifactSkills.some((skill) => skill.id === "interactive");
  const hasDocument = artifactSkills.some((skill) => skill.id.startsWith("document-"));

  const lines = [
    "## Artifact turn contract",
    "- This is an artifact-generation turn. The artifact is the primary deliverable, not a prose explanation.",
    "- Keep any prose before the artifact to at most 2 short sentences.",
    "- End the final answer with exactly one JSON code block and nothing after it.",
    "- The JSON must include a valid `kind` and `title` field."
  ];

  if (hasInteractive) {
    lines.push(
      "- If you build an interactive HTML artifact, save it inside the staged workspace and return JSON like `{ \"kind\": \"interactive\", \"title\": \"...\", \"path\": \"relative/path.html\" }`.",
      "- Do not merely mention or link the HTML filename in prose. The JSON handoff is required."
    );
  } else if (hasDocument) {
    lines.push(
      "- If you generate a file-based document artifact, end with JSON that hands off the artifact payload or generated file path in the expected format."
    );
  } else {
    lines.push(
      "- Return the artifact payload directly inside the final JSON block in the schema requested by the active skill."
    );
  }

  return lines.join("\n");
}

export function buildTeachingInstructions(project: ProjectRecord, task: TaskSpec, db?: LocalDatabase): string {
  // Build structured student memory context from SQLite
  const memoryContext = buildStudentMemoryContext(db, task.projectId);

  // Fallback: read legacy .stuart-memory.md if no structured memories exist yet
  let legacyMemoryContext = "";
  if (!memoryContext && db && !db.hasStudentMemories(task.projectId)) {
    try {
      const memoryPath = join(project.rootPath, ".stuart-memory.md");
      if (existsSync(memoryPath)) {
        const content = require("node:fs").readFileSync(memoryPath, "utf8") as string;
        if (content.trim()) {
          legacyMemoryContext = `\n\n## Cross-session notes (legacy)\n${content.trim()}`;
        }
      }
    } catch { /* ignore */ }
  }

  // Lightweight performance snapshot
  const perfSnapshot = db ? buildPerformanceSnapshot(db, task) : "";

  return `You are Stuart, the student's study companion, guide, and subject-matter expert inside a local workspace.

## Role
- Act like a strong domain expert in whatever the student is studying in this workspace.
- Use subject-matter expertise to explain concepts accurately, connect ideas, choose good examples, and highlight what matters most.
- Stay grounded in the student's local material for course-specific claims. If you use general domain knowledge or web research, label that clearly.
- Your job is to help the student learn efficiently, not to show off or dump everything you know.

## Teaching style
- Be concise, effective, and digestible by default.
- Start with the direct answer or core takeaway in 1 to 2 sentences.
- Then give a short structured explanation using brief bullets or short paragraphs.
- Prefer simple language, clean structure, and concrete examples over dense jargon.
- Break difficult ideas into layers: overview -> key mechanism -> important detail.
- Avoid walls of text, long preambles, filler, and raw excerpt dumps.
- Only go deep when the student asks for depth or when the concept genuinely requires it.
- When helpful, end with one useful next step, memory hook, or quick check for understanding. Do not turn every answer into homework.

## Core behaviour
- Use your domain expertise to enrich and improve on what the workspace materials provide — add better examples, clearer explanations, and deeper context.
- When your knowledge conflicts with the workspace evidence, default to the workspace evidence. The student's course materials are the authority for course-specific claims.
- Diagnose what the student is probably trying to understand, not just the literal wording of the question.
- If neither the workspace nor your domain knowledge covers the question, say so honestly.
- Cite sources by name. Prefer lecture slides, chapters, notes, and study guides over code/config files.
- Synthesize concepts clearly instead of listing files or pasting raw excerpts.
- When the student references a specific chapter, lecture, week, or worksheet, search for matching filenames first (e.g. "Lecture 01", "Chapter 1") before exploring broadly.
- If the question is broad, give the student the clean mental model first, then the most important supporting details.

## Web research
You have web search enabled. Use it when:
- The student asks about something not covered in their local materials.
- The student explicitly asks you to research a topic online.
- You need additional context, definitions, or current information to give a better answer.
- The student asks for comparisons with external resources.
Always clearly indicate when information comes from the web vs. their local study materials.

## Student memory
Stuart automatically remembers important facts about you across sessions — your preferences, goals, exam dates, and progress. You don't need to ask it to remember. If you want Stuart to note something specific, just say it naturally in conversation.

## Capabilities
You can generate study artifacts (flashcards, quizzes, mind maps, diagrams, mock exams, interactive apps, PDF/DOCX/XLSX/PPTX documents). When asked to create one, you will receive detailed formatting instructions in the context. The artifact itself is the primary deliverable. Always output artifacts as a single JSON code block with a "kind" and "title" field, and never stop at a prose description plus a filename mention.

## Artifact self-containment (CRITICAL)
When generating any artifact (quiz, flashcard, mock exam, etc.), every question or card MUST be independently answerable. If a question references a specific equation, model, dataset, or numerical example from the student's materials, you MUST reproduce the full data inside the question text itself. Never assume the student has another document open. Never refer to "the model" or "the equation" without stating it in full. Workspace-specific data (regression coefficients, sample datasets, assignment equations) is NOT general knowledge — always present it as "given data" in the question, never as a named formula.

## Math notation (CRITICAL)
ALL mathematical expressions — in chat responses, flashcards, quizzes, mock exams, study docs, and any other output — MUST be wrapped in LaTeX delimiters. Use dollar signs for inline math and double dollar signs for display math. Never output bare math notation like c^T x or x_1 + x_2 — always wrap it in single dollar signs for inline or double dollar signs for display. This applies to variables, equations, inequalities, subscripts, superscripts, Greek letters, operators, and any mathematical symbol. Stuart's renderer uses KaTeX and can only render math inside dollar-sign delimiters.

You can also research new topics, fetch content from URLs and repos, and build structured curricula with saved source files — detailed instructions will be provided when the student asks for this.${memoryContext}${legacyMemoryContext}${buildCurriculumContext(project.rootPath)}${perfSnapshot}`;
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

  // Extract URLs from curl commands
  const urlMatch = detail.match(/curl\s+(?:-\S+\s+)*(\S*https?:\/\/[^\s|"']+)/);
  if (urlMatch) {
    try {
      const url = new URL(urlMatch[1]!);
      const host = url.hostname.replace(/^www\./, "");
      const path = url.pathname.length > 1 ? url.pathname.split("/").filter(Boolean).slice(-1)[0] : "";
      return `Fetching ${host}${path ? "/" + path : ""}...`;
    } catch {
      return "Fetching content...";
    }
  }

  // Git clone
  const cloneMatch = detail.match(/git\s+clone\s+(?:--\S+\s+)*(\S+)/);
  if (cloneMatch) {
    const repo = cloneMatch[1]!.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    return `Cloning ${repo}...`;
  }

  if (/running command/i.test(detail)) {
    // File operations
    const writeMatch = detail.match(/(?:writing|creating|saving)\s+.*?`([^`]+)`/i);
    if (writeMatch) return `Writing ${writeMatch[1]!.split("/").pop()}...`;

    if (/\brg\b|grep|search/i.test(detail)) return "Searching through materials...";
    if (/\bcat\b|\bread\b/i.test(detail)) {
      const fileMatch = detail.match(/(?:cat|head|tail|sed)\s+.*?([^\s/]+\.\w+)/);
      return fileMatch ? `Reading ${fileMatch[1]}...` : "Reading a file...";
    }
    if (/\bls\b|\bfind\b/i.test(detail)) return "Browsing workspace...";
    if (/\bmkdir\b/i.test(detail)) return "Setting up directories...";
    if (/\bwc\b/i.test(detail)) return "Checking file sizes...";
    return "Running a command...";
  }
  if (/command finished/i.test(detail)) return "Processing results...";
  if (/stuart-memory/i.test(detail)) return "Updating study memory...";
  if (/tool.*call|using tool/i.test(detail)) {
    const toolMatch = detail.match(/`([^`]+)`/);
    return toolMatch ? `Using ${toolMatch[1]}...` : "Using a tool...";
  }
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
    .replace(/\b(i\s+would\s+like|i\s+wouldlike|wouldlike|i\s+want)\b/gi, "")
    .replace(/\b(create|generate|make|give me|can you|please|build|produce)\b/gi, "")
    .replace(/\b\d+\s*(flashcards?|cards?|questions?|quizzes?|quiz)\b/gi, "")
    .replace(/\b(flashcards?|flash\s*cards?|cloze|anki|quiz|quizzes?|mind\s*map|mindmap|diagram|mock\s*exam|test me|interactive|visuali[sz]er?|simulator?|simulation|explorable|playground|widget)\b/gi, "")
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
  return /\b(read|open|scan|search|find|summari[sz]e|review|inspect|analy[sz]e|compare|extract|cite|from the files|from the docs|workspace|directory|folder|document|documents|packet|pdf|docx|xlsx|pptx|slides|notes|study|report|memo|brief|question|answer|flashcards?|quiz|mind\s*map|mindmap|diagram|mock\s*exam|interactive|visuali[sz]er?|simulator?|simulation|explorable|playground|widget)\b/i.test(
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
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
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

      let fileStat;
      try {
        fileStat = await stat(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
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

const ARTIFACT_PATTERN = /\b(flashcards?|quiz|mind\s*map|mindmap|diagram|mock[\s_-]*exam|interactive|study[\s_-]*doc|notes)\b/i;

export function tryParseArtifactJson(
  text: string,
  baseDir?: string
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
      "interactive-web-preview": "interactive",
      "interactive app": "interactive",
      "interactive artifact": "interactive",
      html: "interactive",
      "html app": "interactive",
      webpage: "interactive",
      visualizer: "interactive",
      visualiser: "interactive",
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
      study_doc: "study_doc",
      "study doc": "study_doc",
      "study document": "study_doc",
      "notes document": "study_doc",
      notes: "study_doc",
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

    // If interactive/html artifact referenced a file path instead of inline html, read it
    if (kind === "interactive" && !normalized.path && typeof parsed.entry === "string") {
      normalized.path = parsed.entry;
    }
    if (kind === "interactive" && !normalized.html && typeof normalized.path === "string") {
      try {
        const { readFileSync, existsSync: existsSyncLocal } = require("node:fs") as typeof import("node:fs");
        const requestedPath = normalized.path as string;
        const resolvedPath =
          baseDir && !requestedPath.startsWith("/")
            ? resolve(baseDir, requestedPath)
            : requestedPath;
        if (existsSyncLocal(resolvedPath)) {
          normalized.html = readFileSync(resolvedPath, "utf8");
          normalized.sourcePath = baseDir ? relative(baseDir, resolvedPath) : requestedPath;
        }
      } catch { /* ignore — artifact will have empty html */ }
    }

    return { kind, title, data: normalized };
  } catch {
    return null;
  }
}

export function discoverInteractiveHtmlFiles(rootPath: string, turnStart: Date) {
  const { readdirSync, readFileSync, statSync } = require("node:fs") as typeof import("node:fs");
  const results: Array<{ filePath: string; relativePath: string; title: string; html: string }> = [];

  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(rootPath, absolutePath);

      if (entry.isDirectory()) {
        if (shouldHideWorkspacePath(relativePath)) {
          continue;
        }
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!/\.(html?|xhtml)$/i.test(entry.name)) {
        continue;
      }
      if (shouldHideWorkspacePath(relativePath)) {
        continue;
      }

      const fileStat = statSync(absolutePath);
      if (fileStat.mtimeMs < turnStart.getTime()) {
        continue;
      }
      if (fileStat.size < 150 || fileStat.size > 200_000) {
        continue;
      }

      const html = readFileSync(absolutePath, "utf8");
      if (!html.includes("<script") && !html.includes("onclick")) {
        continue;
      }

      const title =
        html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim()
        ?? entry.name.replace(/\.(html?|xhtml)$/i, "").replace(/[-_]/g, " ");

      results.push({
        filePath: absolutePath,
        relativePath,
        title,
        html,
      });
    }
  }

  visit(rootPath);
  return results;
}

export function discoverReferencedInteractiveHtmlFiles(rootPath: string, text: string) {
  const mentioned = new Set<string>();
  const normalizedText = text.normalize("NFKC");

  for (const match of normalizedText.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const label = normalizeWorkspaceReference(match[1] ?? "");
    const href = normalizeWorkspaceReference(match[2] ?? "");
    if (/\.(html?|xhtml)$/i.test(label)) {
      mentioned.add(basename(label));
    }
    if (/\.(html?|xhtml)$/i.test(href)) {
      mentioned.add(basename(href));
    }
  }

  for (const match of normalizedText.matchAll(/\b([A-Za-z0-9._/-]+\.(?:html?|xhtml))\b/gi)) {
    mentioned.add(basename(normalizeWorkspaceReference(match[1] ?? "")));
  }

  if (mentioned.size === 0) {
    return [];
  }

  return discoverInteractiveHtmlFiles(rootPath, new Date(0)).filter((file) =>
    mentioned.has(basename(file.relativePath))
  );
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
