import type { Skill } from "./skills.js";

export type SkillWorkerPlan = {
  role: string;
  label: string;
  objective: string;
  model?: string;
};

function hasSkill(skills: Skill[], ...ids: string[]) {
  return skills.some((skill) => ids.includes(skill.id));
}

export function buildSkillWorkerPlans(question: string, skills: Skill[]): SkillWorkerPlan[] {
  const plans: SkillWorkerPlan[] = [];

  if (hasSkill(skills, "interactive")) {
    const isStudyGrounded = /\b(from|using|based on|about|explain|teach|concept|lecture|chapter|topic)\b/i.test(question);
    if (isStudyGrounded) {
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
        label: "Planning presentation structure",
        model: "gpt-5.4-nano",
        objective: [
          `Plan the deck structure for this presentation request: "${question}".`,
          "Determine the number of slides, the type of each slide (cover, toc, section_divider, content, summary), key messages per slide, and visual flow.",
          "Write the plan to `.stuart/worker-briefs/pptx-deck-plan.md`."
        ].join(" "),
      },
      {
        role: "content-researcher",
        label: "Gathering slide content from materials",
        model: "gpt-5.4-nano",
        objective: [
          `Search workspace materials for key facts, quotes, data points, and examples relevant to this presentation request: "${question}".`,
          "Extract and organize these into slide-ready content briefs with source references and locators.",
          "Write to `.stuart/worker-briefs/pptx-content-brief.md`."
        ].join(" "),
      },
      {
        role: "design-advisor",
        label: "Choosing presentation design",
        model: "gpt-5.4-nano",
        objective: [
          `Based on the topic and audience for this presentation request: "${question}",`,
          "recommend a color palette (primary, secondary, accent colors), font pairing, and visual style.",
          "Write to `.stuart/worker-briefs/pptx-design-brief.md`."
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
