import { describe, expect, it } from "vitest";
import { listSkillBundleAssets, matchSkill, resolveSkillPrompt } from "../../packages/runtime-supervisor/src/skills";

describe("skill bundles", () => {
  it("loads the bundled interactive prompt with layered references", () => {
    const skill = matchSkill("Build an interactive BFS visualiser for lecture 2.", true);
    expect(skill?.id).toBe("interactive");
    const prompt = resolveSkillPrompt(skill!, "Build an interactive BFS visualiser for lecture 2.");
    expect(prompt).toContain("Skill Bundle: Interactive Study Artifact");
    expect(prompt).toContain("Grounding requirements");
    expect(prompt).toContain("Interaction and visual quality");
  });

  it("loads repo-analysis guidance only when research mentions repositories", () => {
    const skill = matchSkill("Research this GitHub repo and build a curriculum from it.", true);
    expect(skill?.id).toBe("research");
    const prompt = resolveSkillPrompt(skill!, "Research this GitHub repo and build a curriculum from it.");
    expect(prompt).toContain("GitHub / repository analysis");
  });

  it("exposes staged template assets for bundled document skills", () => {
    const skill = matchSkill("Build a PowerPoint slide deck on virtual memory.", true);
    expect(skill?.id).toBe("document-pptx");
    const assets = listSkillBundleAssets(skill!);
    expect(assets.some((asset) => asset.relativePath === "templates/slide-brief.md")).toBe(true);
  });

  it("loads detailed DOCX/XLSX/PPTX schema guidance in bundled prompts", () => {
    const docxSkill = matchSkill("Build a Word study guide on BFS.", true);
    const xlsxSkill = matchSkill("Build an Excel workbook for simplex tableau steps.", true);
    const pptxSkill = matchSkill("Build a PowerPoint deck on adversarial search.", true);

    expect(docxSkill?.id).toBe("document-docx");
    expect(xlsxSkill?.id).toBe("document-xlsx");
    expect(pptxSkill?.id).toBe("document-pptx");

    const docxPrompt = resolveSkillPrompt(docxSkill!, "Build a Word study guide on BFS.");
    const xlsxPrompt = resolveSkillPrompt(xlsxSkill!, "Build an Excel workbook for simplex tableau steps.");
    const pptxPrompt = resolveSkillPrompt(pptxSkill!, "Build a PowerPoint deck on adversarial search.");

    expect(docxPrompt).toContain('"type": "definition"');
    expect(docxPrompt).toContain('"type": "svg"');
    expect(docxPrompt).toContain('"type": "kv"');
    expect(xlsxPrompt).toContain('"sourceNotes"');
    expect(xlsxPrompt).toContain('"formula"');
    expect(pptxPrompt).toContain('"layout": "two_column"');
    expect(pptxPrompt).toContain('"layout": "diagram"');
    expect(pptxPrompt).toContain('"notes"');
  });

  it("keeps non-migrated flat skills asset-free", () => {
    const skill = matchSkill("Quiz me on chapter 1.", true);
    expect(skill?.id).toBe("quiz");
    expect(listSkillBundleAssets(skill!)).toEqual([]);
  });
});
