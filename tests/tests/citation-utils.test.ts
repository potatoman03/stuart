import { describe, expect, it } from "vitest";
import type { IngestionDocumentRecord, IngestionSearchResult, WorkspaceFileRecord } from "@stuart/shared";
import {
  buildFileReferenceMarker,
  citationPillShouldOpenWorkspaceDirectly,
  cleanFileReferences,
  cleanSourceName,
  dedupeCitationResults,
  extractCitationQueryText,
  fileExtension,
  findBestCitationDocument,
  findBestSourcePath,
  findBestWorkspaceFile,
  FILE_REF_END,
  FILE_REF_MARKER,
  isWeakCitationSourcePath,
  normalizeSourcePathReference,
  parseFileReferenceMarker,
  mergeCitationTrailingPunctuation,
  splitMessageWithCitations,
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
    indexedAt: new Date(0).toISOString(),
  };
}

function workspaceFile(relativePath: string, previewKind: WorkspaceFileRecord["previewKind"] = "text"): WorkspaceFileRecord {
  return {
    id: relativePath,
    taskId: "task-1",
    name: relativePath.split("/").pop() ?? relativePath,
    relativePath,
    sourceLabel: "project",
    sourceKind: "project",
    size: 1024,
    modifiedAt: new Date(0).toISOString(),
    previewKind,
  };
}

function searchHit(overrides: Partial<IngestionSearchResult> & Pick<IngestionSearchResult, "chunkId" | "relativePath">): IngestionSearchResult {
  return {
    documentId: "doc-1",
    taskId: "task-1",
    sourcePath: overrides.relativePath,
    fileType: "pdf",
    text: "chunk text",
    snippet: "snippet",
    score: 0.9,
    heading: undefined,
    ...overrides,
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

  it("splitMessageWithCitations derives query text from the full message, not a paragraph fragment", () => {
    const marker = buildFileReferenceMarker("Lecture 2", "PDF", "materials/Lecture 02.pdf");
    const content = `Breadth-first search explores level by level. ${marker} It is complete.`;
    const cite = splitMessageWithCitations(content).find((s) => s.kind === "citation");
    expect(cite?.kind).toBe("citation");
    if (cite?.kind !== "citation") return;
    expect(cite.queryText.toLowerCase()).toContain("breadth");
    expect(cite.queryText.length).toBeGreaterThan(20);
  });

  it("mergeCitationTrailingPunctuation attaches a lone period segment after a citation", () => {
    const marker = buildFileReferenceMarker("Lecture 2", "PDF", "x.pdf");
    const raw = `Claim ${marker}.`;
    const merged = mergeCitationTrailingPunctuation(splitMessageWithCitations(raw));
    expect(merged).toHaveLength(2);
    expect(merged[0]?.kind).toBe("markdown");
    expect(merged[1]?.kind).toBe("citation");
    if (merged[1]?.kind !== "citation") return;
    expect(merged[1].trailingInline?.trim()).toBe(".");
  });
});

describe("isWeakCitationSourcePath", () => {
  it("treats short labels without slashes or extensions as weak", () => {
    expect(isWeakCitationSourcePath("Lecture 2")).toBe(true);
    expect(isWeakCitationSourcePath("Tutorial 1 Solutions")).toBe(true);
  });

  it("treats real relative paths as strong", () => {
    expect(isWeakCitationSourcePath("attachments/x/Lecture 02 - Foo.pdf")).toBe(false);
    expect(isWeakCitationSourcePath("Lecture 02 - Foo.pdf")).toBe(false);
    expect(isWeakCitationSourcePath("notes\\Week 3\\slides.pdf")).toBe(false);
  });
});

describe("citation path and label cleanup", () => {
  it("strips attachment prefixes and decodes percent-encoding in cleanSourceName", () => {
    expect(cleanSourceName("attachments/a1b2c3d4-e5f6/Lecture%2003%20-%20Foo.pdf")).toBe("Lecture 03 - Foo");
  });

  it("normalizes file://, query strings, and backslashes for workspace resolution", () => {
    expect(normalizeSourcePathReference("file:///Users/me/proj/notes/a.pdf?page=2#frag")).toBe("Users/me/proj/notes/a.pdf");
    expect(normalizeSourcePathReference("folder\\sub\\b.md")).toBe("folder/sub/b.md");
  });

  it("detects common document extensions case-insensitively", () => {
    expect(fileExtension("Read.Me.PDF")).toBe("PDF");
    expect(fileExtension("data.JSON")).toBe("JSON");
    expect(fileExtension("unknown")).toBe("DOC");
  });
});

