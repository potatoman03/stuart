import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDatabase } from "@stuart/db";
import {
  sanitizeRetrievalQuery,
  shouldHideWorkspacePath,
} from "@stuart/runtime-supervisor";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "stuart-retrieval-test-"));
  cleanupPaths.push(directory);
  return new LocalDatabase(join(directory, "stuart.sqlite"));
}

function seedChunk(
  db: LocalDatabase,
  input: {
    documentId: string;
    chunkId: string;
    relativePath: string;
    text: string;
    heading?: string;
  }
) {
  db.upsertIngestionDocument({
    id: input.documentId,
    taskId: "task-1",
    taskRunId: "run-1",
    sourcePath: `/workspace/${input.relativePath}`,
    relativePath: input.relativePath,
    fileType: "md",
    parser: "markdown",
    chunkCount: 1,
    size: input.text.length,
    status: "indexed",
    indexedAt: new Date().toISOString(),
  });

  db.insertIngestionChunk({
    chunkId: input.chunkId,
    documentId: input.documentId,
    taskId: "task-1",
    taskRunId: "run-1",
    sourcePath: `/workspace/${input.relativePath}`,
    relativePath: input.relativePath,
    fileType: "md",
    heading: input.heading,
    text: input.text,
  });
}

describe("retrieval helpers", () => {
  it("strips artifact-generation noise from retrieval queries", () => {
    expect(sanitizeRetrievalQuery("create 10 flashcards on chapter 6 ANS")).toBe("chapter 6 ANS");
    expect(sanitizeRetrievalQuery("please generate a mind map about week 4 cardiac output")).toBe(
      "week 4 cardiac output"
    );
    expect(sanitizeRetrievalQuery("i wouldlike a interactive DFS and BFS visualiser for lecture 2")).toBe(
      "DFS and BFS lecture 2"
    );
  });

  it("hides environment and build directories from the workspace surface", () => {
    expect(shouldHideWorkspacePath(".venv/lib/python3.13/site-packages/debugpy/README.txt")).toBe(true);
    expect(shouldHideWorkspacePath("node_modules/react/index.js")).toBe(true);
    expect(shouldHideWorkspacePath("dist/assets/index.js")).toBe(true);
    expect(shouldHideWorkspacePath("Lecture 06 Notes.md")).toBe(false);
  });
});

