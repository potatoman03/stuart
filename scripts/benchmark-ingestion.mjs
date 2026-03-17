import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { StuartRuntime } from "../packages/runtime-supervisor/dist/index.js";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const helperCandidate = join(
  workspaceRoot,
  "native",
  "vm-helper",
  ".build",
  "debug",
  "StuartVMHelper"
);

const profiles = {
  small: { documents: 24, noiseBlocks: 3 },
  medium: { documents: 96, noiseBlocks: 5 },
  large: { documents: 240, noiseBlocks: 7 }
};

const expectedFacts = {
  missionCode: "AMBER-RIVULET-12",
  approvalPhrase: "green room seven",
  exportTarget: "dockside-ledger",
  ownerPair: "Siena + Marco",
  reviewWindow: "48-hour review window",
  chapterLead: "Adjusting entries and accrual corrections",
  regionStack: ["cedar", "plume", "orbit"]
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profile = profiles[args.profile] ?? profiles.medium;
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const baseDir = join(workspaceRoot, ".stuart-data", "benchmarks");
  const corporaDir = join(baseDir, "corpora");
  const reportsDir = join(baseDir, "reports");
  const corpusRoot = join(corporaDir, `${args.profile}-${runId}`);
  const dataDir = join(baseDir, "runtime");

  await mkdir(corporaDir, { recursive: true });
  await mkdir(reportsDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const corpus = await generateCorpus(corpusRoot, profile.documents, profile.noiseBlocks);
  if (args.dryRun) {
    const report = {
      profile: args.profile,
      corpusRoot,
      ...corpus
    };
    await writeLatestReport(reportsDir, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const runtime = new StuartRuntime({
    dataDir,
    vmHelperBinaryPath: existsSync(helperCandidate) ? helperCandidate : undefined
  });
  await runtime.bootstrap();

  const project = runtime.createProject({
    name: `Benchmark ${args.profile} ${runId}`,
    rootPath: corpusRoot
  });
  const task = runtime.createTask({
    projectId: project.id,
    title: `Ingestion benchmark ${args.profile}`,
    objective:
      "Search the staged attachment corpus, recover exact benchmark facts, and return strict JSON only.",
    attachments: [
      {
        id: crypto.randomUUID(),
        hostPath: corpusRoot,
        mode: "reference"
      }
    ],
    browserEnabled: false,
    authMode: "chatgpt"
  });

  const stageStart = performance.now();
  const preparedRun = await runtime.prepareTaskRun(task.id);
  const stageMs = round(performance.now() - stageStart);

  const workspaceScanStart = performance.now();
  const workspaceFiles = await runtime.listWorkspaceFiles(task.id, preparedRun.id);
  const workspaceScanMs = round(performance.now() - workspaceScanStart);
  const indexBuildStart = performance.now();
  const indexStats = await runtime.buildTaskIngestionIndex(task.id, {
    taskRunId: preparedRun.id,
    force: true
  });
  const indexBuildMs = round(performance.now() - indexBuildStart);

  const prompt = buildBenchmarkPrompt();
  const turnStartedAt = { value: null };
  const firstThinkingAt = { value: null };
  const firstDeltaAt = { value: null };
  let assistantMessage = null;

  const sendStartedAt = performance.now();
  const completed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Benchmark timed out after ${args.timeoutMs}ms.`));
    }, args.timeoutMs);

    const unsubscribe = runtime.onEvent((event) => {
      if (!("taskId" in event) || event.taskId !== task.id) {
        return;
      }

      if (event.type === "codex.turn.started" && turnStartedAt.value == null) {
        turnStartedAt.value = performance.now();
        return;
      }

      if (event.type === "codex.thinking" && firstThinkingAt.value == null) {
        firstThinkingAt.value = performance.now();
        return;
      }

      if (event.type === "codex.message.delta" && firstDeltaAt.value == null) {
        firstDeltaAt.value = performance.now();
        return;
      }

      if (event.type === "codex.message.completed") {
        assistantMessage = event.message;
        return;
      }

      if (event.type === "codex.turn.completed") {
        clearTimeout(timeout);
        unsubscribe();
        if (event.status === "failed") {
          reject(new Error(event.error ?? "Codex turn failed."));
          return;
        }
        resolve(event);
      }
    });
  });

  await runtime.sendTaskMessage(task.id, prompt);
  await completed;

  const totalTurnMs = round(performance.now() - sendStartedAt);
  const assistant =
    assistantMessage ??
    [...runtime.listTaskMessages(task.id)]
      .reverse()
      .find((message) => message.role === "assistant") ??
    null;
  const score = scoreAssistantAnswer(assistant?.content ?? "");

  const report = {
    generatedAt: new Date().toISOString(),
    profile: args.profile,
    corpusRoot,
    prompt,
    corpus: {
      documentCount: corpus.documentCount,
      workspaceFileCount: workspaceFiles.length,
      totalBytes: corpus.totalBytes,
      seededFiles: corpus.seededFiles,
      indexedDocuments: indexStats.documentsIndexed,
      indexedChunks: indexStats.chunksIndexed
    },
    metrics: {
      stageMs,
      workspaceScanMs,
      indexBuildMs,
      turnStartMs:
        turnStartedAt.value == null ? null : round(turnStartedAt.value - sendStartedAt),
      firstThinkingMs:
        firstThinkingAt.value == null ? null : round(firstThinkingAt.value - sendStartedAt),
      firstDeltaMs:
        firstDeltaAt.value == null ? null : round(firstDeltaAt.value - sendStartedAt),
      totalTurnMs
    },
    scoring: score,
    assistantPreview: assistant?.content.slice(0, 1200) ?? "",
    reportPath: join(reportsDir, `${runId}.json`)
  };

  await writeFile(report.reportPath, JSON.stringify(report, null, 2), "utf8");
  await writeLatestReport(reportsDir, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(argv) {
  const options = {
    profile: "medium",
    timeoutMs: 180000,
    dryRun: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--profile" && argv[index + 1]) {
      options.profile = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--timeout-ms" && argv[index + 1]) {
      options.timeoutMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (value === "--dry-run") {
      options.dryRun = true;
    }
  }

  return options;
}

async function generateCorpus(rootPath, documentCount, noiseBlocks) {
  await rm(rootPath, { recursive: true, force: true });
  await mkdir(join(rootPath, "briefs"), { recursive: true });
  await mkdir(join(rootPath, "notes"), { recursive: true });
  await mkdir(join(rootPath, "data"), { recursive: true });
  await mkdir(join(rootPath, "appendix"), { recursive: true });

  const seededFiles = [];
  let totalBytes = 0;

  const seededEntries = [
    {
      path: join(rootPath, "briefs", "mission-outline.md"),
      content: `# Mission Outline\n\nMission code: ${expectedFacts.missionCode}\n\nUse this exact identifier when preparing downstream summaries.\n`
    },
    {
      path: join(rootPath, "notes", "approvals.txt"),
      content: `Approval phrase: ${expectedFacts.approvalPhrase}\nEscalate only if this phrase is missing from the request trail.\n`
    },
    {
      path: join(rootPath, "briefs", "handoff.html"),
      content: `<!doctype html><html><body><h1>Handoff</h1><p>Export target: <strong>${expectedFacts.exportTarget}</strong></p></body></html>\n`
    },
    {
      path: join(rootPath, "data", "owners.csv"),
      content: `field,value\nowner_pair,${expectedFacts.ownerPair}\nbackup_pair,Kei + Rami\n`
    },
    {
      path: join(rootPath, "data", "regions.json"),
      content: `${JSON.stringify({ regionStack: expectedFacts.regionStack }, null, 2)}\n`
    },
    {
      path: join(rootPath, "notes", "review-window.md"),
      content: `## Review Window\n\nThe required review window is ${expectedFacts.reviewWindow} before any external handoff.\n`
    },
    {
      path: join(rootPath, "appendix", "study-guide.md"),
      content: `### Chapter Lead\n\n${expectedFacts.chapterLead}\n`
    }
  ];

  for (const entry of seededEntries) {
    await writeFile(entry.path, entry.content, "utf8");
    seededFiles.push(entry.path);
    totalBytes += Buffer.byteLength(entry.content);
  }

  for (let index = 0; index < documentCount; index += 1) {
    const folder =
      index % 4 === 0 ? "briefs" : index % 4 === 1 ? "notes" : index % 4 === 2 ? "data" : "appendix";
    const extension =
      index % 5 === 0 ? "md" : index % 5 === 1 ? "txt" : index % 5 === 2 ? "html" : index % 5 === 3 ? "json" : "csv";
    const filePath = join(rootPath, folder, `packet-${String(index + 1).padStart(3, "0")}.${extension}`);
    const content = buildNoiseDocument(index, extension, noiseBlocks);
    await writeFile(filePath, content, "utf8");
    totalBytes += Buffer.byteLength(content);
  }

  return {
    documentCount: documentCount + seededEntries.length,
    totalBytes,
    seededFiles
  };
}

function buildNoiseDocument(seed, extension, blocks) {
  const headline = `Packet ${seed + 1}`;
  const paragraphs = Array.from({ length: blocks }, (_, blockIndex) =>
    buildNoiseParagraph(seed * 17 + blockIndex * 13)
  );

  switch (extension) {
    case "html":
      return `<!doctype html><html><body><h1>${headline}</h1>${paragraphs
        .map((paragraph) => `<p>${paragraph}</p>`)
        .join("")}</body></html>\n`;
    case "json":
      return `${JSON.stringify({ headline, summary: paragraphs }, null, 2)}\n`;
    case "csv":
      return ["section,text", ...paragraphs.map((paragraph, index) => `${index + 1},"${paragraph.replace(/"/g, '""')}"`)].join("\n") + "\n";
    default:
      return `# ${headline}\n\n${paragraphs.join("\n\n")}\n`;
  }
}

function buildNoiseParagraph(seed) {
  const lexicon = [
    "ledger",
    "handoff",
    "variance",
    "review",
    "packet",
    "timeline",
    "revision",
    "checkpoint",
    "signal",
    "summary",
    "queue",
    "staging",
    "context",
    "approval",
    "operator",
    "analysis"
  ];
  const words = Array.from({ length: 58 }, (_, index) => lexicon[(seed + index * 7) % lexicon.length]);
  const sentences = [];
  for (let index = 0; index < words.length; index += 14) {
    const sentence = words
      .slice(index, index + 14)
      .join(" ")
      .replace(/^./, (letter) => letter.toUpperCase());
    sentences.push(`${sentence}.`);
  }
  return sentences.join(" ");
}

function buildBenchmarkPrompt() {
  return [
    "Use only the local staged attachments for this task.",
    "Search the workspace and return strict JSON with exactly these keys:",
    JSON.stringify(
      {
        missionCode: "",
        approvalPhrase: "",
        exportTarget: "",
        ownerPair: "",
        reviewWindow: "",
        chapterLead: "",
        regionStack: ["", "", ""]
      },
      null,
      2
    ),
    "Do not add commentary. Preserve exact values and array ordering."
  ].join("\n\n");
}

function scoreAssistantAnswer(content) {
  const parsed = extractJson(content);
  const results = [];

  for (const [key, expected] of Object.entries(expectedFacts)) {
    const actual = parsed?.[key];
    const matched = Array.isArray(expected)
      ? arraysMatch(actual, expected)
      : normalize(actual) === normalize(expected);
    results.push({
      key,
      expected,
      actual: actual ?? null,
      matched
    });
  }

  const matchedCount = results.filter((entry) => entry.matched).length;
  return {
    matchedCount,
    totalCount: results.length,
    exactMatchRate: round((matchedCount / results.length) * 100),
    results
  };
}

function extractJson(content) {
  if (!content.trim()) {
    return null;
  }

  const normalized = content
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "");

  try {
    return JSON.parse(normalized);
  } catch {
    const start = normalized.indexOf("{");
    const end = normalized.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }

    try {
      return JSON.parse(normalized.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function arraysMatch(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    return false;
  }
  return expected.every((value, index) => normalize(actual[index]) === normalize(value));
}

function normalize(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function writeLatestReport(reportsDir, report) {
  await writeFile(join(reportsDir, "latest.json"), JSON.stringify(report, null, 2), "utf8");
}

function round(value) {
  return Math.round(value * 100) / 100;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
