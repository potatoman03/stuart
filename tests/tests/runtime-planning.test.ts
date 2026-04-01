import { describe, expect, it } from "vitest";
import type { TaskSpec } from "@stuart/shared";
import { buildTurnExecutionPlan, resolveTaskRuntimeProfile } from "../../packages/runtime-supervisor/src/runtime-planning.ts";

function buildTask(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Study session",
    objective: "Help me study the workspace.",
    globalInstructionProfileId: "default",
    folderInstructionIds: [],
    attachments: [],
    networkPolicyId: "ask",
    authMode: "chatgpt",
    runtimeProfile: {
      provider: "codex",
      authMode: "chatgpt",
      model: "gpt-5.4-mini",
      native: false,
    },
    browserEnabled: false,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("runtime planning", () => {
  it("preserves a native provider profile while falling back to Codex transport defaults", () => {
    const task = buildTask({
      authMode: "api_key",
      runtimeProfile: {
        provider: "gemini",
        authMode: "api_key",
        model: "gemini-2.5-pro",
        native: true,
      },
    });

    const profile = resolveTaskRuntimeProfile(task);
    const plan = buildTurnExecutionPlan({
      task,
      message: "Explain the scheduler tradeoffs in this lecture.",
      skills: [],
      isLargeMaterialSet: false,
      hasTargetedFiles: false,
      defaultTurnStallMs: 120_000,
      complexTurnStallMs: 300_000,
    });

    expect(profile.provider).toBe("gemini");
    expect(profile.model).toBe("gemini-2.5-pro");
    expect(plan.threadModel).toBe("gpt-5.4-mini");
  });

  it("uses the selected Codex model as the thread default", () => {
    const task = buildTask({
      runtimeProfile: {
        provider: "codex",
        authMode: "chatgpt",
        model: "gpt-5.4",
        native: false,
      },
    });

    const plan = buildTurnExecutionPlan({
      task,
      message: "Build me a detailed interactive simulation from these notes.",
      skills: [{ id: "interactive", match: () => true, priority: 10 }],
      isLargeMaterialSet: false,
      hasTargetedFiles: false,
      defaultTurnStallMs: 120_000,
      complexTurnStallMs: 300_000,
    });

    expect(plan.threadModel).toBe("gpt-5.4");
    expect(plan.effort).toBe("high");
  });

  it("only enables explore workers for broad large-workspace turns without skill routing", () => {
    const task = buildTask();

    const broadPlan = buildTurnExecutionPlan({
      task,
      message: "Help me understand the important themes across everything here.",
      skills: [],
      isLargeMaterialSet: true,
      hasTargetedFiles: false,
      defaultTurnStallMs: 120_000,
      complexTurnStallMs: 300_000,
    });
    const skillPlan = buildTurnExecutionPlan({
      task,
      message: "Create a study doc from this folder.",
      skills: [{ id: "study-doc", match: () => true, priority: 10 }],
      isLargeMaterialSet: true,
      hasTargetedFiles: false,
      defaultTurnStallMs: 120_000,
      complexTurnStallMs: 300_000,
    });

    expect(broadPlan.shouldSpawnExploreWorkers).toBe(true);
    expect(skillPlan.shouldSpawnExploreWorkers).toBe(false);
  });
});
