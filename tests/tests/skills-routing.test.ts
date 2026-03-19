import { describe, expect, it } from "vitest";
import { matchSkill, matchSkills } from "../../packages/runtime-supervisor/src/skills";

describe("skill routing", () => {
  it("does not mistake ordinary source questions for document generation", () => {
    expect(matchSkill("What does this PDF say about page replacement?", true)).toBeNull();
    expect(matchSkill("Summarize the lecture slides for me.", true)).toBeNull();
  });

  it("selects scripted document generation when sandbox execution is available", () => {
    expect(matchSkill("Create a cheat sheet PDF for chapter 3.", true)?.id).toBe("document-pdf-scripted");
    expect(matchSkill("Build a PowerPoint slide deck on virtual memory.", true)?.id).toBe("document-pptx-scripted");
  });

  it("falls back to JSON document skills when sandbox execution is unavailable", () => {
    expect(matchSkill("Create a cheat sheet PDF for chapter 3.", false)?.id).toBe("document-pdf");
    expect(matchSkill("Create an Excel comparison table for cache policies.", false)?.id).toBe("document-xlsx");
  });

  it("combines research with the primary artifact skill for multi-step asks", () => {
    expect(
      matchSkills("Research operating systems from scratch and create a quiz on processes.", true).map(
        (skill) => skill.id
      )
    ).toEqual(["research", "quiz"]);
  });

  it("prefers the interactive skill for explicit simulator requests", () => {
    expect(matchSkill("Build an interactive simulator for page replacement.", true)?.id).toBe("interactive");
  });

  it("matches polite interactive requests without explicit build verbs", () => {
    expect(
      matchSkill("I would like an interactive DFS and BFS visualiser.", true)?.id
    ).toBe("interactive");
  });

  it("matches typo-tolerant and terse interactive requests", () => {
    expect(
      matchSkill("i wouldlike a interactive DFS and BFS visualiser", true)?.id
    ).toBe("interactive");
    expect(
      matchSkill("interactive a* search visualiser", true)?.id
    ).toBe("interactive");
  });
});
