import express from "express";
import type { Server } from "node:http";
import { StuartRuntime, type VmHelperClient } from "@stuart/runtime-supervisor";
import type {
  ApprovalRecord,
  CardPerformanceRecord,
  CreateProjectInput,
  CreateTaskInput,
  CreateWorkerInput,
  IngestionDocumentRecord,
  IngestionIndexStats,
  IngestionSearchResult,
  MindMapNodeNote,
  MockExamAttempt,
  ProjectLearningSummary,
  QuizPerformanceRecord,
  StudyArtifactRecord,
  StudySessionRecord,
  StudyTimelineEntry,
  TaskMessageRecord,
  TaskPerformanceBreakdown,
  TaskWorkerRecord,
  TopicPerformanceRecord,
  UpdateTaskInput,
  VmStatus,
  WorkspaceEvent
} from "@stuart/shared";
import { extractTopic } from "@stuart/shared";

export interface StuartHarnessOptions {
  dataDir: string;
  vmHelperBinaryPath?: string;
  workspaceRoot?: string;
  runtime?: StuartRuntime;
}

export interface StuartApiRouterOptions {
  harness: StuartHarness;
  openExternalPath?: (absolutePath: string) => Promise<void>;
}

export interface StuartHarnessAppOptions extends StuartApiRouterOptions {
  configureApp?: (app: express.Express, harness: StuartHarness) => void;
}

export interface StuartHarnessServerOptions extends StuartHarnessAppOptions {
  port?: number;
  host?: string;
}

export interface HarnessCleanupResult {
  removedTaskCount: number;
  removedProjectCount: number;
  dedupedProjectCount: number;
}

type DashboardPayload = {
  vmStatus: VmStatus;
  projects: ReturnType<StuartRuntime["listProjects"]>;
  tasks: ReturnType<StuartRuntime["listTasks"]>;
  diagnostics: Awaited<ReturnType<StuartRuntime["getSystemDiagnostics"]>>;
};

export class StuartHarness {
  readonly runtime: StuartRuntime;
  readonly vm: VmHelperClient;

  constructor(options: StuartHarnessOptions) {
    this.runtime =
      options.runtime ??
      new StuartRuntime({
        dataDir: options.dataDir,
        vmHelperBinaryPath: options.vmHelperBinaryPath,
        workspaceRoot: options.workspaceRoot
      });
    this.vm = this.runtime.vm;
  }

  async bootstrap(): Promise<void> {
    await this.runtime.bootstrap();
  }

  onEvent(listener: (event: WorkspaceEvent) => void): () => void {
    return this.runtime.onEvent(listener);
  }

  async close(): Promise<void> {
    await this.runtime.close();
  }

  async cleanupDemoData(): Promise<HarnessCleanupResult> {
    return this.runtime.cleanupDemoData();
  }
}

export function createStuartHarnessApp(options: StuartHarnessAppOptions): express.Express {
  const app = express();

  app.use(express.json({ limit: "5mb" }));
  app.use("/api", createStuartApiRouter(options));
  options.configureApp?.(app, options.harness);

  return app;
}

export class StuartHarnessServer {
  readonly harness: StuartHarness;
  readonly app: express.Express;
  private server?: Server;

  constructor(options: StuartHarnessServerOptions) {
    this.harness = options.harness;
    this.app = createStuartHarnessApp(options);
  }

  async listen(port = 8787, host?: string): Promise<Server> {
    if (this.server) {
      return this.server;
    }

    await this.harness.bootstrap();
    this.server = await new Promise<Server>((resolve, reject) => {
      const server =
        typeof host === "string"
          ? this.app.listen(port, host, () => resolve(server))
          : this.app.listen(port, () => resolve(server));
      server.once("error", reject);
    });

    return this.server;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    await this.harness.close();
  }
}