describe("citation matching thresholds and disambiguation", () => {
  it("returns null when no document scores above the confidence floor", () => {
    expect(findBestCitationDocument("QuantumChromodynamics", [doc("foo.pdf")])).toBeNull();
    expect(findBestSourcePath("QuantumChromodynamics", ["foo.pdf"])).toBeNull();
  });

  it("prefers exact workspace path when sourcePath is provided", () => {
    const a = workspaceFile("deep/path/Lecture 02.pdf");
    const b = workspaceFile("other/Lecture 02 - Different.pdf");
    const hit = findBestWorkspaceFile("ignored label", [a, b], "deep/path/Lecture 02.pdf");
    expect(hit?.relativePath).toBe("deep/path/Lecture 02.pdf");
  });

  it("when several files share a basename, picks the shortest relative path", () => {
    const long = workspaceFile("course/2026/readings/shared-name.pdf");
    const short = workspaceFile("shared-name.pdf");
    const hit = findBestWorkspaceFile("shared-name.pdf", [long, short]);
    expect(hit?.relativePath).toBe("shared-name.pdf");
  });

  it("matches week ordinals to week-prefixed files", () => {
    const match = findBestCitationDocument("Week 4 readings", [
      doc("Lecture 01.pdf"),
      doc("Week 04 - Graphs.pdf"),
      doc("Week 14 - Review.pdf"),
    ]);
    expect(match?.relativePath).toBe("Week 04 - Graphs.pdf");
  });
});

describe("file reference markers and cleaning", () => {
  it("parses label-only and label+ext markers without a path", () => {
    expect(parseFileReferenceMarker("Syllabus::PDF")).toEqual({
      label: "Syllabus",
      ext: "PDF",
      sourcePath: null,
    });
    expect(parseFileReferenceMarker("NoSeparator")).toEqual({
      label: "NoSeparator",
      ext: "DOC",
      sourcePath: null,
    });
  });

  it("does not rewrite markdown links to http(s) URLs", () => {
    const s = cleanFileReferences("See [RFC](https://example.com/rfc) and [local](notes/a.pdf).");
    expect(s).toContain("https://example.com/rfc");
    expect(s).toContain(FILE_REF_MARKER);
    // Path is encodeURIComponent in the marker (slash → %2F).
    expect(s).toMatch(/«local::DOC::notes%2Fa\.pdf/);
  });

  it("normalizes adjacent citation markers separated by punctuation", () => {
    const s = cleanFileReferences(`One«A::PDF::x.pdf»;«B::PDF::y.pdf»`);
    expect(s).not.toMatch(/»\s*;/);
    expect(s).toMatch(new RegExp(`${FILE_REF_END}\\s+${FILE_REF_MARKER}`));
  });

  it("converts East Asian bracket citations to markers", () => {
    const s = cleanFileReferences("See **【Course Syllabus】** for dates.");
    expect(s).toContain("«Course Syllabus::DOC»");
  });
});

describe("extractCitationQueryText windowing", () => {
  it("uses a wider window when the sentence is too short", () => {
    const content = "X. ".repeat(30) + "«Lec::PDF::a.pdf» " + "Y. ".repeat(30);
    const start = content.indexOf("«");
    const end = content.indexOf("»") + 1;
    const q = extractCitationQueryText(content, start, end);
    expect(q.length).toBeGreaterThan(40);
    expect(q).toContain("Lec");
  });

  it("replaces multiple markers in the query window with human labels only", () => {
    const content = "First «A::PDF::x.pdf» then «B::PDF::y.pdf».";
    const start = content.indexOf("«");
    const end = content.indexOf("»") + 1;
    expect(extractCitationQueryText(content, start, end)).toBe("First A then B.");
  });
});

describe("citation popover helpers (used by chat UI)", () => {
  it("dedupeCitationResults keeps distinct locators and drops identical path+locator", () => {
    const a = searchHit({ chunkId: "c1", relativePath: "a.pdf", locator: "page 1" });
    const b = searchHit({ chunkId: "c2", relativePath: "a.pdf", locator: "page 2" });
    const c = searchHit({ chunkId: "c3", relativePath: "a.pdf", locator: "page 1" });
    expect(dedupeCitationResults([a, b, c])).toHaveLength(2);
  });

  it("citationPillShouldOpenWorkspaceDirectly only for image, html, jsx previews", () => {
    expect(citationPillShouldOpenWorkspaceDirectly(workspaceFile("a.pdf", "pdf"))).toBe(false);
    expect(citationPillShouldOpenWorkspaceDirectly(workspaceFile("a.html", "html"))).toBe(true);
    expect(citationPillShouldOpenWorkspaceDirectly(workspaceFile("a.jsx", "jsx"))).toBe(true);
    expect(citationPillShouldOpenWorkspaceDirectly(workspaceFile("a.png", "image"))).toBe(true);
  });
});
