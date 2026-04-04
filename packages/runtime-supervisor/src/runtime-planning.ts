import type { TaskRuntimeProfile, TaskSpec } from "@stuart/shared";
import { DEFAULT_TASK_RUNTIME_PROFILE } from "@stuart/shared";
import type { Skill } from "./skills.js";

export type TurnExecutionPlan = {
  requestedProfile: TaskRuntimeProfile;
  threadModel: string;
  turnModel?: string;
  effort: "low" | "medium" | "high";
  stallTimeoutMs: number;
  needsFlagship: boolean;
  shouldSpawnExploreWorkers: boolean;
  shouldSpawnResearchWorkers: boolean;
};

export type WorkerExecutionPlan = {
  threadModel: string;
  effort: "medium" | "high";
};

type BuildTurnExecutionPlanInput = {
  task: TaskSpec;
  message: string;
  skills: Skill[];
  isLargeMaterialSet: boolean;
  hasTargetedFiles: boolean;
  defaultTurnStallMs: number;
  complexTurnStallMs: number;
};

export function resolveTaskRuntimeProfile(task: Pick<TaskSpec, "runtimeProfile" | "authMode">): TaskRuntimeProfile {
  const provider = task.runtimeProfile?.provider ?? DEFAULT_TASK_RUNTIME_PROFILE.provider;
  return {
    provider,
    authMode: task.runtimeProfile?.authMode ?? task.authMode ?? fallbackAuthMode(provider),
    model: task.runtimeProfile?.model ?? defaultModelForProvider(provider),
    native: task.runtimeProfile?.native ?? (provider !== "codex" && provider !== "cursor"),
  };
}

export function buildTurnExecutionPlan(input: BuildTurnExecutionPlanInput): TurnExecutionPlan {
  const requestedProfile = resolveTaskRuntimeProfile(input.task);
  const threadModel =
    requestedProfile.provider === "codex" || requestedProfile.provider === "cursor"
      ? requestedProfile.model
      : DEFAULT_TASK_RUNTIME_PROFILE.model;
  const isResearch = input.skills.some((skill) => skill.id === "research");
  const isCodeGen = input.skills.some((skill) => skill.id === "interactive");
  const isArtifactTurn = input.skills.some((skill) => skill.id !== "research");
  const needsFlagship = input.skills.some((skill) => skill.requiresSandbox);
  const isSimpleQuery = /^explain|^what is|^define|^describe|^tell me about/i.test(input.message.trim())
    && input.message.trim().length < 200;

  const turnModel = needsFlagship
    ? "gpt-5.4"
    : (requestedProfile.provider === "codex" || requestedProfile.provider === "cursor") &&
        requestedProfile.model !== threadModel
      ? requestedProfile.model
      : undefined;
  const effort = needsFlagship ? "high"
    : (isResearch || isCodeGen) ? "high"
    : isSimpleQuery ? "low"
    : input.isLargeMaterialSet && !input.hasTargetedFiles ? "high"
    : "medium";
  const stallTimeoutMs =
    isResearch || isArtifactTurn || input.isLargeMaterialSet
      ? input.complexTurnStallMs
      : input.defaultTurnStallMs;

  return {
    requestedProfile,
    threadModel,
    turnModel,
    effort,
    stallTimeoutMs,
    needsFlagship,
    shouldSpawnExploreWorkers:
      input.isLargeMaterialSet
      && !input.hasTargetedFiles
      && !isSimpleQuery
      && !isResearch
      && input.skills.length === 0,
    shouldSpawnResearchWorkers: isResearch,
  };
}

export function buildWorkerExecutionPlan(
  task: Pick<TaskSpec, "runtimeProfile" | "authMode">,
  requestedModel?: string
): WorkerExecutionPlan {
  const requestedProfile = resolveTaskRuntimeProfile(task);
  return {
    threadModel:
      requestedProfile.provider === "codex"
        ? (requestedModel ?? requestedProfile.model)
        : DEFAULT_TASK_RUNTIME_PROFILE.model,
    effort:
      requestedModel === "gpt-5.4" || requestedProfile.model === "gpt-5.4"
        ? "high"
        : "medium",
  };
}

function fallbackAuthMode(provider: TaskRuntimeProfile["provider"]): TaskRuntimeProfile["authMode"] {
  if (provider === "codex") {
    return "chatgpt";
  }
  if (provider === "cursor") {
    return "oauth";
  }
  return "api_key";
}

function defaultModelForProvider(provider: TaskRuntimeProfile["provider"]): string {
  if (provider === "gemini") {
    return "gemini-2.5-flash";
  }
  if (provider === "minimax") {
    return "MiniMax-M2.7";
  }
  if (provider === "cursor") {
    return "composer-2-fast";
  }
  return DEFAULT_TASK_RUNTIME_PROFILE.model;
}
