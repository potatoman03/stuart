/**
 * Study artifact generation skills.
 *
 * Each skill is a focused prompt loaded from a .md file and injected into the
 * Codex turn context when the student's message matches the intent pattern.
 * This keeps the base system prompt lean and gives each artifact type
 * dedicated, high-quality instructions.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSkillAsset(relativePath: string): string {
  // In dev, skills are in src/skills/; in dist, they're copied alongside
  // Try multiple paths to be resilient
  const candidates = [
    join(__dirname, "skills", relativePath),
    join(__dirname, "..", "src", "skills", relativePath),
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      continue;
    }
  }
  process.stderr.write(`[stuart] failed to load skill asset: ${relativePath}\n`);
  return "";
}

export interface Skill {
  id: string;
  /** Match the skill against the user's message. */
  match: (message: string) => boolean;
  /** A static prompt for flat-file skills. */
  prompt?: string;
  /** A bundle-aware prompt builder for migrated skills. */
  buildPrompt?: (message: string) => string;
  /** Relative skill bundle directory under src/skills. */
  bundleDir?: string;
  /** Whether this skill requires the Docker sandbox to execute */
  requiresSandbox?: boolean;
  /** Whether this skill writes new files that need re-indexing after the turn */
  triggersReindex?: boolean;
  /** Higher wins when multiple skills match. */
  priority: number;
}

type SkillBundleReference = {
  filename: string;
  includeByDefault?: boolean;
  when?: (message: string) => boolean;
};

type SkillBundleDefinition = {
  dir: string;
  references?: SkillBundleReference[];
};

const BUNDLED_SKILLS: Record<string, SkillBundleDefinition> = {
  research: {
    dir: "research",
    references: [
      { filename: "references/provenance.md", includeByDefault: true },
      {
        filename: "references/source-dossiers.md",
        includeByDefault: true,
      },
      {
        filename: "references/repo-analysis.md",
        when: (message) => /\bgithub|repo|repository|readme|codebase\b/i.test(message),
      },
    ],
  },
  interactive: {
    dir: "interactive",
    references: [
      { filename: "references/grounding.md", includeByDefault: true },
      { filename: "references/visual-quality.md", includeByDefault: true },
    ],
  },
  "study-doc": {
    dir: "study-doc",
    references: [
      { filename: "references/citations.md", includeByDefault: true },
      { filename: "references/blocks.md", includeByDefault: true },
    ],
  },
  "document-docx": {
    dir: "document-docx",
    references: [
      { filename: "references/layout.md", includeByDefault: true },
      { filename: "references/ooxml.md", includeByDefault: true },
    ],
  },
  "document-xlsx": {
    dir: "document-xlsx",
    references: [
      { filename: "references/sheets.md", includeByDefault: true },
      { filename: "references/ooxml.md", includeByDefault: true },
    ],
  },
  "document-pptx": {
    dir: "document-pptx",
    references: [
      { filename: "references/deck-planning.md", includeByDefault: true },
      { filename: "references/ooxml.md", includeByDefault: true },
    ],
  },
};

function loadBundledSkillPrompt(bundleId: string, message: string): string {
  const bundle = BUNDLED_SKILLS[bundleId];
  if (!bundle) {
    return "";
  }

  const core = loadSkillAsset(join(bundle.dir, "SKILL.md"));
  const refs = (bundle.references ?? [])
    .filter((reference) => reference.includeByDefault || reference.when?.(message))
    .map((reference) => loadSkillAsset(join(bundle.dir, reference.filename)))
    .filter(Boolean);

  return [core, ...refs].filter(Boolean).join("\n\n");
}

function bundleDirForSkill(bundleId: string): string | null {
  const bundle = BUNDLED_SKILLS[bundleId];
  if (!bundle) {
    return null;
  }

  const candidates = [
    join(__dirname, "skills", bundle.dir),
    join(__dirname, "..", "src", "skills", bundle.dir),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function resolveSkillPrompt(skill: Skill, message: string): string {
  if (skill.buildPrompt) {
    return skill.buildPrompt(message);
  }
  return skill.prompt ?? "";
}

export function listSkillBundleAssets(skill: Skill): Array<{ absolutePath: string; relativePath: string }> {
  if (!skill.bundleDir) {
    return [];
  }

  const bundleRoot = bundleDirForSkill(skill.bundleDir);
  if (!bundleRoot) {
    return [];
  }

  const assetEntries: Array<{ absolutePath: string; relativePath: string }> = [];
  for (const folderName of ["templates", "scripts"]) {
    const folderPath = join(bundleRoot, folderName);
    if (!existsSync(folderPath)) {
      continue;
    }
    const stack = [folderPath];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const absolutePath = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(absolutePath);
          continue;
        }
        if (entry.isFile()) {
          assetEntries.push({
            absolutePath,
            relativePath: absolutePath.slice(bundleRoot.length + 1),
          });
        }
      }
    }
  }

  return assetEntries;
}

