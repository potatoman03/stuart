import { describe, expect, it } from "vitest";
import type { IngestionDocumentRecord, WorkspaceFileRecord } from "@stuart/shared";
import {
  buildFileReferenceMarker,
  cleanFileReferences,
  extractCitationQueryText,
  findBestCitationDocument,
  findBestSourcePath,
  findBestWorkspaceFile,
  parseFileReferenceMarker,
} from "../../apps/web/src/client/citation-utils";

function doc(relativePath: string): IngestionDocumentRecord {
  return {
    id: relativePath,
    taskId: "task-1",
    sourcePath: relativePath,
    relativePath,
    fileType: "pdf",
    parser: "pdf",
    chunkCount: 3,
    size: 1024,
    status: "indexed",
  };
}

function workspaceFile(relativePath: string): WorkspaceFileRecord {
  return {
    id: relativePath,
    taskId: "task-1",
    name: relativePath.split("/").pop() ?? relativePath,
    relativePath,
    sourceLabel: "project",
    sourceKind: "project",
    size: 1024,
    modifiedAt: new Date(0).toISOString(),
    previewKind: "text",
  };
}

describe("citation utils", () => {
  it("matches lecture labels even when filenames use zero-padded ordinals", () => {
    const match = findBestCitationDocument("Lecture 3", [
      doc("Lecture 01 - Introduction.pdf"),
      doc("Lecture 03 - Solving Problems by Searching.pdf"),
      doc("Lecture 13 - Constraint Satisfaction.pdf"),
    ]);

    expect(match?.relativePath).toBe("Lecture 03 - Solving Problems by Searching.pdf");
  });

  it("preserves the source path inside cleaned markdown file references", () => {
    const cleaned = cleanFileReferences(
      "See [Lecture 3](attachments/abc123/Lecture 03 - Solving Problems by Searching.pdf).",
    );

    const rawMarker = cleaned.match(/«([^»]+)»/)?.[1];
    expect(rawMarker).toBeTruthy();

    const parsed = parseFileReferenceMarker(rawMarker!);
    expect(parsed.label).toBe("Lecture 3");
    expect(parsed.ext).toBe("PDF");
    expect(parsed.sourcePath).toBe("attachments/abc123/Lecture 03 - Solving Problems by Searching.pdf");
  });

  it("round-trips encoded marker payloads", () => {
    const marker = buildFileReferenceMarker("Lecture 3", "PDF", "notes/Lecture 03 (search).pdf");
    const parsed = parseFileReferenceMarker(marker.slice(1, -1));

    expect(parsed).toEqual({
      label: "Lecture 3",
      ext: "PDF",
      sourcePath: "notes/Lecture 03 (search).pdf",
    });
  });

  it("matches workspace files using normalized lecture labels", () => {
    const match = findBestWorkspaceFile("Lecture 2", [
      workspaceFile("Lecture 01 - Intro.pdf"),
      workspaceFile("notes/Lecture 02 - Solving Problems by Searching.pdf"),
      workspaceFile("Tutorial 02 Solutions.pdf"),
    ]);

    expect(match?.relativePath).toBe("notes/Lecture 02 - Solving Problems by Searching.pdf");
  });

  it("does not choose unrelated fallback files for lecture-style references", () => {
    const match = findBestSourcePath("Lecture 2", [
      "kakuro-local-search-walkthrough.html",
      "tutorial-2-solution.pdf",
    ]);

    expect(match).toBeNull();
  });

  it("extracts the surrounding claim text for a citation marker", () => {
    const content =
      "BFS expands nodes in layers of increasing depth «Lecture 2::PDF::Lecture%2002.pdf».";
    const markerStart = content.indexOf("«");
    const markerEnd = content.indexOf("»") + 1;

    expect(extractCitationQueryText(content, markerStart, markerEnd)).toBe(
      "BFS expands nodes in layers of increasing depth Lecture 2."
    );
  });
});
