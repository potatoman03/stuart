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
});
