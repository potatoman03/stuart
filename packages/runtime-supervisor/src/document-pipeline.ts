import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";
import XLSX from "xlsx";
import type {
  DocxDocumentPayload,
  PptxPresentationPayload,
  PptxSlide,
  XlsxCell,
  XlsxWorkbookPayload,
} from "@stuart/shared";
import { renderDocument } from "./document-renderer.js";
import { renderLatexToSvg, renderTextWithLatexToSvgHtml } from "./math-rendering.js";
import { normalizeSvgForHtml } from "./svg-rendering.js";

export type OfficePackageSummary = {
  partCount: number;
  entryPoint: string;
  contentTypes: boolean;
  relationshipRoot: boolean;
  worksheetCount?: number;
  slideCount?: number;
};

export type DocumentArtifactRenderResult = {
  outputPath: string;
  previewPath: string;
  officeSummary?: OfficePackageSummary;
};

const OFFICE_ENTRYPOINTS: Record<string, string> = {
  document_docx: "word/document.xml",
  document_xlsx: "xl/workbook.xml",
  document_pptx: "ppt/presentation.xml",
};

export async function validateOfficePackage(
  filePath: string,
  kind: string
): Promise<OfficePackageSummary> {
  const entryPoint = OFFICE_ENTRYPOINTS[kind];
  if (!entryPoint) {
    throw new Error(`Unsupported Office package kind: ${kind}`);
  }

  const buffer = await readFile(filePath);
  const archive = await JSZip.loadAsync(buffer);
  const files = Object.keys(archive.files);

  if (!files.includes("[Content_Types].xml")) {
    throw new Error("Office package is missing [Content_Types].xml");
  }
  if (!files.includes("_rels/.rels")) {
    throw new Error("Office package is missing _rels/.rels");
  }
  if (!files.includes(entryPoint)) {
    throw new Error(`Office package is missing ${entryPoint}`);
  }

  return {
    partCount: files.length,
    entryPoint,
    contentTypes: true,
    relationshipRoot: true,
    worksheetCount:
      kind === "document_xlsx"
        ? files.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)).length
        : undefined,
    slideCount:
      kind === "document_pptx"
        ? files.filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).length
        : undefined,
  };
}

export async function renderDocumentArtifact(
  kind: string,
  payload: unknown,
  outputDir: string,
  filename: string
): Promise<DocumentArtifactRenderResult> {
  await mkdir(outputDir, { recursive: true });
  const outputPath = await renderDocument(kind, payload, outputDir, filename);
  let officeSummary: OfficePackageSummary | undefined;
  if (kind === "document_docx" || kind === "document_xlsx" || kind === "document_pptx") {
    officeSummary = await validateOfficePackage(outputPath, kind);
  }
  const previewPath = await renderDocumentPreviewAsset(kind, payload, outputDir, filename, outputPath);
  return { outputPath, previewPath, officeSummary };
}

async function renderDocumentPreviewAsset(
  kind: string,
  payload: unknown,
  outputDir: string,
  filename: string,
  outputPath: string
): Promise<string> {
  if (kind === "document_pdf") {
    return outputPath;
  }

  const previewPath = join(outputDir, `${filename}.preview.html`);
  const html = await buildDocumentPreviewHtml(kind, payload, outputPath);
  await writeFile(previewPath, html, "utf8");
  return previewPath;
}

async function buildDocumentPreviewHtml(kind: string, payload: unknown, outputPath: string): Promise<string> {
  const data = payload as Record<string, unknown>;
  const docPayload =
    (data.document as Record<string, unknown> | undefined) ??
    (data.workbook as Record<string, unknown> | undefined) ??
    (data.presentation as Record<string, unknown> | undefined) ??
    data;

  if (kind === "document_docx") {
    return renderDocxPayloadAsHtml(docPayload as DocxDocumentPayload);
  }

  if (kind === "document_xlsx") {
    return renderWorkbookPayloadAsHtml(docPayload as XlsxWorkbookPayload);
  }

  if (kind === "document_pptx") {
    return renderPresentationPayloadAsHtml(docPayload as PptxPresentationPayload);
  }

  throw new Error(`Unsupported preview kind: ${kind}`);
}