const CREATE_INTENT =
  /\b(create|make|build|generate|draft|produce|write|design|prepare|assemble|export|turn|convert)\b/i;
const EDIT_INTENT =
  /\b(edit|update|revise|improve|expand|rewrite|fix|polish|reformat|add|fill|clean up)\b/i;
const RESEARCH_INTENT =
  /\b(research|find\s+materials?|gather\s+(?:resources|materials?|sources)|build\s+(?:me\s+)?a\s+(?:learning|study)\s*(?:plan|path|roadmap|curriculum)|get\s+me\s+up\s+to\s+speed|from\s+scratch|deep\s*dive|crash\s*course|comprehensive\s+guide|curriculum)\b/i;

function normalizeSkillMessage(message: string) {
  return message
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .replace(/\bwouldlike\b/gi, "would like")
    .replace(/\s+/g, " ")
    .trim();
}

function hasCreateLikeIntent(message: string) {
  const normalized = normalizeSkillMessage(message);
  return CREATE_INTENT.test(normalized) || EDIT_INTENT.test(normalized);
}

function mentionsAny(message: string, pattern: RegExp) {
  return pattern.test(normalizeSkillMessage(message));
}

function artifactRequest(message: string, pattern: RegExp) {
  return mentionsAny(message, pattern) && hasCreateLikeIntent(message);
}

