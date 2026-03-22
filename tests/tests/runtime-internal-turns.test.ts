import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

describe("StuartRuntime internal turns", () => {
  it("does not persist quiz validation output as a visible assistant message", async () => {
    const dataDir = await createTempDir("stuart-runtime-internal-");
    const runtime = new StuartRuntime({ dataDir });

    try {
      await runtime.bootstrap();
      const project = runtime.createProject({ name: "Course", rootPath: dataDir });
      const task = runtime.createTask({
        projectId: project.id,
        title: "Quiz review",
        objective: "Review quiz quality.",
        attachments: [],
      });

      const turnId = "quiz-validation-turn";
      const threadId = "quiz-validation-thread";
      (runtime as unknown as {
        turns: Map<string, Record<string, unknown>>;
      }).turns.set(turnId, {
        taskId: task.id,
        threadId,
        turnId,
        startedAt: new Date().toISOString(),
        lastActivityAt: Date.now(),
        kind: "worker",
        assistantText: "",
        thinkingLabel: "Checking quiz accuracy",
        startedEmitted: false,
        quizValidation: {
          artifactId: "artifact-1",
          originalPayload: JSON.stringify({ questions: [] }),
        },
      });

      await (runtime as unknown as {
        handleCodexNotification: (notification: { method: string; params?: unknown }) => Promise<void>;
      }).handleCodexNotification({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            id: "assistant-item-1",
            type: "agentMessage",
            text: "[]",
          },
        },
      });

      const messages = runtime.listTaskMessages(task.id);
      expect(messages.filter((message) => message.role === "assistant")).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });
});