describe("LocalDatabase.searchIngestionChunks", () => {
  it("uses cleaned high-signal tokens and prefix matching for retrieval", async () => {
    const db = await createDatabase();
    seedChunk(db, {
      documentId: "doc-sympathetic",
      chunkId: "chunk-sympathetic",
      relativePath: "Lecture 06 Autonomic Nervous System.md",
      heading: "Autonomic branches",
      text: "The sympathetic nervous system prepares the body for fight or flight responses.",
    });
    seedChunk(db, {
      documentId: "doc-general",
      chunkId: "chunk-general",
      relativePath: "Lecture 01 Overview.md",
      heading: "Overview",
      text: "The nervous system coordinates major body functions.",
    });

    const results = db.searchIngestionChunks("task-1", "sympathet control", {
      taskRunId: "run-1",
      limit: 5,
    });

    expect(results[0]?.relativePath).toBe("Lecture 06 Autonomic Nervous System.md");
  });

  it("falls back from strict matching to broader matching when one token is absent", async () => {
    const db = await createDatabase();
    seedChunk(db, {
      documentId: "doc-inventory",
      chunkId: "chunk-inventory",
      relativePath: "Chapter 08 Inventory.md",
      heading: "Inventory costing",
      text: "Inventory costing methods include FIFO, weighted average, and specific identification.",
    });
    seedChunk(db, {
      documentId: "doc-revenue",
      chunkId: "chunk-revenue",
      relativePath: "Chapter 07 Revenue.md",
      heading: "Revenue recognition",
      text: "Revenue is recognized when performance obligations are satisfied.",
    });

    const results = db.searchIngestionChunks("task-1", "inventory costing ans", {
      taskRunId: "run-1",
      limit: 5,
    });

    expect(results.some((result) => result.relativePath === "Chapter 08 Inventory.md")).toBe(true);
  });

  it("can scope retrieval to a single source file", async () => {
    const db = await createDatabase();
    seedChunk(db, {
      documentId: "doc-lecture-1",
      chunkId: "chunk-lecture-1",
      relativePath: "Lecture 01 Search.md",
      heading: "Breadth-first search",
      text: "Breadth-first search expands nodes in layers using a FIFO queue.",
    });
    seedChunk(db, {
      documentId: "doc-lecture-2",
      chunkId: "chunk-lecture-2",
      relativePath: "Lecture 02 Greek Religion.md",
      heading: "Greek ritual",
      text: "Greek ritual structured civic and household religious life.",
    });

    const results = db.searchIngestionChunks("task-1", "ritual civic household", {
      taskRunId: "run-1",
      source: "Lecture 02 Greek Religion.md",
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.relativePath).toBe("Lecture 02 Greek Religion.md");
  });

  it("scopes search to a source using basename when the citation path is deeper than the indexed relative path", async () => {
    const db = await createDatabase();
    seedChunk(db, {
      documentId: "doc-tut",
      chunkId: "chunk-tut",
      relativePath: "Tutorial 1 Solutions.pdf",
      heading: "Analysis",
      text: "DFS is not complete in general when search depth is unbounded.",
    });

    const results = db.searchIngestionChunks("task-1", "complete general DFS unbounded", {
      taskRunId: "run-1",
      source: "attachments/abc-123/Tutorial 1 Solutions.pdf",
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.relativePath).toBe("Tutorial 1 Solutions.pdf");
  });

  it("getChunksBySource falls back to the global index when the active run scope has no rows", async () => {
    const db = await createDatabase();
    db.upsertIngestionDocument({
      id: "doc-global-pdf",
      taskId: "task-1",
      taskRunId: undefined,
      sourcePath: "/workspace/Tutorial 1 Solutions.pdf",
      relativePath: "Tutorial 1 Solutions.pdf",
      fileType: "pdf",
      parser: "pdf",
      chunkCount: 1,
      size: 120,
      status: "indexed",
      indexedAt: new Date().toISOString(),
    });
    db.insertIngestionChunk({
      chunkId: "chunk-global-pdf",
      documentId: "doc-global-pdf",
      taskId: "task-1",
      taskRunId: undefined,
      sourcePath: "/workspace/Tutorial 1 Solutions.pdf",
      relativePath: "Tutorial 1 Solutions.pdf",
      fileType: "pdf",
      heading: "DFS",
      text: "Depth-first search may not terminate on infinite state spaces.",
    });

    const rows = db.getChunksBySource("task-1", "Tutorial 1 Solutions.pdf", {
      taskRunId: "run-99",
      limit: 5,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toContain("Depth-first");
  });

  it("getChunksBySource finds PDF chunks indexed under a different task run (same task id)", async () => {
    const db = await createDatabase();
    db.upsertIngestionDocument({
      id: "doc-other-run",
      taskId: "task-1",
      taskRunId: "run-older",
      sourcePath: "/w/Tutorial 1 Solutions.pdf",
      relativePath: "Tutorial 1 Solutions.pdf",
      fileType: "pdf",
      parser: "pdf",
      chunkCount: 1,
      size: 80,
      status: "indexed",
      indexedAt: new Date().toISOString(),
    });
    db.insertIngestionChunk({
      chunkId: "chunk-other-run",
      documentId: "doc-other-run",
      taskId: "task-1",
      taskRunId: "run-older",
      sourcePath: "/w/Tutorial 1 Solutions.pdf",
      relativePath: "Tutorial 1 Solutions.pdf",
      fileType: "pdf",
      heading: "Q2",
      text: "This PDF was indexed during an earlier run's staging snapshot.",
    });

    const rows = db.getChunksBySource("task-1", "Tutorial 1 Solutions.pdf", {
      taskRunId: "run-newer",
      limit: 5,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toContain("earlier run");
  });
});