async function renderDocxPayloadAsHtml(document: DocxDocumentPayload): Promise<string> {
  const sectionHtml: string[] = [];
  for (const section of document.sections ?? []) {
    const headingTag = section.level === 1 ? "h2" : section.level === 2 ? "h3" : "h4";
    const paragraphs: string[] = [];
    for (const paragraph of section.paragraphs) {
      switch (paragraph.type) {
        case "text":
          paragraphs.push(`<p>${await renderTextWithLatexToSvgHtml(paragraph.content)}</p>`);
          break;
        case "bullet":
          paragraphs.push(`<ul><li>${await renderTextWithLatexToSvgHtml(paragraph.content)}</li></ul>`);
          break;
        case "numbered":
          paragraphs.push(`<ol><li>${await renderTextWithLatexToSvgHtml(paragraph.content)}</li></ol>`);
          break;
        case "callout":
          paragraphs.push(`<div class="docx-callout docx-callout-${paragraph.style ?? "info"}">${await renderTextWithLatexToSvgHtml(paragraph.content)}</div>`);
          break;
        case "quote":
          paragraphs.push(`<blockquote>${await renderTextWithLatexToSvgHtml(paragraph.content)}</blockquote>`);
          break;
        case "citation_note":
          paragraphs.push(`<p class="docx-citation-note">${await renderTextWithLatexToSvgHtml(paragraph.content)}</p>`);
          break;
        case "math":
          {
            const { svg } = await renderLatexToSvg(paragraph.content, paragraph.display ?? true);
            paragraphs.push(`<div class="docx-math">${svg}</div>`);
            break;
          }
        case "svg":
          paragraphs.push(renderSvgFigureHtml(paragraph.svg, paragraph.caption, "docx-figure"));
          break;
        case "code":
          paragraphs.push(`<pre class="docx-code"><code>${escapeHtml(paragraph.content)}</code></pre>`);
          break;
        case "divider":
          paragraphs.push(`<hr />`);
          break;
        case "definition":
          paragraphs.push(`<div class="docx-definition"><strong>${escapeHtml(paragraph.term)}</strong><span>${await renderTextWithLatexToSvgHtml(paragraph.definition)}</span></div>`);
          break;
        case "kv":
          paragraphs.push(`<table><tbody>${(await Promise.all(paragraph.entries.map(async (entry) => `<tr><th>${escapeHtml(entry.key)}</th><td>${await renderTextWithLatexToSvgHtml(entry.value)}</td></tr>`))).join("")}</tbody></table>`);
          break;
        case "table":
          paragraphs.push(`<table><thead><tr>${(await Promise.all(paragraph.headers.map(async (header) => `<th>${await renderTextWithLatexToSvgHtml(header)}</th>`))).join("")}</tr></thead><tbody>${(await Promise.all(paragraph.rows.map(async (row) => `<tr>${(await Promise.all(row.map(async (cell) => `<td>${await renderTextWithLatexToSvgHtml(cell)}</td>`))).join("")}</tr>`))).join("")}</tbody></table>`);
          break;
      }
    }
    sectionHtml.push(`<section class="docx-section"><${headingTag}>${escapeHtml(section.heading)}</${headingTag}>${paragraphs.join("")}</section>`);
  }

  const sources = (document.citations ?? []).map((citation) => {
    const parts = [citation.relativePath || citation.sourceId, citation.locator, citation.excerpt].filter(Boolean);
    return `<li>${parts.map((part) => escapeHtml(String(part))).join(" — ")}</li>`;
  }).join("");

  return wrapPreviewHtml(
    `${sectionHtml.join("")}${sources ? `<section class="sources"><h2>References</h2><ul>${sources}</ul></section>` : ""}`,
    {
      maxWidth: 800,
      extraCss: "line-height:1.65;color:#333;table{border-collapse:collapse;width:100%;margin:1rem 0;background:#fff}th,td{border:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}th{background:#f5f5f5}.docx-callout{padding:0.9rem 1rem;border-left:4px solid;border-radius:10px;margin:0.85rem 0}.docx-callout-info{background:#eff6ff;border-color:#3b82f6}.docx-callout-tip{background:#ecfdf5;border-color:#10b981}.docx-callout-warning{background:#fffbeb;border-color:#f59e0b}.docx-callout-important{background:#fef2f2;border-color:#ef4444}.docx-definition{display:grid;grid-template-columns:minmax(140px,180px) 1fr;gap:0.75rem;padding:0.75rem 0;border-left:3px solid #d1d5db;padding-left:0.85rem}.docx-citation-note{color:#6b7280;font-size:0.92rem}.docx-code{background:#f3f4f6;border:1px solid #cbd5e1;border-radius:10px;padding:0.85rem;overflow:auto}.docx-math{padding:0.7rem 0.85rem;background:#f8fafc;border:1px solid #c7d2fe;border-radius:10px;margin:0.85rem 0;overflow:auto}.docx-figure,.slide-figure{margin:1rem 0;padding:0.85rem;background:#fff;border:1px solid #dbe4ff;border-radius:12px}.docx-figure svg,.slide-figure svg{display:block;max-width:100%;height:auto;margin:0 auto}.docx-figure figcaption,.slide-figure figcaption{margin-top:0.75rem;color:#6b7280;font-size:0.92rem;text-align:center}blockquote{border-left:4px solid #9ca3af;padding-left:0.85rem;color:#4b5563;font-style:italic;margin:0.85rem 0}.math-block{margin:0.5rem 0}",
    }
  );
}

