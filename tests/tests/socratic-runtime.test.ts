import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceEvent } from "@stuart/shared";
import { StuartRuntime } from "@stuart/runtime-supervisor";

const createdPaths: string[] = [];

async function createTempDir(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createStubbedRuntime() {
  const dataDir = await createTempDir("stuart-socratic-data-");
  const workspaceRoot = await createTempDir("stuart-socratic-workspace-");
  await mkdir(workspaceRoot, { recursive: true });

  const runtime = new StuartRuntime({ dataDir, workspaceRoot });
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];

  const codex = (runtime as unknown as {
    codex: {
      ensureReady: () => Promise<void>;
      request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
      close: () => Promise<void>;
    };
  }).codex;
  codex.ensureReady = async () => {};
  codex.request = async (method: string, params: Record<string, unknown>) => {
    requests.push({ method, params });
    if (method === "thread/start") {
      return { thread: { id: "thread-1" } };
    }
    if (method === "turn/start") {
      return { turn: { id: `turn-${requests.filter((entry) => entry.method === "turn/start").length}` } };
    }
    if (method === "thread/resume") {
      return {};
    }
    return {};
  };
  codex.close = async () => {};

  const sandbox = runtime.sandbox as unknown as {
    isAvailable: () => Promise<boolean>;
    close: () => Promise<void>;
  };
  sandbox.isAvailable = async () => false;
  sandbox.close = async () => {};

  (runtime as unknown as {
    resolveTaskExecutionContext: (task: unknown) => Promise<{ cwd: string; taskRun: null; preparedRun: null }>;
    buildRetrievedContext: () => Promise<string | null>;
    stageSkillBundleAssets: () => Promise<void>;
  }).resolveTaskExecutionContext = async () => ({
    cwd: workspaceRoot,
    taskRun: null,
    preparedRun: null,
  });
  (runtime as unknown as {
    buildRetrievedContext: () => Promise<string | null>;
  }).buildRetrievedContext = async () => null;
  (runtime as unknown as {
    stageSkillBundleAssets: () => Promise<void>;
  }).stageSkillBundleAssets = async () => {};

  await runtime.bootstrap();
  return { runtime, workspaceRoot, requests };
}