function politeArtifactRequest(message: string, pattern: RegExp) {
  const normalized = normalizeSkillMessage(message);
  return /\b(i\s+(?:would|'d)?\s+like|i\s+want|can\s+you|could\s+you|please)\b/i.test(normalized)
    && pattern.test(normalized);
}

function terseArtifactRequest(message: string, pattern: RegExp) {
  const normalized = normalizeSkillMessage(message);
  if (!pattern.test(normalized)) {
    return false;
  }
  if (/\b(what|why|how|when|where|which|who|does|do|did|is|are|was|were|can|could|should)\b/i.test(normalized)) {
    return false;
  }
  if (normalized.split(/\s+/).length > 12) {
    return false;
  }
  return true;
}

function directStudyQuizRequest(message: string) {
  return /\b(quiz me|test me|give me a quiz|practice questions?|multiple choice questions?|mcq)\b/i.test(message);
}

function directDiagramRequest(message: string) {
  return /\b(diagram this|visuali[sz]e this|map this out|show me a diagram|draw a diagram)\b/i.test(message);
}

function directMindmapRequest(message: string) {
  return /\b(mind\s*map this|concept\s*map this|map out the topic)\b/i.test(message);
}

function documentRequest(message: string, pattern: RegExp) {
  return mentionsAny(message, pattern) && (
    hasCreateLikeIntent(message) ||
    /\b(save as|export as|turn .* into|convert .* to)\b/i.test(message)
  );
}

export const STUDY_SKILLS: Skill[] = [
  {
    id: "research",
    match: (message) => RESEARCH_INTENT.test(message),
    buildPrompt: (message) => loadBundledSkillPrompt("research", message),
    bundleDir: "research",
    triggersReindex: true,
    priority: 40,
  },
  {
    id: "flashcards",
    match: (message) =>
      artifactRequest(message, /\b(flashcard|flash card|study card|review card|cloze|fill[- ]in[- ]the[- ]blank|anki)s?\b/i)
      || politeArtifactRequest(message, /\b(flashcard|flash card|study card|review card|cloze|anki)s?\b/i)
      || terseArtifactRequest(message, /\b(flashcard|flash card|study card|review card|cloze|anki)s?\b/i),
    prompt: loadSkillAsset("flashcards.md"),
    priority: 80,
  },
  {
    id: "quiz",
    match: (message) =>
      directStudyQuizRequest(message) ||
      artifactRequest(message, /\b(quiz|multiple choice|mcq|assessment|practice test)\b/i)
      || politeArtifactRequest(message, /\b(quiz|multiple choice|mcq|assessment|practice test)\b/i)
      || terseArtifactRequest(message, /\b(quiz|multiple choice|mcq|assessment|practice test)\b/i),
    prompt: loadSkillAsset("quiz.md"),
    priority: 82,
  },
  {
    id: "mindmap",
    match: (message) =>
      directMindmapRequest(message) ||
      artifactRequest(message, /\b(mind\s*map|concept\s*map|topic\s*map)\b/i)
      || politeArtifactRequest(message, /\b(mind\s*map|concept\s*map|topic\s*map)\b/i)
      || terseArtifactRequest(message, /\b(mind\s*map|concept\s*map|topic\s*map)\b/i),
    prompt: loadSkillAsset("mindmap.md"),
    priority: 79,
  },
  {
    id: "diagram",
    match: (message) =>
      directDiagramRequest(message) ||
      artifactRequest(message, /\b(diagram|flowchart|flow chart|process diagram|sequence diagram|state diagram|visuali[sz]e)\b/i)
      || politeArtifactRequest(message, /\b(diagram|flowchart|flow chart|process diagram|sequence diagram|state diagram)\b/i)
      || terseArtifactRequest(message, /\b(diagram|flowchart|flow chart|process diagram|sequence diagram|state diagram)\b/i),
    prompt: loadSkillAsset("diagram.md"),
    priority: 78,
  },
  {
    id: "study-doc",
    match: (message) =>
      artifactRequest(message, /\b(study\s*doc(?:ument)?|write\s*notes|create\s*notes|note[- ]taking|study\s*notes|rich\s*document|editable\s*doc)\b/i)
      || politeArtifactRequest(message, /\b(study\s*doc(?:ument)?|study\s*notes|rich\s*document|editable\s*doc|note[- ]taking)\b/i)
      || terseArtifactRequest(message, /\b(study\s*doc(?:ument)?|study\s*notes|rich\s*document|editable\s*doc|note[- ]taking)\b/i),
    buildPrompt: (message) => loadBundledSkillPrompt("study-doc", message),
    bundleDir: "study-doc",
    priority: 83,
  },
  {
    id: "mock-exam",
    match: (message) =>
      artifactRequest(message, /\b(mock\s*exam|past\s*paper|practice\s*exam|sample\s*exam|mock\s*test)\b/i)
      || politeArtifactRequest(message, /\b(mock\s*exam|practice\s*exam|sample\s*exam|mock\s*test)\b/i)
      || terseArtifactRequest(message, /\b(mock\s*exam|past\s*paper|practice\s*exam|sample\s*exam|mock\s*test)\b/i),
    prompt: loadSkillAsset("mock-exam.md"),
    priority: 85,
  },
  {
    id: "interactive",
    match: (message) =>
      artifactRequest(message, /\b(interactive|visuali[sz]er?|simulator?|simulation|explorable|playground|widget)\b/i) ||
      politeArtifactRequest(message, /\b(interactive|visuali[sz]er?|simulator?|simulation|explorable|playground|widget)\b/i) ||
      terseArtifactRequest(message, /\b(interactive|visuali[sz]er?|simulator?|simulation|explorable|playground|widget)\b/i) ||
      /\b(build|make|create)\b.*\b(interactive|simulator?|simulation|visuali[sz]er?|playground)\b/i.test(message),
    buildPrompt: (message) => loadBundledSkillPrompt("interactive", message),
    bundleDir: "interactive",
    priority: 90,
  },
  {
    id: "document-pdf",
    match: (message) =>
      documentRequest(message, /\b(pdf|cheat\s*sheet|reference\s*card|formula\s*sheet|printable)\b/i),
    prompt: loadSkillAsset("document-pdf.md"),
    priority: 92,
  },
  {
    id: "document-docx",
    match: (message) =>
      documentRequest(message, /\b(word\s*doc(?:ument)?|\.docx|docx|study\s*guide|revision\s*notes|summary\s*document|handout)\b/i),
    buildPrompt: (message) => loadBundledSkillPrompt("document-docx", message),
    bundleDir: "document-docx",
    priority: 71,
  },
  {
    id: "document-xlsx",
    match: (message) =>
      documentRequest(message, /\b(spreadsheet|\.xlsx|xlsx|excel|comparison\s*table|data\s*table|tabulate)\b/i),
    buildPrompt: (message) => loadBundledSkillPrompt("document-xlsx", message),
    bundleDir: "document-xlsx",
    priority: 71,
  },
  {
    id: "document-pptx",
    match: (message) =>
      documentRequest(message, /\b(presentation|\.pptx|pptx|powerpoint|slide\s*deck)\b/i),
    buildPrompt: (message) => loadBundledSkillPrompt("document-pptx", message),
    bundleDir: "document-pptx",
    priority: 71,
  },
];

/**
 * Match a user message against skills and return the active prompt set.
 * Research can be paired with one primary creation skill for combined asks.
 */
export function matchSkills(message: string, sandboxAvailable = false): Skill[] {
  const matches = STUDY_SKILLS
    .filter((skill) => (!skill.requiresSandbox || sandboxAvailable) && skill.match(message))
    .sort((left, right) => right.priority - left.priority);

  if (matches.length === 0) {
    return [];
  }

  const research = matches.find((skill) => skill.id === "research") ?? null;
  const primary = matches.find((skill) => skill.id !== "research") ?? matches[0]!;

  if (research && primary.id !== "research") {
    return [research, primary];
  }

  return [primary];
}

export function matchSkill(message: string, sandboxAvailable = false): Skill | null {
  return matchSkills(message, sandboxAvailable)[0] ?? null;
}
