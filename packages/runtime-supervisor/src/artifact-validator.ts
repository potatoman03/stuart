import type { CitationRef } from "@stuart/shared";

export type ArtifactValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

function success(warnings: string[] = []): ArtifactValidationResult {
  return { ok: true, errors: [], warnings };
}

function failure(...errors: string[]): ArtifactValidationResult {
  return { ok: false, errors, warnings: [] };
}

function hasCitations(value: unknown): boolean {
  const citations = (value as { citations?: CitationRef[] } | null)?.citations;
  return Array.isArray(citations) && citations.length > 0;
}

function hasSourceNotes(value: unknown): boolean {
  const sourceNotes = (value as { sourceNotes?: unknown[] } | null)?.sourceNotes;
  return Array.isArray(sourceNotes) && sourceNotes.some((note) => typeof note === "string" && note.trim().length > 0);
}

function hasGrounding(value: unknown): boolean {
  return hasCitations(value) || hasSourceNotes(value);
}

function containsPlaceholder(text: string): boolean {
  return /\b(?:TODO|TBD|FIXME|placeholder)\b/i.test(text) || /\{\{[^}]+\}\}/.test(text);
}

const STRUCTURED_DOC_PARAGRAPH_TYPES = new Set([
  "text",
  "bullet",
  "numbered",
  "table",
  "callout",
  "quote",
  "citation_note",
  "math",
  "svg",
  "code",
  "divider",
  "definition",
  "kv",
]);

function isSvgMarkup(value: unknown): boolean {
  return typeof value === "string" && /<svg\b[\s\S]*<\/svg>/i.test(value.trim());
}