describe("Socratic runtime flow", () => {
  it("injects Socratic turn policy and forks thread instructions for Socratic workspaces", async () => {
    const { runtime, workspaceRoot, requests } = await createStubbedRuntime();
    try {
      const project = runtime.createProject({
        name: "OS",
        rootPath: workspaceRoot,
        config: { teachingStyle: "Socratic" },
      });
      const task = runtime.createTask({
        projectId: project.id,
        title: "Study",
        objective: "Learn OS",
        attachments: [],
      });

      await runtime.sendTaskMessage(task.id, "What is priority inheritance?");

      const threadStart = requests.find((entry) => entry.method === "thread/start");
      expect(threadStart).toBeTruthy();
      expect(String(threadStart?.params.developerInstructions ?? "")).toContain("Do NOT lead with the final answer");

      const turnStart = requests.find((entry) => entry.method === "turn/start");
      const input = (turnStart?.params.input ?? []) as Array<{ text?: string }>;
      expect(input.some((item) => item.text?.includes("## Turn tutoring policy"))).toBe(true);
      expect(input.some((item) => item.text?.includes("Current hint level: 0"))).toBe(true);

      const turns = (runtime as unknown as { turns: Map<string, { socratic?: { active: boolean; hintLevel: number } }> }).turns;
      const activeTurn = [...turns.values()][0];
      expect(activeTurn?.socratic?.active).toBe(true);
      expect(activeTurn?.socratic?.hintLevel).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("requires two direct-answer requests before enabling direct override", async () => {
    const { runtime, workspaceRoot, requests } = await createStubbedRuntime();
    try {
      const project = runtime.createProject({
        name: "OS",
        rootPath: workspaceRoot,
        config: { teachingStyle: "Socratic" },
      });
      const task = runtime.createTask({
        projectId: project.id,
        title: "Study",
        objective: "Learn OS",
        attachments: [],
      });

      await runtime.sendTaskMessage(task.id, "just explain priority inheritance");

      let turns = (runtime as unknown as {
        turns: Map<string, { socratic?: { hintLevel: number; directOverride: boolean } }>;
      }).turns;
      let firstTurn = [...turns.values()][0];
      expect(firstTurn?.socratic?.hintLevel).toBe(2);
      expect(firstTurn?.socratic?.directOverride).toBe(false);
      expect(
        requests.some((entry) =>
          entry.method === "turn/start"
          && Array.isArray(entry.params.input)
          && (entry.params.input as Array<{ text?: string }>).some((item) => item.text?.includes("add one speed bump first"))
        )
      ).toBe(true);

      turns.clear();
      requests.length = 0;

      await runtime.sendTaskMessage(task.id, "no seriously just explain it");
      turns = (runtime as unknown as {
        turns: Map<string, { socratic?: { hintLevel: number; directOverride: boolean } }>;
      }).turns;
      const secondTurn = [...turns.values()][0];
      expect(secondTurn?.socratic?.hintLevel).toBe(4);
      expect(secondTurn?.socratic?.directOverride).toBe(true);
      expect(
        requests.some((entry) =>
          entry.method === "turn/start"
          && Array.isArray(entry.params.input)
          && (entry.params.input as Array<{ text?: string }>).some((item) => item.text?.includes("You may explain directly now"))
        )
      ).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("does not persist a one-off coach-me request across a new question in normal workspaces", async () => {
    const { runtime, workspaceRoot } = await createStubbedRuntime();
    try {
      const project = runtime.createProject({
        name: "OS",
        rootPath: workspaceRoot,
      });
      const task = runtime.createTask({
        projectId: project.id,
        title: "Study",
        objective: "Learn OS",
        attachments: [],
      });

      await runtime.sendTaskMessage(task.id, "coach me through this");
      let turns = (runtime as unknown as {
        turns: Map<string, { socratic?: { active: boolean } }>;
      }).turns;
      expect([...turns.values()][0]?.socratic?.active).toBe(true);

      turns.clear();

      await runtime.sendTaskMessage(task.id, "What is a process?");
      turns = (runtime as unknown as {
        turns: Map<string, { socratic?: { active: boolean } }>;
      }).turns;
      expect([...turns.values()][0]?.socratic).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it("suppresses streamed deltas and sanitizes leaked completions on low-level Socratic hints", async () => {
    const { runtime, workspaceRoot } = await createStubbedRuntime();
    try {
      const project = runtime.createProject({
        name: "OS",
        rootPath: workspaceRoot,
      });
      const task = runtime.createTask({
        projectId: project.id,
        title: "Study",
        objective: "Learn OS",
        attachments: [],
      });

      const events: WorkspaceEvent[] = [];
      const unsubscribe = runtime.onEvent((event) => events.push(event));
      try {
        (runtime as unknown as {
          turns: Map<string, Record<string, unknown>>;
        }).turns.set("turn-1", {
          taskId: task.id,
          threadId: "thread-1",
          turnId: "turn-1",
          startedAt: new Date().toISOString(),
          lastActivityAt: Date.now(),
          kind: "task",
          assistantText: "",
          thinkingLabel: "Thinking",
          startedEmitted: true,
          socratic: {
            active: true,
            hintLevel: 1,
            exchangeAttempts: 1,
            directOverride: false,
          },
        });

        await (runtime as unknown as {
          handleCodexNotification: (notification: { method: string; params?: unknown }) => Promise<void>;
        }).handleCodexNotification({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "assistant-item-1",
            delta: "The answer is priority inheritance.",
          },
        });

        expect(events.some((event) => event.type === "codex.message.delta")).toBe(false);

        await (runtime as unknown as {
          handleCodexNotification: (notification: { method: string; params?: unknown }) => Promise<void>;
        }).handleCodexNotification({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "assistant-item-1",
              type: "agentMessage",
              text: "The answer is priority inheritance.",
            },
          },
        });

        const assistantMessages = runtime.listTaskMessages(task.id).filter((message) => message.role === "assistant");
        expect(assistantMessages).toHaveLength(1);
        expect(assistantMessages[0]?.content).toBe(
          "Think about the kind of idea this is testing first. Which category of rule or method seems relevant here?"
        );
      } finally {
        unsubscribe();
      }
    } finally {
      await runtime.close();
    }
  });

  it("resets Socratic carry-over state after a direct-answer turn completes", async () => {
    const { runtime, workspaceRoot } = await createStubbedRuntime();
    try {
      const project = runtime.createProject({
        name: "OS",
        rootPath: workspaceRoot,
      });
      const task = runtime.createTask({
        projectId: project.id,
        title: "Study",
        objective: "Learn OS",
        attachments: [],
      });

      (runtime as unknown as {
        turns: Map<string, Record<string, unknown>>;
        socraticStates: Map<string, { hintLevel: number; exchangeAttempts: number; directRequestCount: number }>;
      }).turns.set("turn-2", {
        taskId: task.id,
        threadId: "thread-1",
        turnId: "turn-2",
        startedAt: new Date().toISOString(),
        lastActivityAt: Date.now(),
        kind: "task",
        assistantText: "Direct answer.",
        thinkingLabel: "Thinking",
        startedEmitted: true,
        socratic: {
          active: true,
          hintLevel: 4,
          exchangeAttempts: 3,
          directOverride: true,
        },
      });

      await (runtime as unknown as {
        handleCodexNotification: (notification: { method: string; params?: unknown }) => Promise<void>;
      }).handleCodexNotification({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-2",
            status: "completed",
          },
        },
      });

      const socraticStates = (runtime as unknown as {
        socraticStates: Map<string, { hintLevel: number; exchangeAttempts: number; directRequestCount: number }>;
      }).socraticStates;
      expect(socraticStates.get(task.id)).toEqual({
        hintLevel: 0,
        exchangeAttempts: 0,
        directRequestCount: 0,
      });
    } finally {
      await runtime.close();
    }
  });
});
