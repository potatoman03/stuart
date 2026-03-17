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
  QuizPerformanceRecord,
  StudyArtifactRecord,
  TaskMessageRecord,
  TaskWorkerRecord,
  UpdateTaskInput,
  VmStatus,
  WorkspaceEvent
} from "@stuart/shared";

export interface StuartHarnessOptions {
  dataDir: string;
  vmHelperBinaryPath?: string;
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
};

export class StuartHarness {
  readonly runtime: StuartRuntime;
  readonly vm: VmHelperClient;

  constructor(options: StuartHarnessOptions) {
    this.runtime =
      options.runtime ??
      new StuartRuntime({
        dataDir: options.dataDir,
        vmHelperBinaryPath: options.vmHelperBinaryPath
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

  router.get("/dashboard", asyncRoute(async (_request, response) => {
    response.json({
      vmStatus: await runtime.getVmStatus(),
      projects: runtime.listProjects(),
      tasks: runtime.listTasks()
    } satisfies DashboardPayload);
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