function wrapPreviewHtml(body: string, options: { maxWidth: number; extraCss?: string }): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui,sans-serif;max-width:${options.maxWidth}px;margin:2rem auto;padding:0 1rem;background:#fafaf8}${options.extraCss ?? ""}</style></head><body>${body}</body></html>`;
}

async function renderWorkbookPayloadAsHtml(workbook: XlsxWorkbookPayload): Promise<string> {
  const renderedSheets = await Promise.all((workbook.sheets ?? []).map(async (sheet, index) => {
    const name = escapeHtml(sheet.name || `Sheet ${index + 1}`);
    const headers = (await Promise.all((sheet.columns ?? []).map(async (column, columnIndex) => {
      const header = typeof column.header === "string" && column.header.trim()
        ? column.header.trim()
        : `Column ${columnIndex + 1}`;
      return `<th>${await renderTextWithLatexToSvgHtml(header)}</th>`;
    }))).join("");
    const rows = (await Promise.all((sheet.rows ?? []).map(async (row) => {
      const cells = (await Promise.all(row.map(async (cell) => `<td>${await renderTextWithLatexToSvgHtml(formatWorkbookCell(cell))}</td>`))).join("");
      return `<tr>${cells}</tr>`;
    }))).join("");
    const meta: string[] = [];
    if ((sheet.frozenRows ?? 0) > 0 || (sheet.frozenColumns ?? 0) > 0) {
      meta.push(`Frozen panes: ${sheet.frozenRows ?? 0} row(s), ${sheet.frozenColumns ?? 0} column(s)`);
    }
    if (sheet.autoFilter) {
      meta.push("Auto filter enabled");
    }
    if ((sheet.merges?.length ?? 0) > 0) {
      meta.push(`${sheet.merges?.length} merged range${sheet.merges?.length === 1 ? "" : "s"}`);
    }
    return `<section class="sheet"><h2>${name}</h2>${meta.length > 0 ? `<p class="sheet-meta">${meta.map(escapeHtml).join(" · ")}</p>` : ""}<div class="sheet-table"><table>${headers ? `<thead><tr>${headers}</tr></thead>` : ""}<tbody>${rows}</tbody></table></div></section>`;
  }));

  const sourceNotes = (await Promise.all((workbook.sourceNotes ?? []).map(async (note) => `<li>${await renderTextWithLatexToSvgHtml(note)}</li>`))).join("");
  return wrapPreviewHtml(
    `${renderedSheets.join("")}${sourceNotes ? `<section class="sources"><h2>Sources</h2><ul>${sourceNotes}</ul></section>` : ""}`,
    {
      maxWidth: 1000,
      extraCss: ".sheet{margin:0 0 2rem;color:#333}.sheet-meta{color:#666;font-size:0.95rem}.sheet-table{overflow:auto;background:#fff;border-radius:12px}.sources{color:#444}table{border-collapse:collapse;width:100%;margin:1rem 0;background:#fff}th,td{border:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}th{background:#f5f5f5;font-weight:600}",
    }
  );
}