export function validateArtifactDraft(kind: string, data: unknown): ArtifactValidationResult {
  if (!data || typeof data !== "object") {
    return failure("Artifact payload is missing or invalid.");
  }

  const payload = data as Record<string, unknown>;

  switch (kind) {
    case "interactive": {
      const html = typeof payload.html === "string" ? payload.html.trim() : "";
      const path = typeof payload.path === "string" ? payload.path.trim() : "";
      if (!html && !path) {
        return failure("Interactive artifacts must include inline HTML or a workspace-relative path.");
      }
      const warnings: string[] = [];
      if (html && !/<(?:script|button|canvas|svg|input|iframe)\b/i.test(html)) {
        warnings.push("Interactive HTML does not appear to include obvious interactive elements.");
      }
      if (html && !/source|citation|evidence/i.test(html)) {
        warnings.push("Interactive artifact does not visibly mention sources or evidence.");
      }
      return success(warnings);
    }

    case "study_doc": {
      const markdown = typeof payload.markdown === "string" ? payload.markdown.trim() : "";
      if (!markdown) {
        return failure("Study docs must include markdown content.");
      }
      if (containsPlaceholder(markdown)) {
        return failure("Study doc contains unresolved placeholders.");
      }
      const warnings: string[] = [];
      if (!/\[[^\]]+\]/.test(markdown)) {
        warnings.push("Study doc does not include any obvious inline citations.");
      }
      return success(warnings);
    }

    case "document_pdf": {
      const document = (payload.document as Record<string, unknown> | undefined) ?? payload;
      const sections = (document.sections as unknown[]) ?? [];
      if (!Array.isArray(sections) || sections.length === 0) {
        return failure("PDF artifacts must include at least one section.");
      }
      const columns = document.columns;
      if (columns !== undefined && columns !== 1 && columns !== 2) {
        return failure("PDF artifacts must set columns to 1 or 2.");
      }
      for (const section of sections) {
        const typedSection = section as { heading?: unknown; level?: unknown; paragraphs?: unknown[] };
        if (typeof typedSection.heading !== "string" || !typedSection.heading.trim()) {
          return failure("Each PDF section must include a heading.");
        }
        if (![1, 2, 3].includes(Number(typedSection.level))) {
          return failure(`PDF section "${typedSection.heading}" has an invalid level.`);
        }
        if (!Array.isArray(typedSection.paragraphs) || typedSection.paragraphs.length === 0) {
          return failure(`PDF section "${typedSection.heading}" must include at least one paragraph.`);
        }
        for (const paragraph of typedSection.paragraphs) {
          const typedParagraph = paragraph as Record<string, unknown>;
          const type = String(typedParagraph.type ?? "");
          if (!STRUCTURED_DOC_PARAGRAPH_TYPES.has(type)) {
            return failure(`PDF paragraph type "${type}" is not supported.`);
          }
          if (type === "table") {
            const headers = Array.isArray(typedParagraph.headers) ? typedParagraph.headers : [];
            const rows = Array.isArray(typedParagraph.rows) ? typedParagraph.rows : [];
            if (headers.length === 0) {
              return failure(`PDF table in section "${typedSection.heading}" must include headers.`);
            }
            if (rows.some((row) => !Array.isArray(row) || row.length !== headers.length)) {
              return failure(`PDF table in section "${typedSection.heading}" has mismatched row widths.`);
            }
          }
          if (type === "callout" && !["info", "tip", "warning", "important"].includes(String(typedParagraph.style ?? ""))) {
            return failure(`PDF callout in section "${typedSection.heading}" must use info, tip, warning, or important style.`);
          }
          if (type === "svg" && !isSvgMarkup(typedParagraph.svg)) {
            return failure(`PDF SVG block in section "${typedSection.heading}" must include valid <svg> markup.`);
          }
        }
      }
      const warnings: string[] = [];
      if (!hasGrounding(document)) {
        warnings.push("PDF artifact does not include citations; generation may be weakly grounded.");
      }
      return success(warnings);
    }

    case "document_docx": {
      const document = (payload.document as Record<string, unknown> | undefined) ?? payload;
      const sections = (document.sections as unknown[]) ?? [];
      if (!Array.isArray(sections) || sections.length === 0) {
        return failure("DOCX artifacts must include at least one section.");
      }
      for (const section of sections) {
        const typedSection = section as { heading?: unknown; paragraphs?: unknown[] };
        if (!Array.isArray(typedSection.paragraphs) || typedSection.paragraphs.length === 0) {
          return failure(`DOCX section "${String(typedSection.heading ?? "Untitled")}" must include at least one paragraph.`);
        }
        for (const paragraph of typedSection.paragraphs) {
          const typedParagraph = paragraph as Record<string, unknown>;
          const type = String(typedParagraph.type ?? "");
          if (!STRUCTURED_DOC_PARAGRAPH_TYPES.has(type)) {
            return failure(`DOCX paragraph type "${type}" is not supported.`);
          }
          if (type === "svg" && !isSvgMarkup(typedParagraph.svg)) {
            return failure(`DOCX SVG block in section "${String(typedSection.heading ?? "Untitled")}" must include valid <svg> markup.`);
          }
        }
      }
      return hasGrounding(document)
        ? success()
        : success(["DOCX artifact does not include citations; generation may be weakly grounded."]);
    }

    case "document_xlsx": {
      const workbook = (payload.workbook as Record<string, unknown> | undefined) ?? payload;
      const sheets = (workbook.sheets as unknown[]) ?? [];
      if (!Array.isArray(sheets) || sheets.length === 0) {
        return failure("XLSX artifacts must include at least one worksheet.");
      }
      return hasGrounding(workbook)
        ? success()
        : success(["XLSX artifact does not include sourceNotes or citations; provenance may be weak."]);
    }

    case "document_pptx": {
      const presentation = (payload.presentation as Record<string, unknown> | undefined) ?? payload;
      const slides = (presentation.slides as unknown[]) ?? [];
      if (!Array.isArray(slides) || slides.length === 0) {
        return failure("PPTX artifacts must include at least one slide.");
      }
      const warnings: string[] = [];
      for (const slide of slides) {
        const typedSlide = slide as Record<string, unknown>;
        if (typedSlide.layout === "diagram" && !isSvgMarkup(typedSlide.svg)) {
          return failure("PPTX diagram slides must include valid <svg> markup.");
        }
      }
      const lastSlide = slides.at(-1) as { layout?: string } | undefined;
      if (lastSlide?.layout !== "sources") {
        warnings.push("PPTX artifact does not end with an explicit sources slide.");
      }
      if (!hasGrounding(presentation)) {
        warnings.push("PPTX artifact does not include citations; references slide may be incomplete.");
      }
      return success(warnings);
    }

    default:
      return success();
  }
}
