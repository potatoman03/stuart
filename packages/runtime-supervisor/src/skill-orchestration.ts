import type { Skill } from "./skills.js";

export type SkillWorkerPlan = {
  role: string;
  label: string;
  objective: string;
};

function hasSkill(skills: Skill[], ...ids: string[]) {
  return skills.some((skill) => ids.includes(skill.id));
}

export function buildSkillWorkerPlans(question: string, skills: Skill[]): SkillWorkerPlan[] {
  const plans: SkillWorkerPlan[] = [];

  if (hasSkill(skills, "interactive")) {
    plans.push(
      {
        role: "concept-grounder",
        label: "Grounding interactive concept",
        objective: [
          `Review the workspace materials for this interactive request: "${question}".`,
          "Extract the exact concepts, rules, equations, constraints, and worked examples that the final artifact must preserve.",
          "Write a concise grounded brief to `.stuart/worker-briefs/interactive-grounding.md` with source names and locators.",
          "Do not design UI yet; focus on subject accuracy and evidence."
        ].join(" "),
      },
      {
        role: "interaction-designer",
        label: "Planning interaction model",
        objective: [
          `Plan the interaction model for this requested study artifact: "${question}".`,
          "Define the controls, state transitions, failure cases, and what the student should be able to explore.",
          "Write the plan to `.stuart/worker-briefs/interactive-design.md` as a compact build brief the main agent can follow."
        ].join(" "),
      }
    );
  }

  if (hasSkill(skills, "study-doc")) {
    plans.push(
      {
        role: "note-architect",
        label: "Planning study document",
        objective: [
          `Create a high-quality outline for this study document request: "${question}".`,
          "Map the major sections, the concepts that belong in each section, and where worked examples or equations are needed.",
          "Write the outline to `.stuart/worker-briefs/study-doc-outline.md`."
        ].join(" "),
      },
      {
        role: "citation-curator",
        label: "Curating study doc evidence",
        objective: [
          `Gather the strongest supporting evidence for this study document request: "${question}".`,
          "List the best sources, locators, and short excerpts to support each planned section.",
          "Write the evidence map to `.stuart/worker-briefs/study-doc-citations.md`."
        ].join(" "),
      }
    );
  }

  if (hasSkill(skills, "document-pptx")) {
    plans.push(
      {
        role: "deck-planner",
        label: "Planning slide deck",
        objective: [
          `Plan a presentation deck for this request: "${question}".`,
          "Create a slide-by-slide brief with title, layout, key points, and evidence expectations.",
          "Write the deck brief to `.stuart/worker-briefs/pptx-deck-plan.md`."
        ].join(" "),
      },
      {
        role: "slide-curator",
        label: "Curating slide evidence",
        objective: [
          `Find the strongest visual and factual evidence for this presentation request: "${question}".`,
          "Map source-backed material to the slide plan and identify which slides need comparisons, tables, or diagrams.",
          "Write the source mapping to `.stuart/worker-briefs/pptx-slide-briefs.md`."
        ].join(" "),
      }
    );
  }

  if (hasSkill(skills, "document-docx")) {
    plans.push({
      role: "doc-architect",
      label: "Planning Word document",
      objective: [
        `Plan the structure for this Word document request: "${question}".`,
        "Define sections, paragraph styles, tables/callouts, and citation placement.",
        "Write the brief to `.stuart/worker-briefs/docx-plan.md`."
      ].join(" "),
    });
  }

  if (hasSkill(skills, "document-xlsx")) {
    plans.push({
      role: "sheet-planner",
      label: "Planning spreadsheet",
      objective: [
        `Plan the workbook structure for this spreadsheet request: "${question}".`,
        "Define worksheets, columns, formulas, charts, and provenance expectations.",
        "Write the brief to `.stuart/worker-briefs/xlsx-plan.md`."
      ].join(" "),
    });
  }

  return plans;
}
