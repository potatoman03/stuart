import { describe, expect, it } from "vitest";
import { validateArtifactDraft } from "../../packages/runtime-supervisor/src/artifact-validator";

describe("artifact validation", () => {
  it("accepts interactive artifacts with a path handoff", () => {
    const result = validateArtifactDraft("interactive", {
      kind: "interactive",
      title: "BFS Visualiser",
      path: "bfs.html",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects study docs with unresolved placeholders", () => {
    const result = validateArtifactDraft("study_doc", {
      kind: "study_doc",
      title: "Notes",
      markdown: "# TODO\n\n{{insert_example}}",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects empty presentations", () => {
    const result = validateArtifactDraft("document_pptx", {
      kind: "document_pptx",
      title: "Deck",
      presentation: { slides: [] },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects malformed PDF payloads", () => {
    const result = validateArtifactDraft("document_pdf", {
      kind: "document_pdf",
      title: "Cheat Sheet",
      document: {
        columns: 3,
        sections: [
          {
            heading: "Core idea",
            level: 1,
            paragraphs: [{ type: "callout", content: "Watch this." }],
          },
        ],
      },
    });
    expect(result.ok).toBe(false);
  });

  it("accepts XLSX provenance via sourceNotes", () => {
    const result = validateArtifactDraft("document_xlsx", {
      kind: "document_xlsx",
      title: "Workbook",
      workbook: {
        sheets: [
          {
            name: "Overview",
            columns: [{ header: "Topic" }],
            rows: [["Search"]],
          },
        ],
        sourceNotes: ["Lecture 2 slide 12"],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("rejects malformed SVG blocks in DOCX and PPTX payloads", () => {
    const docxResult = validateArtifactDraft("document_docx", {
      kind: "document_docx",
      title: "Guide",
      document: {
        citations: [],
        sections: [
          {
            heading: "Visual",
            level: 1,
            paragraphs: [{ type: "svg", svg: "<div>not svg</div>" }],
          },
        ],
      },
    });
    const pptxResult = validateArtifactDraft("document_pptx", {
      kind: "document_pptx",
      title: "Deck",
      presentation: {
        citations: [],
        slides: [{ layout: "diagram", title: "Flow", svg: "not-svg" }],
      },
    });

    expect(docxResult.ok).toBe(false);
    expect(pptxResult.ok).toBe(false);
  });
});
