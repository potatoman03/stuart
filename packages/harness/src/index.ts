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

  app.use(express.json());
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

    const taskId = firstParam(request.params.taskId);
    const result = await runtime.sendTaskMessage(taskId, content);
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

  router.post("/tasks/:taskId/study-artifacts", (request, response) => {
    const { kind, title, payload } = request.body ?? {};
    if (!kind || !title || !payload) {
      response.status(400).send("Study artifact kind, title, and payload are required.");
      return;
    }
    const taskId = firstParam(request.params.taskId);
    const artifact = runtime.db.createStudyArtifact({ taskId, kind, title, payload });
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

    // For document kinds, always try to render the binary first
    if (kind.startsWith("document_")) {
      const filePath = await runtime.ensureDocumentFile(artifact.id);

      // PDF — serve the binary (browser renders natively in iframe)
      if (kind === "document_pdf" && filePath) {
        response.setHeader("Content-Type", "application/pdf");
        const { createReadStream } = await import("node:fs");
        createReadStream(filePath).pipe(response);
        return;
      }

      // DOCX — convert binary to HTML via mammoth
      if (kind === "document_docx" && filePath) {
        try {
          const mammoth = await import("mammoth");
          const { readFile } = await import("node:fs/promises");
          const buffer = await readFile(filePath);
          const result = await mammoth.convertToHtml({ buffer });
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;max-width:800px;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#333}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f5f5f5}</style></head><body>${result.value}</body></html>`);
          return;
        } catch { /* fall through to HTML preview */ }
      }

      // XLSX — convert binary to HTML via xlsx
      if (kind === "document_xlsx" && filePath) {
        try {
          const XLSX = await import("xlsx");
          const workbook = XLSX.readFile(filePath);
          const sheets = workbook.SheetNames.map((name) => {
            const html = XLSX.utils.sheet_to_html(workbook.Sheets[name]!);
            return `<h2>${name}</h2>${html}`;
          }).join("");
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem;color:#333}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f5f5f5;font-weight:600}</style></head><body>${sheets}</body></html>`);
          return;
        } catch { /* fall through */ }
      }

      // PPTX — render HTML cards from JSON payload
      if (kind === "document_pptx") {
        try {
          const data = JSON.parse(artifact.payload) as { presentation?: { slides?: Array<Record<string, unknown>> } };
          const slides = data.presentation?.slides ?? (data as unknown as { slides?: Array<Record<string, unknown>> }).slides ?? [];
          const slideHtml = slides.map((slide, i) => {
            const layout = slide.layout as string;
            const title = (slide.title as string) ?? "";
            let body = "";
            if (layout === "content") {
              const bullets = (slide.bullets as string[]) ?? [];
              body = `<ul>${bullets.map((b) => `<li>${b}</li>`).join("")}</ul>`;
            } else if (layout === "two_column") {
              const left = (slide.left as string[]) ?? [];
              const right = (slide.right as string[]) ?? [];
              body = `<div style="display:flex;gap:2rem"><div style="flex:1"><ul>${left.map((b) => `<li>${b}</li>`).join("")}</ul></div><div style="flex:1"><ul>${right.map((b) => `<li>${b}</li>`).join("")}</ul></div></div>`;
            } else if (layout === "table") {
              const headers = (slide.headers as string[]) ?? [];
              const rows = (slide.rows as string[][]) ?? [];
              body = `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${headers.map((_, ci) => `<td>${r[ci] ?? ""}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
            } else if (layout === "title") {
              body = slide.subtitle ? `<p style="color:#666;font-size:1.1rem">${slide.subtitle}</p>` : "";
            } else if (layout === "sources") {
              const entries = (slide.entries as string[]) ?? [];
              body = `<ul style="font-size:0.9rem;color:#555">${entries.map((e) => `<li>${e}</li>`).join("")}</ul>`;
            }
            return `<div class="slide"><div class="slide-num">Slide ${i + 1}</div><h3>${title}</h3>${body}</div>`;
          }).join("");
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#333}.slide{background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:1.5rem;margin:1rem 0;box-shadow:0 1px 3px rgba(0,0,0,0.08)}.slide-num{font-size:0.75rem;color:#999;margin-bottom:0.5rem}table{border-collapse:collapse;width:100%;margin:0.5rem 0}th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}th{background:#f5f5f5}</style></head><body>${slideHtml}</body></html>`);
          return;
        } catch { /* fall through */ }
      }

      // Fallback: render an HTML preview from JSON payload (only for JSON-schema artifacts)
      try {
        const data = JSON.parse(artifact.payload) as Record<string, unknown>;

        // Script-based artifact with no rendered file
        if (data.script) {
          const ext = kind.replace("document_", "").toUpperCase();
          const retryCount = Number(request.query.retry) || 0;

          // Allow up to 3 auto-retries (9 seconds total), then show error
          if (retryCount < 3) {
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:80vh;color:#333;text-align:center}.box{max-width:400px}h2{margin:0 0 8px;font-size:1.2rem}p{color:#666;font-size:14px;line-height:1.5}.spin{display:inline-block;width:24px;height:24px;border:3px solid #e5e7eb;border-top-color:#2962FF;border-radius:50%;animation:s 0.8s linear infinite;margin-bottom:12px}@keyframes s{to{transform:rotate(360deg)}}</style></head><body><div class="box"><div class="spin"></div><h2>Generating ${ext}...</h2><p>The document is being rendered. This page will refresh automatically.</p></div><script>setTimeout(()=>{const u=new URL(location.href);u.searchParams.set("retry",${retryCount + 1});location.replace(u)},3000)</script></body></html>`);
            return;
          }

          // Retries exhausted — show error with manual retry
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:80vh;color:#333;text-align:center}.box{max-width:440px}h2{margin:0 0 8px;font-size:1.2rem;color:#B91C1C}p{color:#666;font-size:14px;line-height:1.5}a,button{color:#2962FF;text-decoration:none;font-weight:600;cursor:pointer;background:none;border:none;font-size:14px}a:hover,button:hover{text-decoration:underline}.sep{margin:12px 0;border:none;border-top:1px solid #e5e7eb}</style></head><body><div class="box"><h2>${ext} generation failed</h2><p>The sandbox couldn't produce the document. This usually means the generated script had an error. Try asking Stuart to regenerate it.</p><hr class="sep"/><button onclick="location.href=location.pathname">Retry</button> · <a href="/api/study-artifacts/${artifact.id}/download">Try download</a></div></body></html>`);
          return;
        }

        // JSON-schema artifact fallback
        const sections = (data.document as Record<string, unknown>)?.sections ?? data.sections;
        if (Array.isArray(sections) && sections.length > 0) {
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.send(renderPdfPayloadAsHtml(artifact.title, sections as Array<Record<string, unknown>>));
          return;
        }
      } catch { /* fall through */ }
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

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderPdfPayloadAsHtml(title: string, sections: Array<Record<string, unknown>>): string {
  const headingTag: Record<number, string> = { 1: "h2", 2: "h3", 3: "h4" };

  function renderPara(para: Record<string, unknown>): string {
    const type = para.type as string;
    const content = escHtml((para.content as string) ?? "");

    switch (type) {
      case "text":
        return `<p>${content}</p>`;
      case "bullet":
        return `<li>${content}</li>`;
      case "numbered":
        return `<li>${content}</li>`;
      case "definition":
        return `<div class="def"><strong>${escHtml((para.term as string) ?? "")}</strong> ${escHtml((para.definition as string) ?? "")}</div>`;
      case "kv": {
        const entries = (para.entries as Array<{ key: string; value: string }>) ?? [];
        return `<div class="kv">${entries.map((e) => `<div class="kv-row"><span class="kv-key">${escHtml(e.key)}</span><span class="kv-val">${escHtml(e.value)}</span></div>`).join("")}</div>`;
      }
      case "table": {
        const headers = (para.headers as string[]) ?? [];
        const rows = (para.rows as string[][]) ?? [];
        return `<table><thead><tr>${headers.map((h) => `<th>${escHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${headers.map((_, ci) => `<td>${escHtml(String(r[ci] ?? ""))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      }
      case "math":
        return `<div class="math${(para.display as boolean) ? " display" : ""}">${content}</div>`;
      case "code":
        return `<pre class="code">${content}</pre>`;
      case "callout":
        return `<div class="callout callout-${(para.style as string) ?? "info"}">${content}</div>`;
      case "quote":
        return `<blockquote>${content}</blockquote>`;
      case "divider":
        return `<hr/>`;
      case "citation_note":
        return `<div class="cite">${content}</div>`;
      default:
        return `<p>${content}</p>`;
    }
  }

  let body = "";
  for (const section of sections) {
    const tag = headingTag[(section.level as number) ?? 1] ?? "h2";
    body += `<${tag}>${escHtml((section.heading as string) ?? "")}</${tag}>`;
    const paragraphs = (section.paragraphs as Array<Record<string, unknown>>) ?? [];
    // Wrap consecutive bullets/numbered in ul/ol
    let inList: string | null = null;
    for (const para of paragraphs) {
      const type = para.type as string;
      if (type === "bullet" && inList !== "ul") {
        if (inList) body += `</${inList}>`;
        body += "<ul>";
        inList = "ul";
      } else if (type === "numbered" && inList !== "ol") {
        if (inList) body += `</${inList}>`;
        body += "<ol>";
        inList = "ol";
      } else if (type !== "bullet" && type !== "numbered" && inList) {
        body += `</${inList}>`;
        inList = null;
      }
      body += renderPara(para);
    }
    if (inList) body += `</${inList}>`;
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:system-ui,sans-serif;max-width:860px;margin:1.5rem auto;padding:0 1.5rem;color:#1a1a2e;font-size:14px;line-height:1.5}
h1{font-size:1.4rem;border-bottom:2px solid #2962FF;padding-bottom:4px;margin:1.2rem 0 0.6rem}
h2{font-size:1.15rem;color:#16213e;border-left:3px solid #2962FF;padding-left:8px;margin:1rem 0 0.4rem}
h3{font-size:1rem;color:#0f3460;margin:0.8rem 0 0.3rem}
h4{font-size:0.9rem;color:#333;margin:0.6rem 0 0.2rem}
p{margin:0.3rem 0}
ul,ol{margin:0.2rem 0 0.4rem 1.2rem;padding:0}
li{margin:0.15rem 0}
table{border-collapse:collapse;width:100%;margin:0.5rem 0;font-size:13px}
th{background:#2962FF;color:#fff;font-weight:600;padding:5px 8px;text-align:left}
td{border:1px solid #dee2e6;padding:4px 8px}
tr:nth-child(even){background:#f8f9fa}
blockquote{border-left:3px solid #6b7280;margin:0.4rem 0;padding:4px 12px;color:#4b5563;font-style:italic}
.math{font-family:monospace;color:#5b21b6;background:#f5f3ff;border:1px solid #c4b5fd;border-radius:4px;padding:4px 8px;margin:0.3rem 0}
.math.display{text-align:center;font-size:1.05em}
.code{font-family:monospace;background:#1e293b;color:#e2e8f0;border-radius:4px;padding:6px 10px;margin:0.3rem 0;font-size:12px;overflow-x:auto}
.callout{border-radius:4px;padding:6px 10px;margin:0.3rem 0;font-weight:600;font-size:13px}
.callout-info{background:#ebf5ff;border-left:3px solid #3b82f6;color:#1e40af}
.callout-tip{background:#ecfdf5;border-left:3px solid #10b981;color:#065f46}
.callout-warning{background:#fffbeb;border-left:3px solid #f59e0b;color:#92400e}
.callout-important{background:#fef2f2;border-left:3px solid #ef4444;color:#991b1b}
.def{margin:0.2rem 0}
.def strong{color:#1e40af;margin-right:6px}
.kv{margin:0.3rem 0}
.kv-row{display:flex;gap:8px;margin:1px 0;font-size:13px}
.kv-key{font-weight:600;color:#374151;min-width:100px;flex-shrink:0}
.kv-val{color:#555}
.cite{font-size:11px;color:#9ca3af;font-style:italic;margin:0.2rem 0}
hr{border:none;border-top:1px dashed #e5e7eb;margin:0.6rem 0}
</style></head><body><h1>${escHtml(title)}</h1>${body}</body></html>`;
}