export function createStuartApiRouter(options: StuartApiRouterOptions): express.Router {
  const { harness, openExternalPath } = options;
  const runtime = harness.runtime;
  const router = express.Router();
  const eventClients = new Set<express.Response>();

  harness.onEvent((event) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of eventClients) {
      client.write(data);
    }
  });

  router.get("/events", (_request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders?.();
    response.write(`data: ${JSON.stringify({ type: "connected" } satisfies WorkspaceEvent)}\n\n`);
    eventClients.add(response);

    const heartbeat = setInterval(() => {
      response.write(`event: ping\ndata: {}\n\n`);
    }, 15000);

    response.on("close", () => {
      clearInterval(heartbeat);
      eventClients.delete(response);
    });
  });

  router.get("/health", (_request, response) => {
    response.json({ ok: true });
  });

  router.get("/dashboard", asyncRoute(async (_request, response) => {
    const [vmStatus, projects, tasks, diagnostics] = await Promise.all([
      safeVmStatus(runtime),
      safeProjects(runtime),
      safeTasks(runtime),
      safeSystemDiagnostics(runtime)
    ]);
    response.json({
      vmStatus,
      projects,
      tasks,
      diagnostics
    } satisfies DashboardPayload);
  }));

  router.get("/system/diagnostics", asyncRoute(async (_request, response) => {
    response.json(await safeSystemDiagnostics(runtime));
  }));

  router.get("/projects", (_request, response) => {
    response.json(runtime.listProjects());
  });

  router.post("/projects", (request, response) => {
    const input = request.body as CreateProjectInput;
    if (!input?.name || !input?.rootPath) {
      response.status(400).send("Project name and root path are required.");
      return;
    }

    const project = runtime.createProject(input);
    broadcastEvent(eventClients, { type: "project.created", projectId: project.id });
    response.status(201).json(project);
  });

  router.delete("/projects/:projectId", asyncRoute(async (request, response) => {
    const deleted = await runtime.deleteProject(firstParam(request.params.projectId));
    if (!deleted) {
      response.status(404).send("Project not found.");
      return;
    }
    response.status(204).end();
  }));

  router.get("/tasks", (_request, response) => {
    response.json(runtime.listTasks());
  });

  router.post("/tasks", (request, response) => {
    const input = request.body as CreateTaskInput;
    if (!input?.projectId || !input?.title || !input?.objective) {
      response.status(400).send("Task projectId, title, and objective are required.");
      return;
    }

    const task = runtime.createTask(input);
    broadcastEvent(eventClients, { type: "task.created", taskId: task.id });
    response.status(201).json(task);
  });

  router.patch("/tasks/:taskId", (request, response) => {
    const input = request.body as UpdateTaskInput;
    const task = runtime.updateTask(firstParam(request.params.taskId), input);
    broadcastEvent(eventClients, { type: "task.updated", taskId: task.id });
    response.json(task);
  });

  router.delete("/tasks/:taskId", asyncRoute(async (request, response) => {
    const deleted = await runtime.deleteTask(firstParam(request.params.taskId));
    if (!deleted) {
      response.status(404).send("Task not found.");
      return;
    }
    response.status(204).end();
  }));

  router.get("/tasks/:taskId/messages", (request, response) => {
    response.json(runtime.listTaskMessages(firstParam(request.params.taskId)));
  });

  router.post("/tasks/:taskId/messages", asyncRoute(async (request, response) => {
    const content =
      typeof request.body?.content === "string" ? request.body.content.trim() : "";
    if (content === "") {
      response.status(400).send("Task message content is required.");
      return;
    }

    const imageBase64 =
      typeof request.body?.imageBase64 === "string" ? request.body.imageBase64 : undefined;

    const taskId = firstParam(request.params.taskId);
    const result = await runtime.sendTaskMessage(taskId, content, { imageBase64 });
    if (result.preparedRun) {
      broadcastEvent(eventClients, {
        type: "task.run",
        taskId,
        taskRunId: result.preparedRun.id
      });
    }
    broadcastEvent(eventClients, {
      type: "task.message",
      taskId
    });
    response.status(201).json({
      userMessage: result.userMessage,
      startedTurn: result.startedTurn
    } satisfies {
      userMessage: TaskMessageRecord;
      startedTurn: boolean;
    });
  }));

  router.get("/tasks/:taskId/runs", (request, response) => {
    response.json(runtime.listTaskRuns(firstParam(request.params.taskId)));
  });

  router.get("/tasks/:taskId/workers", (request, response) => {
    response.json(runtime.listTaskWorkers(firstParam(request.params.taskId)));
  });

  router.post("/tasks/:taskId/workers", asyncRoute(async (request, response) => {
    const input = request.body as CreateWorkerInput;
    if (!input?.role || !input?.objective) {
      response.status(400).send("Worker role and objective are required.");
      return;
    }

    const worker = await runtime.createTaskWorker(
      firstParam(request.params.taskId),
      input
    );
    response.status(201).json(worker satisfies TaskWorkerRecord);
  }));

  router.post("/tasks/:taskId/runs", asyncRoute(async (request, response) => {
    const taskId = firstParam(request.params.taskId);
    const run = await runtime.prepareTaskRun(taskId);
    broadcastEvent(eventClients, {
      type: "task.run",
      taskId,
      taskRunId: run.id
    });
    response.status(201).json(run);
  }));

  router.get("/tasks/:taskId/ingestion", (request, response) => {
    const taskId = firstParam(request.params.taskId);
    const taskRunId =
      typeof request.query.taskRunId === "string" ? request.query.taskRunId : undefined;
    response.json({
      stats: runtime.getIngestionStats(taskId, taskRunId),
      documents: runtime.listIngestionDocuments(taskId, taskRunId)
    } satisfies {
      stats: IngestionIndexStats;
      documents: IngestionDocumentRecord[];
    });
  });

  router.post("/tasks/:taskId/ingestion/build", asyncRoute(async (request, response) => {
    const taskId = firstParam(request.params.taskId);
    const taskRunId =
      typeof request.body?.taskRunId === "string" ? request.body.taskRunId : undefined;
    const stats = await runtime.buildTaskIngestionIndex(taskId, {
      taskRunId,
      force: true
    });
    response.status(201).json(stats satisfies IngestionIndexStats);
  }));

  router.get("/tasks/:taskId/ingestion/search", (request, response) => {
    const taskId = firstParam(request.params.taskId);
    const query = typeof request.query.q === "string" ? request.query.q : "";
    const taskRunId =
      typeof request.query.taskRunId === "string" ? request.query.taskRunId : undefined;
    const limit = typeof request.query.limit === "string" ? Number(request.query.limit) : 8;
    response.json(
      runtime.searchIngestionIndex(taskId, query, {
        taskRunId,
        limit: Number.isFinite(limit) && limit > 0 ? limit : 8
      }) satisfies IngestionSearchResult[]
    );
  });

  router.get("/tasks/:taskId/workspace-files", asyncRoute(async (request, response) => {
    const taskId = firstParam(request.params.taskId);
    response.json(
      await runtime.listWorkspaceFiles(
        taskId,
        typeof request.query.taskRunId === "string" ? request.query.taskRunId : undefined
      )
    );
  }));

  router.post("/tasks/:taskId/workspace-links/open", asyncRoute(async (request, response) => {
    const taskId = firstParam(request.params.taskId);
    const href = typeof request.body?.href === "string" ? request.body.href.trim() : "";
    const taskRunId =
      typeof request.body?.taskRunId === "string" ? request.body.taskRunId : undefined;

    if (!href) {
      response.status(400).send("Link href is required.");
      return;
    }

    const entry = await runtime.resolveWorkspaceLink(taskId, href, taskRunId);
    if (!entry) {
      response.status(404).send("Could not resolve that link inside the current workspace.");
      return;
    }

    if (entry.previewKind !== "unsupported") {
      response.json({
        action: "preview",
        entryId: entry.id,
        previewKind: entry.previewKind
      });
      return;
    }

    if (openExternalPath) {
      await openExternalPath(entry.absolutePath);
    }

    response.json({
      action: "external",
      entryId: entry.id,
      previewKind: entry.previewKind
    });
  }));

  router.get("/task-runs/:taskRunId/diff", asyncRoute(async (request, response) => {
    response.json(await runtime.previewTaskDiff(firstParam(request.params.taskRunId)));
  }));

  router.get("/task-runs/:taskRunId/artifacts", (request, response) => {
    response.json(runtime.listArtifacts(firstParam(request.params.taskRunId)));
  });

  router.get("/task-runs/:taskRunId/approvals", (request, response) => {
    response.json(runtime.listApprovals(firstParam(request.params.taskRunId)));
  });

  router.patch("/task-runs/:taskRunId/approvals/:approvalId", (request, response) => {
    const status = request.body?.status;
    if (status !== "pending" && status !== "approved" && status !== "rejected") {
      response.status(400).send("Approval status must be pending, approved, or rejected.");
      return;
    }

    const taskRunId = firstParam(request.params.taskRunId);
    const approvalId = firstParam(request.params.approvalId);
    const approval = runtime.resolveApproval(taskRunId, approvalId, status);
    broadcastEvent(eventClients, {
      type: "task.approval",
      taskRunId,
      approvalId
    });
    response.json(approval satisfies ApprovalRecord);
  });

  router.get("/tasks/:taskId/study-artifacts", (request, response) => {
    response.json(
      runtime.db.listStudyArtifacts(firstParam(request.params.taskId)) satisfies StudyArtifactRecord[]
    );
  });

  router.get("/study-artifacts/:artifactId", (request, response) => {
    const artifact = runtime.db.getStudyArtifact(firstParam(request.params.artifactId));
    if (!artifact) {
      response.status(404).send("Study artifact not found.");
      return;
    }
    response.json(artifact satisfies StudyArtifactRecord);
  });

  // ---- Quick Inline Completion (for study doc slash commands) ----

  router.post("/quick-complete", asyncRoute(async (request, response) => {
    const { prompt, fallback } = request.body ?? {};
    if (!prompt || typeof prompt !== "string") {
      response.status(400).send("prompt is required.");
      return;
    }
    const result = await runtime.quickComplete(prompt, fallback ?? "");
    response.json({ result });
  }));

  router.post("/tasks/:taskId/study-artifacts", (request, response) => {
    const { kind, title, payload } = request.body ?? {};
    if (!kind || !title || !payload) {
      response.status(400).send("Study artifact kind, title, and payload are required.");
      return;
    }
    const taskId = firstParam(request.params.taskId);
    const isDocument = typeof kind === "string" && kind.startsWith("document_");
    const artifact = runtime.db.createStudyArtifact({
      taskId,
      kind,
      title,
      payload,
      payloadVersion: isDocument ? 2 : 1,
      renderStatus: isDocument ? "pending" : undefined,
      previewStatus: isDocument ? "pending" : undefined,
    });
    response.status(201).json(artifact satisfies StudyArtifactRecord);
  });

  // ---- Card Performance (Flashcard spaced repetition) ----

  router.get("/study-artifacts/:id/card-performance", (request, response) => {
    const artifactId = firstParam(request.params.id);
    response.json(
      runtime.db.listCardPerformance(artifactId) satisfies CardPerformanceRecord[]
    );
  });

  router.put("/study-artifacts/:id/card-performance/:cardId", (request, response) => {
    const artifactId = firstParam(request.params.id);
    const cardId = firstParam(request.params.cardId);
    const { easeFactor, intervalDays, repetitions, nextReviewDate, lastRating, totalReviews, correctCount } = request.body ?? {};
    if (easeFactor === undefined || intervalDays === undefined || repetitions === undefined || !nextReviewDate) {
      response.status(400).send("Card performance fields are required.");
      return;
    }
    const record = runtime.db.upsertCardPerformance({
      artifactId,
      cardId,
      easeFactor,
      intervalDays,
      repetitions,
      nextReviewDate,
      lastRating: lastRating ?? null,
      totalReviews: totalReviews ?? 0,
      correctCount: correctCount ?? 0,
    });

    // Auto-track topic performance
    try {
      const artifact = runtime.db.getStudyArtifact(artifactId);
      if (artifact) {
        const task = runtime.db.getTask(artifact.taskId);
        if (task) {
          let cue: string | undefined;
          try {
            const payload = JSON.parse(artifact.payload) as { cards?: Array<{ id: string; cue?: string }> };
            cue = payload.cards?.find((c) => c.id === cardId)?.cue;
          } catch { /* ignore */ }
          const topic = extractTopic(artifact.title, cue);
          const isCorrect = lastRating === "good" || lastRating === "easy";
          runtime.db.upsertTopicPerformance({
            projectId: task.projectId,
            taskId: task.id,
            topic,
            correct: isCorrect,
            artifactId,
          });
        }
      }
    } catch { /* non-critical */ }

    response.json(record satisfies CardPerformanceRecord);
  });

  router.get("/study-artifacts/:id/cards-for-review", (request, response) => {
    const artifactId = firstParam(request.params.id);
    response.json(
      runtime.db.getCardsForReview(artifactId) satisfies CardPerformanceRecord[]
    );
  });

  router.get("/study-artifacts/:id/weak-cards", (request, response) => {
    const artifactId = firstParam(request.params.id);
    response.json(
      runtime.db.getWeakCards(artifactId) satisfies CardPerformanceRecord[]
    );
  });

  // Aggregate weak/due cards across ALL flashcard decks for a task
  router.get("/tasks/:taskId/review-cards", (request, response) => {
    const taskId = firstParam(request.params.taskId);
    const artifacts = runtime.db.listStudyArtifacts(taskId).filter((a) => a.kind === "flashcards");
    const reviewCards: Array<{
      artifactId: string;
      artifactTitle: string;
      cardId: string;
      front: string;
      back: string;
      cue?: string;
      easeFactor: number;
      lastRating: string;
      nextReviewDate: string;
      reason: "due" | "weak";
    }> = [];

    for (const artifact of artifacts) {
      let parsed: { cards?: Array<{ id: string; front: string; back: string; cue?: string }> };
      try { parsed = JSON.parse(artifact.payload); } catch { continue; }
      if (!parsed.cards) continue;

      const dueCards = runtime.db.getCardsForReview(artifact.id);
      const weakCards = runtime.db.getWeakCards(artifact.id);
      const dueIds = new Set(dueCards.map((c) => c.cardId));
      const allPerfMap = new Map(
        [...dueCards, ...weakCards].map((c) => [c.cardId, c])
      );

      for (const card of parsed.cards) {
        const perf = allPerfMap.get(card.id);
        if (!perf) continue;
        const reason = dueIds.has(card.id) ? "due" as const : "weak" as const;
        reviewCards.push({
          artifactId: artifact.id,
          artifactTitle: artifact.title,
          cardId: card.id,
          front: card.front,
          back: card.back,
          cue: card.cue,
          easeFactor: perf.easeFactor,
          lastRating: perf.lastRating ?? "",
          nextReviewDate: perf.nextReviewDate ?? "",
          reason,
        });
      }
    }

    // Sort: due first, then by ease factor ascending (weakest first)
    reviewCards.sort((a, b) => {
      if (a.reason !== b.reason) return a.reason === "due" ? -1 : 1;
      return a.easeFactor - b.easeFactor;
    });

    response.json(reviewCards);
  });

  // Aggregate wrong quiz answers across ALL quizzes for a task
  router.get("/tasks/:taskId/review-questions", (request, response) => {
    const taskId = firstParam(request.params.taskId);
    const artifacts = runtime.db.listStudyArtifacts(taskId).filter((a) => a.kind === "quiz");
    const reviewQuestions: Array<{
      artifactId: string;
      artifactTitle: string;
      questionId: string;
      prompt: string;
      options: string[];
      answer: string;
      explanation: string;
      selectedAnswer: string;
    }> = [];

    for (const artifact of artifacts) {
      let parsed: { questions?: Array<{ id: string; prompt: string; options: string[]; answer: string; explanation?: string }> };
      try { parsed = JSON.parse(artifact.payload); } catch { continue; }
      if (!parsed.questions) continue;

      const perfRecords = runtime.db.listQuizPerformance(artifact.id);
      const wrongIds = new Set(perfRecords.filter((p) => !p.isCorrect).map((p) => p.questionId));
      const perfMap = new Map(perfRecords.map((p) => [p.questionId, p]));

      for (const q of parsed.questions) {
        if (!wrongIds.has(q.id)) continue;
        const perf = perfMap.get(q.id);
        reviewQuestions.push({
          artifactId: artifact.id,
          artifactTitle: artifact.title,
          questionId: q.id,
          prompt: q.prompt,
          options: q.options,
          answer: q.answer,
          explanation: q.explanation ?? "",
          selectedAnswer: perf?.selectedAnswer ?? "",
        });
      }
    }

    response.json(reviewQuestions);
  });

  // Upload a file to the task's staging area (transient by default).
  // Codex can read it during the turn. Pass ?persist=true to also copy to project root.
  router.post("/tasks/:taskId/upload-file", express.raw({ type: "application/octet-stream", limit: "80mb" }), asyncRoute(async (request, response) => {
    const taskId = firstParam(request.params.taskId);
    const legacyBody = Buffer.isBuffer(request.body) ? null : (request.body ?? {});
    const rawFilenameHeader = request.header("x-stuart-filename");
    const filename = sanitizeUploadedFilename(
      typeof rawFilenameHeader === "string" && rawFilenameHeader.trim() !== ""
        ? rawFilenameHeader
        : typeof legacyBody?.filename === "string"
          ? legacyBody.filename
          : ""
    );
    const persist = request.query.persist === "true";
    if (!filename) {
      response.status(400).send("A filename is required.");
      return;
    }
    const task = runtime.db.getTask(taskId);
    if (!task) { response.status(404).send("Task not found."); return; }

    const { writeFile, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");

    // Write to staging so Codex can read it during the turn
    const latestRun = runtime.listTaskRuns(taskId)[0];
    const stagingDir = latestRun?.stagingPath ?? join(runtime.dataDir, "staging", taskId);
    const destPath = join(stagingDir, "uploads", filename);
    await mkdir(join(stagingDir, "uploads"), { recursive: true });
    const buffer = Buffer.isBuffer(request.body)
      ? request.body
      : typeof legacyBody?.dataBase64 === "string"
        ? Buffer.from(legacyBody.dataBase64, "base64")
        : null;
    if (!buffer || buffer.length === 0) {
      response.status(400).send("Uploaded file body is empty.");
      return;
    }
    await writeFile(destPath, buffer);

    // Optionally persist to project root
    let persistedPath: string | undefined;
    if (persist) {
      const project = runtime.db.getProject(task.projectId);
      if (project?.rootPath) {
        persistedPath = join(project.rootPath, filename);
        await mkdir(project.rootPath, { recursive: true });
        await writeFile(persistedPath, buffer);
        void runtime.buildTaskIngestionIndex(taskId, { force: true }).catch(() => {});
      }
    }

    response.json({ path: destPath, size: buffer.length, persisted: persistedPath });
  }));

  router.post("/study-artifacts/:id/export-anki", (request, response) => {
    const artifactId = firstParam(request.params.id);
    const artifact = runtime.db.getStudyArtifact(artifactId);
    if (!artifact) {
      response.status(404).send("Study artifact not found.");
      return;
    }
    try {
      const data = JSON.parse(artifact.payload) as { cards?: Array<{ front: string; back: string; cue?: string }> };
      if (!data.cards || !Array.isArray(data.cards)) {
        response.status(400).send("Artifact is not a flashcard deck.");
        return;
      }
      const lines = data.cards.map((card) => {
        const front = card.front.replace(/\t/g, " ").replace(/\n/g, "<br>");
        const back = card.back.replace(/\t/g, " ").replace(/\n/g, "<br>");
        const tags = card.cue ? card.cue.replace(/\t/g, " ").replace(/\s+/g, "_") : "";
        return `${front}\t${back}\t${tags}`;
      });
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader("Content-Disposition", `attachment; filename="${artifact.title.replace(/[^a-zA-Z0-9-_ ]/g, "")}.txt"`);
      response.send(lines.join("\n"));
    } catch {
      response.status(500).send("Failed to export artifact.");
    }
  });

  // ---- Quiz Performance ----

  router.get("/study-artifacts/:id/quiz-performance", (request, response) => {
    const artifactId = firstParam(request.params.id);
    response.json(
      runtime.db.listQuizPerformance(artifactId) satisfies QuizPerformanceRecord[]
    );
  });

  router.post("/study-artifacts/:id/quiz-performance", (request, response) => {
    const artifactId = firstParam(request.params.id);
    const { questionId, attemptNumber, selectedAnswer, isCorrect, difficultyFlag } = request.body ?? {};
    if (!questionId || attemptNumber === undefined || isCorrect === undefined) {
      response.status(400).send("Quiz performance fields are required.");
      return;
    }
    const record = runtime.db.createQuizPerformance({
      artifactId,
      questionId,
      attemptNumber,
      selectedAnswer: selectedAnswer ?? null,
      isCorrect: Boolean(isCorrect),
      difficultyFlag: difficultyFlag ?? null,
    });

    // Auto-track topic performance
    try {
      const artifact = runtime.db.getStudyArtifact(artifactId);
      if (artifact) {
        const task = runtime.db.getTask(artifact.taskId);
        if (task) {
          const topic = extractTopic(artifact.title);
          runtime.db.upsertTopicPerformance({
            projectId: task.projectId,
            taskId: task.id,
            topic,
            correct: Boolean(isCorrect),
            artifactId,
          });
        }
      }
    } catch { /* non-critical */ }

    response.status(201).json(record satisfies QuizPerformanceRecord);
  });

  // ---- Study Artifact Update (for mindmap expand, etc.) ----

  router.patch("/study-artifacts/:id", (request, response) => {
    const artifactId = firstParam(request.params.id);
    const { payload } = request.body ?? {};
    if (!payload) {
      response.status(400).send("Payload is required.");
      return;
    }
    const updated = runtime.db.updateStudyArtifact(artifactId, typeof payload === "string" ? payload : JSON.stringify(payload));
    if (!updated) {
      response.status(404).send("Study artifact not found.");
      return;
    }
    response.json(updated satisfies StudyArtifactRecord);
  });

  // ---- Study Artifact Delete ----

  router.delete("/study-artifacts/:id", asyncRoute(async (request, response) => {
    const artifactId = firstParam(request.params.id);
    const result = runtime.db.deleteStudyArtifact(artifactId);
    if (!result.deleted) {
      response.status(404).send("Study artifact not found.");
      return;
    }
    // Clean up the file on disk if it exists
    if (result.filePath) {
      const { rm } = await import("node:fs/promises");
      await rm(result.filePath, { force: true }).catch(() => {});
    }
    if (result.previewPath && result.previewPath !== result.filePath) {
      const { rm } = await import("node:fs/promises");
      await rm(result.previewPath, { force: true }).catch(() => {});
    }
    response.json({ deleted: true });
  }));

  // ---- Document Download + Preview ----

  router.get("/study-artifacts/:id/download", asyncRoute(async (request, response) => {
    const artifact = runtime.db.getStudyArtifact(firstParam(request.params.id));
    if (!artifact) {
      response.status(404).send("Study artifact not found.");
      return;
    }

    const filePath = await runtime.ensureDocumentFile(artifact.id);
    if (!filePath) {
      response.status(500).send("Failed to generate document. Check server logs.");
      return;
    }

    const mimeTypes: Record<string, string> = {
      document_docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      document_xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      document_pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      document_pdf: "application/pdf",
    };

    const ext = artifact.kind.replace("document_", "");
    const safeName = (artifact.title || "document").replace(/[^a-zA-Z0-9_\- ]/g, "").replace(/\s+/g, "_");
    const mime = mimeTypes[artifact.kind] ?? "application/octet-stream";

    response.setHeader("Content-Type", mime);
    response.setHeader("Content-Disposition", `attachment; filename="${safeName}.${ext}"`);
    const { createReadStream } = await import("node:fs");
    createReadStream(filePath).pipe(response);
  }));

  router.get("/study-artifacts/:id/preview", asyncRoute(async (request, response) => {
    const artifact = runtime.db.getStudyArtifact(firstParam(request.params.id));
    if (!artifact) {
      response.status(404).send("Study artifact not found.");
      return;
    }

    const kind = artifact.kind;

    if (kind === "interactive") {
      try {
        const payload = JSON.parse(artifact.payload) as { html?: unknown; path?: unknown };
        const wrapHtml = (html: string) =>
          (!html.includes("<!DOCTYPE") && !html.includes("<html"))
            ? `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${html}</body></html>`
            : html;

        if (typeof payload.html === "string" && payload.html.trim()) {
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.send(wrapHtml(payload.html));
          return;
        }

        if (typeof payload.path === "string" && payload.path.trim()) {
          const { existsSync } = await import("node:fs");
          const { readFile } = await import("node:fs/promises");
          const { isAbsolute, resolve } = await import("node:path");

          const candidates: string[] = [];
          const requestedPath = payload.path.trim();
          if (isAbsolute(requestedPath)) {
            candidates.push(resolve(requestedPath));
          } else {
            for (const run of runtime.db.listTaskRuns(artifact.taskId)) {
              candidates.push(resolve(run.stagingPath, requestedPath));
            }
          }

          for (const candidate of candidates) {
            if (!existsSync(candidate)) {
              continue;
            }
            const html = await readFile(candidate, "utf8");
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.send(wrapHtml(html));
            return;
          }
        }
      } catch {
        // fall through to friendly error below
      }

      response
        .status(404)
        .setHeader("Content-Type", "text/html; charset=utf-8")
        .send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:80vh;color:#333;background:#f7f7f5}.box{max-width:440px;text-align:center}h2{margin:0 0 8px;font-size:1.2rem}p{color:#666;font-size:14px;line-height:1.5}</style></head><body><div class="box"><h2>Interactive preview unavailable</h2><p>Stuart found the artifact record, but could not resolve the generated HTML file for preview.</p></div></body></html>`);
      return;
    }

    // For document kinds, serve the persisted preview asset.
    if (kind.startsWith("document_")) {
      const previewPath = await runtime.ensureDocumentPreviewPath(artifact.id);
      const refreshed = runtime.db.getStudyArtifact(artifact.id) ?? artifact;

      if (previewPath) {
        if (kind === "document_pdf") {
          response.setHeader("Content-Type", "application/pdf");
          const { createReadStream } = await import("node:fs");
          createReadStream(previewPath).pipe(response);
          return;
        }

        response.setHeader("Content-Type", "text/html; charset=utf-8");
        const { readFile } = await import("node:fs/promises");
        response.send(await readFile(previewPath, "utf8"));
        return;
      }

      const title = kind.replace("document_", "").toUpperCase();
      if (refreshed.previewStatus === "failed" || refreshed.renderStatus === "failed") {
        response
          .status(500)
          .setHeader("Content-Type", "text/html; charset=utf-8")
          .send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:80vh;color:#333;background:#f7f7f5}.box{max-width:460px;text-align:center}h2{margin:0 0 8px;font-size:1.2rem;color:#B91C1C}p{color:#666;font-size:14px;line-height:1.5}</style></head><body><div class="box"><h2>${title} preview unavailable</h2><p>${escapeHtml(refreshed.previewError ?? refreshed.renderError ?? "Stuart could not prepare a preview for this document.")}</p></div></body></html>`);
        return;
      }

      response
        .status(503)
        .setHeader("Content-Type", "text/html; charset=utf-8")
        .send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:80vh;color:#333;background:#f7f7f5}.box{max-width:420px;text-align:center}.spin{display:inline-block;width:24px;height:24px;border:3px solid #e5e7eb;border-top-color:#2962FF;border-radius:50%;animation:s 0.8s linear infinite;margin-bottom:12px}@keyframes s{to{transform:rotate(360deg)}}</style></head><body><div class="box"><div class="spin"></div><h2>Preparing preview...</h2><p>Stuart is still generating the ${title} preview asset. Retry in a moment.</p></div></body></html>`);
      return;
    }

    // Final fallback
    response.setHeader("Content-Type", "application/json");
    response.send(artifact.payload);
  }));

  // ---- Mindmap Node Notes ----

  router.get("/study-artifacts/:id/node-notes", (request, response) => {
    const artifactId = firstParam(request.params.id);
    response.json(
      runtime.db.listNodeNotes(artifactId) satisfies MindMapNodeNote[]
    );
  });

  router.put("/study-artifacts/:id/node-notes/:nodeId", (request, response) => {
    const artifactId = firstParam(request.params.id);
    const nodeId = firstParam(request.params.nodeId);
    const { content } = request.body ?? {};
    if (typeof content !== "string") {
      response.status(400).send("Note content is required.");
      return;
    }
    if (content.trim() === "") {
      runtime.db.deleteNodeNote(artifactId, nodeId);
      response.status(204).end();
      return;
    }
    const note = runtime.db.upsertNodeNote({ artifactId, nodeId, content });
    response.json(note satisfies MindMapNodeNote);
  });

  // ---- Mock Exam Attempts ----

  router.get("/study-artifacts/:id/exam-attempts", (request, response) => {
    const artifactId = firstParam(request.params.id);
    response.json(
      runtime.db.listMockExamAttempts(artifactId) satisfies MockExamAttempt[]
    );
  });

  router.post("/study-artifacts/:id/exam-attempts", (request, response) => {
    const artifactId = firstParam(request.params.id);
    const { answers, totalMarks } = request.body ?? {};
    if (!answers || totalMarks === undefined) {
      response.status(400).send("Answers and totalMarks are required.");
      return;
    }
    const attempt = runtime.db.createMockExamAttempt({
      artifactId,
      answers: typeof answers === "string" ? answers : JSON.stringify(answers),
      totalMarks,
    });
    response.status(201).json(attempt satisfies MockExamAttempt);
  });

  router.patch("/study-artifacts/:id/exam-attempts/:attemptId", (request, response) => {
    const attemptId = firstParam(request.params.attemptId);
    const { answers, score, timeTakenSeconds, completedAt } = request.body ?? {};
    const updated = runtime.db.updateMockExamAttempt(attemptId, {
      answers: answers !== undefined ? (typeof answers === "string" ? answers : JSON.stringify(answers)) : undefined,
      score: score !== undefined ? Number(score) : undefined,
      timeTakenSeconds: timeTakenSeconds !== undefined ? Number(timeTakenSeconds) : undefined,
      completedAt: completedAt ?? undefined,
    });
    if (!updated) {
      response.status(404).send("Exam attempt not found.");
      return;
    }
    response.json(updated satisfies MockExamAttempt);
  });

  // ---- Learning Analytics ----

  router.get("/projects/:projectId/learning-summary", (request, response) => {
    const projectId = firstParam(request.params.projectId);
    response.json(
      runtime.db.getProjectLearningSummary(projectId) satisfies ProjectLearningSummary
    );
  });

  router.get("/projects/:projectId/weak-topics", (request, response) => {
    const projectId = firstParam(request.params.projectId);
    const limit = typeof request.query.limit === "string" ? Number(request.query.limit) : 10;
    response.json(
      runtime.db.listWeakTopics(projectId, Number.isFinite(limit) && limit > 0 ? limit : 10) satisfies TopicPerformanceRecord[]
    );
  });

  router.get("/projects/:projectId/study-timeline", (request, response) => {
    const projectId = firstParam(request.params.projectId);
    const days = typeof request.query.days === "string" ? Number(request.query.days) : 30;
    response.json(
      runtime.db.getStudyTimeline(projectId, Number.isFinite(days) && days > 0 ? days : 30) satisfies StudyTimelineEntry[]
    );
  });

  router.get("/tasks/:taskId/performance", (request, response) => {
    const taskId = firstParam(request.params.taskId);
    response.json(
      runtime.db.getTaskPerformanceBreakdown(taskId) satisfies TaskPerformanceBreakdown
    );
  });

  // ---- Curriculum ----

  router.get("/tasks/:taskId/curriculum", asyncRoute(async (request, response) => {
    const taskId = firstParam(request.params.taskId);
    const task = runtime.db.getTask(taskId);
    if (!task) {
      response.status(404).send("Task not found.");
      return;
    }
    const project = runtime.db.getProject(task.projectId);
    if (!project) {
      response.status(404).send("Project not found.");
      return;
    }

    const { existsSync } = await import("node:fs");
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");

    // Try project root first, then staging
    const roots = [project.rootPath];
    const latestRun = runtime.db.listTaskRuns(taskId)[0];
    if (latestRun) roots.push(latestRun.stagingPath);

    let spec = null;
    let progress = null;

    for (const root of roots) {
      // Check for curriculum.json first, fall back to curriculum.md existence
      const specPath = join(root, "curriculum.json");
      if (!spec && existsSync(specPath)) {
        try {
          spec = JSON.parse(await readFile(specPath, "utf8"));
        } catch { /* ignore */ }
      }
      if (!spec && existsSync(join(root, "curriculum.md"))) {
        // curriculum.md exists but no JSON spec — mark as existing but without structured data
        spec = { title: "Curriculum", phases: [] };
      }
      const progressPath = join(root, "curriculum-progress.json");
      if (!progress && existsSync(progressPath)) {
        try {
          progress = JSON.parse(await readFile(progressPath, "utf8"));
        } catch { /* ignore */ }
      }
    }

    if (!spec) {
      response.json({ exists: false });
      return;
    }

    // Initialize progress if it doesn't exist yet
    if (!progress && spec.phases?.length) {
      progress = {
        currentPhase: spec.phases[0].id,
        phases: Object.fromEntries(
          spec.phases.map((p: { id: string }, i: number) => [
            p.id,
            { status: i === 0 ? "in_progress" : "locked", checkpoints: {} }
          ])
        )
      };
    }

    response.json({ exists: true, spec, progress });
  }));

  router.patch("/tasks/:taskId/curriculum/progress", asyncRoute(async (request, response) => {
    const taskId = firstParam(request.params.taskId);
    const task = runtime.db.getTask(taskId);
    if (!task) {
      response.status(404).send("Task not found.");
      return;
    }
    const project = runtime.db.getProject(task.projectId);
    if (!project) {
      response.status(404).send("Project not found.");
      return;
    }

    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const progressData = request.body;
    if (!progressData || !progressData.currentPhase) {
      response.status(400).send("Progress data with currentPhase is required.");
      return;
    }

    // Write to project root
    const progressPath = join(project.rootPath, "curriculum-progress.json");
    await writeFile(progressPath, JSON.stringify(progressData, null, 2));

    // Also write to staging if a run exists
    const latestRun = runtime.db.listTaskRuns(taskId)[0];
    if (latestRun) {
      const stagingPath = join(latestRun.stagingPath, "curriculum-progress.json");
      await writeFile(stagingPath, JSON.stringify(progressData, null, 2)).catch(() => {});
    }

    response.json(progressData);
  }));

  // ---- Study Sessions ----

  router.post("/tasks/:taskId/study-sessions", (request, response) => {
    const taskId = firstParam(request.params.taskId);
    const task = runtime.db.getTask(taskId);
    if (!task) {
      response.status(404).send("Task not found.");
      return;
    }
    const { artifactIds } = request.body ?? {};
    const session = runtime.db.createStudySession({
      taskId,
      projectId: task.projectId,
      artifactIds: Array.isArray(artifactIds) ? artifactIds : undefined,
    });
    response.status(201).json(session satisfies StudySessionRecord);
  });

  router.patch("/study-sessions/:sessionId", (request, response) => {
    const sessionId = firstParam(request.params.sessionId);
    const { endedAt, cardsReviewed, questionsAnswered, correctCount, artifactIdsJson } = request.body ?? {};
    const updated = runtime.db.updateStudySession(sessionId, {
      endedAt: endedAt ?? undefined,
      cardsReviewed: cardsReviewed !== undefined ? Number(cardsReviewed) : undefined,
      questionsAnswered: questionsAnswered !== undefined ? Number(questionsAnswered) : undefined,
      correctCount: correctCount !== undefined ? Number(correctCount) : undefined,
      artifactIdsJson: artifactIdsJson ?? undefined,
    });
    if (!updated) {
      response.status(404).send("Study session not found.");
      return;
    }

    // When a session ends, extract performance data into student memories
    if (endedAt && updated.artifactIdsJson) {
      try {
        const artifactIds = JSON.parse(updated.artifactIdsJson) as string[];
        const task = runtime.db.getTask(updated.taskId);
        if (task) {
          for (const artifactId of artifactIds) {
            const artifact = runtime.db.getStudyArtifact(artifactId);
            if (!artifact) continue;

            const topic = extractTopic(artifact.title);

            if (artifact.kind === "flashcards") {
              const cards = runtime.db.listCardPerformance(artifactId);
              if (cards.length >= 3) {
                const total = cards.reduce((s, c) => s + c.totalReviews, 0);
                const correct = cards.reduce((s, c) => s + c.correctCount, 0);
                const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;
                const status = accuracy >= 90 ? "mastered" : accuracy >= 70 ? "understands" : accuracy >= 40 ? "learning" : "struggling";
                runtime.db.createStudentMemory({
                  scopeType: "project",
                  scopeId: task.projectId,
                  category: "progress",
                  topic,
                  memoryKey: `progress-cards-${topic}`,
                  content: `Flashcard accuracy on ${topic}: ${accuracy}% (${correct}/${total}). Status: ${status}.`,
                  sourceKind: "card_review",
                });
              }
            }

            if (artifact.kind === "quiz") {
              const results = runtime.db.listQuizPerformance(artifactId);
              if (results.length >= 3) {
                const correct = results.filter((r) => r.isCorrect).length;
                const accuracy = Math.round((correct / results.length) * 100);
                const status = accuracy >= 90 ? "mastered" : accuracy >= 70 ? "understands" : accuracy >= 40 ? "learning" : "struggling";
                runtime.db.createStudentMemory({
                  scopeType: "project",
                  scopeId: task.projectId,
                  category: "progress",
                  topic,
                  memoryKey: `progress-quiz-${topic}`,
                  content: `Quiz accuracy on ${topic}: ${accuracy}% (${correct}/${results.length}). Status: ${status}.`,
                  sourceKind: "quiz_result",
                });
              }
            }
          }
        }
      } catch { /* non-critical */ }
    }

    response.json(updated satisfies StudySessionRecord);
  });

  return router;
}

