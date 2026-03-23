/**
 * Document renderer — converts structured JSON payloads into binary
 * Office and PDF files. DOCX/XLSX/PPTX are written directly as
 * OpenXML packages; PDF remains library-backed.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CitationRef } from "@stuart/shared";
import {
  renderDocxOpenXml,
  renderPptxOpenXml,
  renderXlsxOpenXml,
} from "./openxml-renderer.js";
import {
  renderLatexToPlainText,
  renderLatexToSvg,
  renderTextWithLatexToPlainText,
} from "./math-rendering.js";
import {
  clampSize,
  getSvgDimensions,
  normalizeSvgForHtml,
  pxToPt,
} from "./svg-rendering.js";

// ---- Shared citation formatter ----

function formatCitations(citations: CitationRef[]): string[] {
  return citations.map((c, i) => {
    const parts: string[] = [`[${i + 1}]`];
    if (c.excerpt) parts.push(`"${c.excerpt}"`);
    const source = c.relativePath || c.sourceId;
    if (source) parts.push(`— ${source}`);
    if (c.locator) parts.push(`(${c.locator})`);
    return parts.join(" ");
  });
}

// ---- PDF Renderer ----

// Color palette for callout styles
const CALLOUT_STYLES: Record<string, { bg: string; border: string; text: string; icon: string }> = {
  info:      { bg: "#EBF5FF", border: "#3B82F6", text: "#1E40AF", icon: "i" },
  tip:       { bg: "#ECFDF5", border: "#10B981", text: "#065F46", icon: "!" },
  warning:   { bg: "#FFFBEB", border: "#F59E0B", text: "#92400E", icon: "!" },
  important: { bg: "#FEF2F2", border: "#EF4444", text: "#991B1B", icon: "!" },
};

interface PdfColumn {
  x: number;
  width: number;
  y: number;
}

async function renderPdf(
  payload: Record<string, unknown>,
  outputPath: string
): Promise<void> {
  const PDFDocumentModule = await import("pdfkit");
  const PDFDocument =
    "default" in PDFDocumentModule
      ? (PDFDocumentModule.default as typeof import("pdfkit"))
      : (PDFDocumentModule as unknown as typeof import("pdfkit"));

  const { createWriteStream } = await import("node:fs");

  const doc = payload as {
    pageSize?: string;
    columns?: number;
    metadata?: { author?: string; subject?: string; description?: string };
    citations?: CitationRef[];
    sections?: Array<{
      heading: string;
      level: number;
      paragraphs: Array<Record<string, unknown>>;
    }>;
  };

  const pageSize = doc.pageSize === "letter" ? "LETTER" : "A4";
  const numCols = doc.columns === 2 ? 2 : 1;
  const margin = numCols === 2 ? 36 : 50;
  const colGap = numCols === 2 ? 18 : 0;

  const pdf = new PDFDocument({
    size: pageSize,
    bufferPages: true,
    margins: { top: margin, bottom: margin, left: margin, right: margin },
    info: {
      Title: doc.metadata?.subject ?? "",
      Author: doc.metadata?.author ?? "Stuart",
    },
  });

  const stream = createWriteStream(outputPath);
  pdf.pipe(stream);

  const pageW = pdf.page.width;
  const usableW = pageW - margin * 2;
  const colW = numCols === 2 ? (usableW - colGap) / 2 : usableW;

  // Font sizes — compact for cheat sheets
  const baseFontSize = numCols === 2 ? 7.5 : 11;
  const h1Size = numCols === 2 ? 11 : 20;
  const h2Size = numCols === 2 ? 9.5 : 16;
  const h3Size = numCols === 2 ? 8.5 : 13;
  const headingSizes: Record<number, number> = { 1: h1Size, 2: h2Size, 3: h3Size };
  const headingColors: Record<number, string> = { 1: "#1a1a2e", 2: "#16213e", 3: "#0f3460" };

  // Title header
  const title = doc.metadata?.subject ?? doc.metadata?.description ?? "";
  if (title) {
    pdf
      .fontSize(numCols === 2 ? 13 : 22)
      .font("Helvetica-Bold")
      .fillColor("#111111")
      .text(title, margin, margin, { width: usableW, align: "center" });

    // Underline bar
    const barY = pdf.y + 3;
    pdf
      .moveTo(margin, barY)
      .lineTo(pageW - margin, barY)
      .lineWidth(1.5)
      .strokeColor("#2962FF")
      .stroke();
    pdf.y = barY + (numCols === 2 ? 6 : 12);
  }

  // Column state for two-column layout
  let col: PdfColumn = { x: margin, width: colW, y: pdf.y };
  let currentCol = 0;
  const pageBottom = pdf.page.height - margin;

  function switchToNextCol() {
    if (numCols === 2 && currentCol === 0) {
      currentCol = 1;
      col = { x: margin + colW + colGap, width: colW, y: title ? pdf.y : margin };
      // Reset y to top of column — use the saved starting y of col 0
      col.y = colStartY;
      pdf.x = col.x;
      pdf.y = col.y;
    } else {
      // New page
      pdf.addPage();
      currentCol = 0;
      col = { x: margin, width: colW, y: margin };
      pdf.x = col.x;
      pdf.y = col.y;
      colStartY = margin;
    }
  }

  let colStartY = pdf.y;

  function ensureSpace(needed: number) {
    if (pdf.y + needed > pageBottom) {
      switchToNextCol();
    }
  }

  // Helper to draw a rounded rect background
  function drawRoundedBg(x: number, y: number, w: number, h: number, bgColor: string, borderColor?: string) {
    const r = 3;
    pdf.save();
    pdf.roundedRect(x, y, w, h, r).fillColor(bgColor).fill();
    if (borderColor) {
      pdf.roundedRect(x, y, w, h, r).lineWidth(0.75).strokeColor(borderColor).stroke();
    }
    pdf.restore();
  }

  // Helper: draw a table with proper borders and alternating rows
  function drawTable(headers: string[], rows: string[][], x: number, width: number) {
    const renderedHeaders = headers.map((header) => renderTextWithLatexToPlainText(header));
    const renderedRows = rows.map((row) => row.map((cell) => renderTextWithLatexToPlainText(String(cell ?? ""))));
    const nCols = headers.length;
    const cellPad = 3;
    const fontSize = Math.max(baseFontSize - 1, 6);
    const cellW = width / nCols;
    const rowH = fontSize + cellPad * 2 + 2;

    const totalH = rowH * (rows.length + 1);
    ensureSpace(totalH + 4);

    let tableY = pdf.y;

    // Header row background
    drawRoundedBg(x, tableY, width, rowH, "#2962FF");

    pdf.fontSize(fontSize).font("Helvetica-Bold").fillColor("#FFFFFF");
    for (let ci = 0; ci < nCols; ci++) {
      pdf.text(renderedHeaders[ci] ?? "", x + ci * cellW + cellPad, tableY + cellPad, {
        width: cellW - cellPad * 2,
        height: rowH,
        lineBreak: false,
      });
    }
    tableY += rowH;

    // Data rows
    pdf.font("Helvetica").fillColor("#222222");
    for (let ri = 0; ri < rows.length; ri++) {
      const row = renderedRows[ri]!;
      const bgColor = ri % 2 === 0 ? "#F8F9FA" : "#FFFFFF";
      pdf.save();
      pdf.rect(x, tableY, width, rowH).fillColor(bgColor).fill();
      pdf.restore();

      // Row borders
      pdf.save();
      pdf.moveTo(x, tableY + rowH).lineTo(x + width, tableY + rowH)
        .lineWidth(0.3).strokeColor("#DEE2E6").stroke();
      pdf.restore();

      pdf.fontSize(fontSize).font("Helvetica").fillColor("#222222");
      for (let ci = 0; ci < nCols; ci++) {
        pdf.text(String(row[ci] ?? ""), x + ci * cellW + cellPad, tableY + cellPad, {
          width: cellW - cellPad * 2,
          height: rowH,
          lineBreak: false,
        });
      }
      tableY += rowH;
    }

    // Outer border
    pdf.save();
    pdf.rect(x, pdf.y, width, tableY - pdf.y)
      .lineWidth(0.5).strokeColor("#CED4DA").stroke();
    // Column dividers
    for (let ci = 1; ci < nCols; ci++) {
      pdf.moveTo(x + ci * cellW, pdf.y).lineTo(x + ci * cellW, tableY)
        .lineWidth(0.3).strokeColor("#DEE2E6").stroke();
    }
    pdf.restore();

    pdf.y = tableY + 4;
    pdf.x = col.x;
  }

  let numberedCounter = 0;

  for (const section of doc.sections ?? []) {
    const fontSize = headingSizes[section.level] ?? h1Size;
    const headingColor = headingColors[section.level] ?? "#111111";

    ensureSpace(fontSize + 10);

    // Section heading with colored left border for H1
    if (section.level === 1) {
      const headY = pdf.y;
      pdf.save();
      pdf.rect(col.x, headY, 3, fontSize + 2).fillColor("#2962FF").fill();
      pdf.restore();
      pdf.fontSize(fontSize).font("Helvetica-Bold").fillColor(headingColor)
        .text(section.heading.toUpperCase(), col.x + 8, headY, { width: col.width - 8 });
      // Thin line under H1
      const lineY = pdf.y + 1;
      pdf.save();
      pdf.moveTo(col.x, lineY).lineTo(col.x + col.width, lineY)
        .lineWidth(0.5).strokeColor("#DEE2E6").stroke();
      pdf.restore();
      pdf.y = lineY + 4;
    } else if (section.level === 2) {
      pdf.fontSize(fontSize).font("Helvetica-Bold").fillColor(headingColor)
        .text(section.heading, col.x, pdf.y, { width: col.width });
      pdf.y += 2;
    } else {
      pdf.fontSize(fontSize).font("Helvetica-Bold").fillColor(headingColor)
        .text(section.heading, col.x, pdf.y, { width: col.width });
      pdf.y += 1;
    }

    numberedCounter = 0;

    for (const para of section.paragraphs ?? []) {
      const pType = para.type as string;
      const content = (para.content as string) ?? "";
      const renderedContent = renderTextWithLatexToPlainText(content);

      switch (pType) {
        case "text":
          ensureSpace(baseFontSize + 4);
          pdf.fontSize(baseFontSize).font("Helvetica").fillColor("#333333")
            .text(renderedContent, col.x, pdf.y, { width: col.width, lineGap: 1.5 });
          pdf.y += 3;
          break;

        case "bullet":
          ensureSpace(baseFontSize + 2);
          pdf.fontSize(baseFontSize).font("Helvetica").fillColor("#333333");
          // Draw bullet dot
          pdf.save();
          pdf.circle(col.x + 4, pdf.y + baseFontSize / 2, 1.5).fillColor("#2962FF").fill();
          pdf.restore();
          pdf.fillColor("#333333");
          pdf.text(renderedContent, col.x + 10, pdf.y, { width: col.width - 10, lineGap: 1 });
          pdf.y += 1;
          break;

        case "numbered":
          numberedCounter++;
          ensureSpace(baseFontSize + 2);
          pdf.fontSize(baseFontSize).font("Helvetica-Bold").fillColor("#2962FF")
            .text(`${numberedCounter}.`, col.x, pdf.y, { continued: false, width: 14 });
          // Go back up to same line
          pdf.y -= baseFontSize + 2;
          pdf.fontSize(baseFontSize).font("Helvetica").fillColor("#333333")
            .text(renderedContent, col.x + 14, pdf.y, { width: col.width - 14, lineGap: 1 });
          pdf.y += 1;
          break;

        case "callout": {
          const style = CALLOUT_STYLES[(para.style as string) ?? "info"] ?? CALLOUT_STYLES.info!;
          const calloutFontSize = baseFontSize - 0.5;
          // Measure text height
          const textH = pdf.fontSize(calloutFontSize).font("Helvetica")
            .heightOfString(renderedContent, { width: col.width - 14 });
          const boxH = textH + 8;
          ensureSpace(boxH + 4);

          const boxY = pdf.y;
          // Background
          drawRoundedBg(col.x, boxY, col.width, boxH, style.bg, style.border);
          // Left accent bar
          pdf.save();
          pdf.rect(col.x, boxY, 3, boxH).fillColor(style.border).fill();
          pdf.restore();

          pdf.fontSize(calloutFontSize).font("Helvetica-Bold").fillColor(style.text)
            .text(renderedContent, col.x + 8, boxY + 4, { width: col.width - 14, lineGap: 1 });
          pdf.y = boxY + boxH + 4;
          break;
        }

        case "quote": {
          ensureSpace(baseFontSize + 8);
          const quoteY = pdf.y;
          // Left bar
          pdf.save();
          pdf.rect(col.x + 2, quoteY, 2, baseFontSize + 6).fillColor("#6B7280").fill();
          pdf.restore();
          pdf.fontSize(baseFontSize).font("Helvetica-Oblique").fillColor("#4B5563")
            .text(`"${renderedContent}"`, col.x + 10, quoteY + 2, { width: col.width - 14, lineGap: 1 });
          pdf.y += 4;
          break;
        }

        case "citation_note":
          ensureSpace(baseFontSize);
          pdf.fontSize(Math.max(baseFontSize - 2, 5.5)).font("Helvetica-Oblique").fillColor("#9CA3AF")
            .text(renderedContent, col.x, pdf.y, { width: col.width, lineGap: 0.5 });
          pdf.y += 2;
          break;

        case "math": {
          const display = (para.display as boolean) ?? false;
          try {
            const { svg, widthPt, heightPt } = await renderLatexToSvg(content, display);
            const SVGToPDFModule = await import("svg-to-pdfkit");
            const SVGToPDF = (SVGToPDFModule.default ?? SVGToPDFModule) as
              (doc: unknown, svg: string, x: number, y: number, options?: Record<string, unknown>) => void;
            const maxWidth = col.width - 20;
            const scale = Math.min(1, maxWidth / Math.max(widthPt, 1));
            const drawWidth = Math.max(24, widthPt * scale);
            const drawHeight = Math.max(18, heightPt * scale);
            const boxH = drawHeight + 14;
            ensureSpace(boxH + 4);

            const boxY = pdf.y;
            drawRoundedBg(col.x, boxY, col.width, boxH, "#F8FAFC", "#C7D2FE");
            const drawX = display
              ? col.x + Math.max(10, (col.width - drawWidth) / 2)
              : col.x + 10;
            SVGToPDF(pdf, svg, drawX, boxY + 7, {
              width: drawWidth,
              height: drawHeight,
              preserveAspectRatio: "xMidYMid meet",
            });
            pdf.y = boxY + boxH + 3;
          } catch {
            const rendered = renderLatexToPlainText(content);
            const mathFontSize = display ? baseFontSize + 1 : baseFontSize;
            const textH = pdf.fontSize(mathFontSize).font("Courier")
              .heightOfString(rendered, { width: col.width - 16 });
            const boxH = textH + 10;
            ensureSpace(boxH + 4);

            const boxY = pdf.y;
            drawRoundedBg(col.x, boxY, col.width, boxH, "#F5F3FF", "#8B5CF6");
            pdf.fontSize(mathFontSize).font("Courier").fillColor("#5B21B6")
              .text(rendered, col.x + 8, boxY + 5, {
                width: col.width - 16,
                align: display ? "center" : "left",
                lineGap: 1.5,
              });
            pdf.y = boxY + boxH + 3;
          }
          break;
        }

        case "svg": {
          try {
            const SVGToPDFModule = await import("svg-to-pdfkit");
            const SVGToPDF = (SVGToPDFModule.default ?? SVGToPDFModule) as
              (doc: unknown, svg: string, x: number, y: number, options?: Record<string, unknown>) => void;
            const svgMarkup = normalizeSvgForHtml(String(para.svg ?? ""));
            const { widthPx, heightPx } = getSvgDimensions(svgMarkup);
            const caption = typeof para.caption === "string" ? renderTextWithLatexToPlainText(para.caption) : "";
            const maxWidth = col.width - 20;
            const maxHeight = Math.min(220, pageBottom - pdf.y - 32);
            const scaled = clampSize(pxToPt(widthPx), pxToPt(heightPx), maxWidth, Math.max(48, maxHeight));
            const figureHeight = scaled.height + (caption ? baseFontSize + 12 : 12);
            ensureSpace(figureHeight + 4);

            const boxY = pdf.y;
            drawRoundedBg(col.x, boxY, col.width, figureHeight, "#FFFFFF", "#DBE4FF");
            const drawX = col.x + Math.max(10, (col.width - scaled.width) / 2);
            SVGToPDF(pdf, svgMarkup, drawX, boxY + 6, {
              width: scaled.width,
              height: scaled.height,
              preserveAspectRatio: "xMidYMid meet",
            });
            if (caption) {
              pdf.fontSize(Math.max(baseFontSize - 1, 6.5)).font("Helvetica-Oblique").fillColor("#6B7280")
                .text(caption, col.x + 12, boxY + scaled.height + 8, {
                  width: col.width - 24,
                  align: "center",
                });
            }
            pdf.y = boxY + figureHeight + 3;
            pdf.fillColor("#333333");
          } catch {
            ensureSpace(baseFontSize + 8);
            pdf.fontSize(baseFontSize).font("Helvetica-Oblique").fillColor("#6B7280")
              .text("[Diagram unavailable]", col.x, pdf.y, { width: col.width, align: "center" });
            pdf.y += 4;
          }
          break;
        }

        case "code": {
          const codeFontSize = Math.max(baseFontSize - 1, 6);
          const textH = pdf.fontSize(codeFontSize).font("Courier")
            .heightOfString(content, { width: col.width - 16 });
          const boxH = textH + 10;
          ensureSpace(boxH + 4);

          const boxY = pdf.y;
          drawRoundedBg(col.x, boxY, col.width, boxH, "#1E293B");
          pdf.fontSize(codeFontSize).font("Courier").fillColor("#E2E8F0")
            .text(content, col.x + 8, boxY + 5, { width: col.width - 16, lineGap: 1.5 });
          pdf.y = boxY + boxH + 3;
          pdf.fillColor("#333333");
          break;
        }

        case "divider":
          ensureSpace(8);
          pdf.save();
          const divY = pdf.y + 3;
          pdf.moveTo(col.x + 10, divY).lineTo(col.x + col.width - 10, divY)
            .lineWidth(0.5).strokeColor("#E5E7EB").dash(3, { space: 3 }).stroke();
          pdf.restore();
          pdf.y = divY + 6;
          break;

        case "definition": {
          const term = renderTextWithLatexToPlainText((para.term as string) ?? "");
          const def = renderTextWithLatexToPlainText((para.definition as string) ?? "");
          ensureSpace(baseFontSize * 2 + 4);
          pdf.fontSize(baseFontSize).font("Helvetica-Bold").fillColor("#1E40AF")
            .text(term, col.x, pdf.y, { width: col.width, continued: false });
          pdf.fontSize(baseFontSize).font("Helvetica").fillColor("#374151")
            .text(def, col.x + 8, pdf.y, { width: col.width - 8, lineGap: 1 });
          pdf.y += 2;
          break;
        }

        case "kv": {
          const entries = (para.entries as Array<{ key: string; value: string }>) ?? [];
          for (const entry of entries) {
            ensureSpace(baseFontSize + 2);
            const kvX = col.x;
            const kvW = col.width;
            const keyW = Math.min(kvW * 0.35, 120);
            pdf.fontSize(baseFontSize).font("Helvetica-Bold").fillColor("#374151")
              .text(renderTextWithLatexToPlainText(entry.key), kvX, pdf.y, { width: keyW, continued: false });
            pdf.y -= baseFontSize + 2;
            pdf.fontSize(baseFontSize).font("Helvetica").fillColor("#555555")
              .text(renderTextWithLatexToPlainText(entry.value), kvX + keyW, pdf.y, { width: kvW - keyW, lineGap: 1 });
            pdf.y += 1;
          }
          pdf.y += 2;
          break;
        }

        case "table": {
          const headers = (para.headers as string[]) ?? [];
          const rows = (para.rows as string[][]) ?? [];
          if (headers.length > 0) {
            drawTable(headers, rows, col.x, col.width);
          }
          break;
        }
      }
    }

    pdf.y += numCols === 2 ? 4 : 8;
  }

  // Bibliography section — compact at bottom
  const citations = doc.citations ?? [];
  if (citations.length > 0) {
    ensureSpace(20);
    pdf.save();
    pdf.moveTo(col.x, pdf.y).lineTo(col.x + col.width, pdf.y)
      .lineWidth(0.5).strokeColor("#D1D5DB").stroke();
    pdf.restore();
    pdf.y += 4;
    const refFontSize = Math.max(baseFontSize - 2, 5);
    pdf.fontSize(refFontSize + 1).font("Helvetica-Bold").fillColor("#6B7280")
      .text("REFERENCES", col.x, pdf.y, { width: col.width });
    pdf.y += 2;
    for (const line of formatCitations(citations)) {
      pdf.fontSize(refFontSize).font("Helvetica").fillColor("#9CA3AF")
        .text(renderTextWithLatexToPlainText(line), col.x, pdf.y, { width: col.width, lineGap: 0.5 });
    }
  }

  // Footer on each page
  const pages = pdf.bufferedPageRange();
  for (let i = pages.start; i < pages.start + pages.count; i++) {
    pdf.switchToPage(i);
    pdf.fontSize(6).font("Helvetica").fillColor("#BBBBBB")
      .text(`Generated by Stuart`, margin, pdf.page.height - margin + 10, {
        width: usableW,
        align: "center",
      });
  }

  pdf.end();

  await new Promise<void>((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

// ---- Public API ----

export async function renderDocument(
  kind: string,
  payload: unknown,
  outputDir: string,
  filename: string
): Promise<string> {
  await mkdir(outputDir, { recursive: true });

  const data = payload as Record<string, unknown>;

  // For document kinds, the payload is nested under a key
  const docPayload =
    (data.document as Record<string, unknown>) ??
    (data.workbook as Record<string, unknown>) ??
    (data.presentation as Record<string, unknown>) ??
    data;

  const ext = kind.replace("document_", "");
  const outputPath = join(outputDir, `${filename}.${ext}`);

  switch (kind) {
    case "document_docx":
      await renderDocxOpenXml(docPayload as Parameters<typeof renderDocxOpenXml>[0], outputPath);
      break;
    case "document_xlsx":
      await renderXlsxOpenXml(docPayload as Parameters<typeof renderXlsxOpenXml>[0], outputPath);
      break;
    case "document_pptx":
      await renderPptxOpenXml(docPayload as Parameters<typeof renderPptxOpenXml>[0], outputPath);
      break;
    case "document_pdf":
      await renderPdf(docPayload, outputPath);
      break;
    default:
      throw new Error(`Unknown document kind: ${kind}`);
  }

  return outputPath;
}
