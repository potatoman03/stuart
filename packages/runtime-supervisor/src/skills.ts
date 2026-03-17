/**
 * Study artifact generation skills.
 *
 * Each skill is a focused prompt loaded from a .md file and injected into the
 * Codex turn context when the student's message matches the intent pattern.
 * This keeps the base system prompt lean and gives each artifact type
 * dedicated, high-quality instructions.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSkillFile(filename: string): string {
  // In dev, skills are in src/skills/; in dist, they're copied alongside
  // Try multiple paths to be resilient
  const candidates = [
    join(__dirname, "skills", filename),
    join(__dirname, "..", "src", "skills", filename),
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      continue;
    }
  }
  return "";
}

export interface Skill {
  id: string;
  /** Regex pattern to match against the user's message (case-insensitive) */
  pattern: RegExp;
  /** The full skill prompt injected as context before the user message */
  prompt: string;
}

export const STUDY_SKILLS: Skill[] = [
  {
    id: "flashcards",
    pattern: /\b(flashcard|flash card|study card|review card|cloze|fill.in.the.blank|anki)s?\b/i,
    prompt: loadSkillFile("flashcards.md"),
  },
  {
    id: "quiz",
    pattern: /\b(quiz|test me|test my|multiple choice|mcq|assessment)\b/i,
    prompt: loadSkillFile("quiz.md"),
  },
  {
    id: "mindmap",
    pattern: /\b(mind\s*map|concept\s*map|topic\s*map)\b/i,
    prompt: loadSkillFile("mindmap.md"),
  },
  {
    id: "diagram",
    pattern: /\b(diagram|flowchart|flow chart|process diagram|sequence diagram|visuali[sz]e)\b/i,
    prompt: loadSkillFile("diagram.md"),
  },
  {
    id: "mock-exam",
    pattern: /\b(mock\s*exam|past\s*paper|practice\s*exam|sample\s*exam|mock\s*test)\b/i,
    prompt: loadSkillFile("mock-exam.md"),
  },
  {
    id: "interactive",
    pattern: /\b(interactive|visuali[sz]er?|simulator?|simulation|explorable|playground|app|widget)\b/i,
    prompt: loadSkillFile("interactive.md"),
  },
];

/**
 * Match a user message against skills and return the best matching skill,
 * or null if no skill matches.
 */
export function matchSkill(message: string): Skill | null {
  for (const skill of STUDY_SKILLS) {
    if (skill.pattern.test(message)) {
      return skill;
    }
  }
  return null;
}