async function renderPresentationPayloadAsHtml(presentation: PptxPresentationPayload): Promise<string> {
  const slides = (await Promise.all((presentation.slides ?? []).map(async (slide, index) => {
    const title = "title" in slide ? slide.title : `Slide ${index + 1}`;
    const notes = Array.isArray(slide.notes) && slide.notes.length > 0
      ? `<details class="slide-notes"><summary>Presenter notes</summary><ul>${(await Promise.all(slide.notes.map(async (note) => `<li>${await renderTextWithLatexToSvgHtml(note)}</li>`))).join("")}</ul></details>`
      : "";
    let body = "";
    switch (slide.layout) {
      case "content":
        body = `<ul>${(await Promise.all(slide.bullets.map(async (bullet) => `<li>${await renderTextWithLatexToSvgHtml(bullet)}</li>`))).join("")}</ul>`;
        break;
      case "two_column":
        body = `<div class="two-col"><div><ul>${(await Promise.all(slide.left.map(async (item) => `<li>${await renderTextWithLatexToSvgHtml(item)}</li>`))).join("")}</ul></div><div><ul>${(await Promise.all(slide.right.map(async (item) => `<li>${await renderTextWithLatexToSvgHtml(item)}</li>`))).join("")}</ul></div></div>`;
        break;
      case "table":
        body = `<table><thead><tr>${(await Promise.all(slide.headers.map(async (header) => `<th>${await renderTextWithLatexToSvgHtml(header)}</th>`))).join("")}</tr></thead><tbody>${(await Promise.all(slide.rows.map(async (row) => `<tr>${(await Promise.all(row.map(async (cell) => `<td>${await renderTextWithLatexToSvgHtml(cell)}</td>`))).join("")}</tr>`))).join("")}</tbody></table>`;
        break;
      case "diagram":
        body = renderSvgFigureHtml(slide.svg, slide.caption, "slide-figure");
        break;
      case "title":
        body = slide.subtitle ? `<p class="subtitle">${await renderTextWithLatexToSvgHtml(slide.subtitle)}</p>` : "";
        break;
      case "sources":
        body = `<ul class="sources">${(await Promise.all(slide.entries.map(async (entry) => `<li>${await renderTextWithLatexToSvgHtml(entry)}</li>`))).join("")}</ul>`;
        break;
      case "section":
        body = `<p class="section-label">Section divider</p>`;
        break;
    }
    return `<article class="slide"><div class="slide-num">Slide ${index + 1}</div><h2>${await renderTextWithLatexToSvgHtml(title)}</h2>${body}${notes}</article>`;
  }))).join("");

  return wrapPreviewHtml(slides, {
    maxWidth: 900,
    extraCss: ".slide{background:#fff;border:1px solid #e0e0e0;border-radius:12px;padding:1.5rem;margin:1rem 0;box-shadow:0 1px 3px rgba(0,0,0,0.08);color:#333}.slide-num{font-size:0.75rem;color:#999;margin-bottom:0.5rem}.subtitle{color:#666;font-size:1.1rem}.two-col{display:flex;gap:2rem}.two-col>div{flex:1}.slide-notes{margin-top:1rem;color:#555}.sources{font-size:0.92rem;color:#555}table{border-collapse:collapse;width:100%;margin:0.75rem 0}th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}th{background:#f5f5f5}.section-label{font-size:0.92rem;letter-spacing:0.08em;text-transform:uppercase;color:#777}.slide-figure svg{display:block;max-width:100%;height:auto;margin:0 auto}",
  });
}

function formatWorkbookCell(value: XlsxWorkbookPayload["sheets"][number]["rows"][number][number]): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  const cell = value as XlsxCell;
  if (typeof cell.formula === "string" && cell.formula.trim()) {
    return `=${cell.formula.trim().replace(/^=/, "")}`;
  }
  if (cell.value === null || cell.value === undefined) {
    return "";
  }
  return String(cell.value);
}

function renderSvgFigureHtml(svg: string, caption?: string, className = "docx-figure"): string {
  const normalizedSvg = normalizeSvgForHtml(svg);
  const figcaption = caption?.trim() ? `<figcaption>${escapeHtml(caption)}</figcaption>` : "";
  return `<figure class="${className}">${normalizedSvg}${figcaption}</figure>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
