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
  /** Whether this skill requires the Docker sandbox to execute */
  requiresSandbox?: boolean;
  /** Whether this skill writes new files that need re-indexing after the turn */
  triggersReindex?: boolean;
}

export const STUDY_SKILLS: Skill[] = [
  {
    id: "research",
    pattern: /\b(research|curriculum|get\s+me\s+up\s+to\s+speed|from\s+the\s+ground\s+up|from\s+scratch|find\s+materials?|gather\s+(?:resources|materials?|sources)|build\s+(?:me\s+)?a\s+(?:learning|study)\s*(?:plan|path)|learn\s+(?:about|everything)|teach\s+me\s+(?:about|everything)|deep\s*dive|explore\s+the\s+topic|i\s+don'?t\s+know\s+anything|crash\s*course|comprehensive\s+guide|study\s+(?:plan|guide|roadmap))\b/i,
    prompt: loadSkillFile("research.md"),
    triggersReindex: true,
  },
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
  {
    id: "document-pdf-scripted",
    pattern: /\b(pdf|cheat\s*sheet|reference\s*card|formula\s*sheet|printable)\b/i,
    prompt: loadSkillFile("document-pdf-scripted.md"),
    requiresSandbox: true,
  },
  {
    id: "document-docx-scripted",
    pattern: /\b(word\s*doc|\.docx|study\s*guide|revision\s*notes|summary\s*document|handout|write\s+\w*\s*document)\b/i,
    prompt: loadSkillFile("document-docx-scripted.md"),
    requiresSandbox: true,
  },
  {
    id: "document-xlsx-scripted",
    pattern: /\b(spreadsheet|\.xlsx|excel|comparison\s*table|data\s*table|tabulate)\b/i,
    prompt: loadSkillFile("document-xlsx-scripted.md"),
    requiresSandbox: true,
  },
  {
    id: "document-pptx-scripted",
    pattern: /\b(presentation|\.pptx|powerpoint|slide\s*deck|lecture\s*slides)\b/i,
    prompt: loadSkillFile("document-pptx-scripted.md"),
    requiresSandbox: true,
  },
];

/**
 * Match a user message against skills and return the best matching skill,
 * or null if no skill matches.
 */
export function matchSkill(message: string, sandboxAvailable = false): Skill | null {
  for (const skill of STUDY_SKILLS) {
    if (skill.requiresSandbox && !sandboxAvailable) {
      continue;
    }
    if (skill.pattern.test(message)) {
      return skill;
    }
  }
  return null;
}