function broadcastEvent(eventClients: Set<express.Response>, event: WorkspaceEvent): void {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of eventClients) {
    client.write(data);
  }
}

function asyncRoute(
  handler: (
    request: express.Request,
    response: express.Response,
    next: express.NextFunction
  ) => Promise<void>
) {
  return (request: express.Request, response: express.Response, next: express.NextFunction) => {
    void handler(request, response, next).catch(next);
  };
}

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function sanitizeUploadedFilename(filename: string): string {
  const trimmed = filename.trim();
  if (!trimmed) {
    return "";
  }

  const leaf = trimmed
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001f<>:"|?*]/g, "_")
    .trim();

  if (!leaf || leaf === "." || leaf === "..") {
    return "";
  }

  return leaf;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function safeSystemDiagnostics(runtime: StuartRuntime) {
  try {
    return await runtime.getSystemDiagnostics();
  } catch (error) {
    return {
      generatedAt: new Date().toISOString(),
      overallStatus: "warn" as const,
      requiredReady: true,
      checks: [
        {
          id: "diagnostics-runtime",
          label: "System diagnostics",
          status: "warn" as const,
          required: false,
          summary: "Diagnostics could not be collected.",
          detail: error instanceof Error ? error.message : String(error),
          resolution: "Run `pnpm preflight` in the repo root for a direct terminal check.",
        }
      ]
    };
  }
}

async function safeVmStatus(runtime: StuartRuntime) {
  try {
    return await runtime.getVmStatus();
  } catch (error) {
    return {
      state: "stopped" as const,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

function safeProjects(runtime: StuartRuntime) {
  try {
    return runtime.listProjects();
  } catch {
    return [];
  }
}

function safeTasks(runtime: StuartRuntime) {
  try {
    return runtime.listTasks();
  } catch {
    return [];
  }
}
