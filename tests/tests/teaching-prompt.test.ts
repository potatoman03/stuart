import { describe, expect, it } from "vitest";
import type { ProjectRecord, TaskSpec } from "@stuart/shared";
import { buildTeachingInstructions } from "@stuart/runtime-supervisor";

describe("buildTeachingInstructions", () => {
  it("frames Stuart as a concise domain-expert study companion", () => {
    const project: ProjectRecord = {
      id: "project-1",
      name: "CS2106",
      rootPath: "/tmp/cs2106",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const task: TaskSpec = {
      id: "task-1",
      projectId: project.id,
      title: "OS revision",
      objective: "Help me revise operating systems",
      globalInstructionProfileId: "default",
      folderInstructionIds: [],
      attachments: [],
      networkPolicyId: "default",
      authMode: "chatgpt",
      browserEnabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const prompt = buildTeachingInstructions(project, task);

    expect(prompt).toContain("study companion, guide, and subject-matter expert");
    expect(prompt).toContain("Act like a strong domain expert");
    expect(prompt).toContain("Be concise, effective, and digestible by default.");
    expect(prompt).toContain("Start with the direct answer or core takeaway");
    expect(prompt).toContain("Avoid walls of text");
    expect(prompt).toContain("clean mental model first");
  });
});
