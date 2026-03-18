/**
 * Document renderer — converts structured JSON payloads into binary
 * DOCX, XLSX, PPTX, and PDF files using dedicated libraries.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CitationRef } from "@stuart/shared";

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

// ---- DOCX Renderer ----

async function renderDocx(
  payload: Record<string, unknown>,
  outputPath: string
): Promise<void> {
  const {
    Document,
    Paragraph,
    TextRun,
    HeadingLevel,
    Packer,
    Table,
    TableRow,
    TableCell,
    WidthType,
    BorderStyle,
    ShadingType,
    AlignmentType,
  } = await import("docx");

  const doc = payload as {
    metadata?: { author?: string; subject?: string; description?: string };
    citations?: CitationRef[];
    sections?: Array<{
      heading: string;
      level: number;
      paragraphs: Array<Record<string, unknown>>;
    }>;
  };

  const children: Array<
    InstanceType<typeof Paragraph> | InstanceType<typeof Table>
  > = [];

  const headingMap: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
  };

  for (const section of doc.sections ?? []) {
    // Section heading
    children.push(
      new Paragraph({
        heading: headingMap[section.level] ?? HeadingLevel.HEADING_1,
        children: [
          new TextRun({
            text: section.heading,
            bold: true,
            size: section.level === 1 ? 36 : section.level === 2 ? 30 : 26,
          }),
        ],
      })
    );

    for (const para of section.paragraphs ?? []) {
      const pType = para.type as string;
      const content = (para.content as string) ?? "";

      switch (pType) {
        case "text":
          children.push(
            new Paragraph({
              children: [new TextRun({ text: content, size: 24 })],
              spacing: { after: 120 },
            })
          );
          break;

        case "bullet":
          children.push(
            new Paragraph({
              bullet: { level: 0 },
              children: [new TextRun({ text: content, size: 24 })],
            })
          );
          break;

        case "numbered":
          children.push(
            new Paragraph({
              numbering: { reference: "default-numbering", level: 0 },
              children: [new TextRun({ text: content, size: 24 })],
            })
          );
          break;

        case "callout":
          children.push(
            new Paragraph({
              shading: { type: ShadingType.SOLID, color: "E8F0FE", fill: "E8F0FE" },
              children: [new TextRun({ text: `💡 ${content}`, size: 24, italics: true })],
              spacing: { before: 120, after: 120 },
              indent: { left: 360, right: 360 },
            })
          );
          break;

        case "citation_note":
          children.push(
            new Paragraph({
              children: [
                new TextRun({ text: content, size: 20, italics: true, color: "666666" }),
              ],
              spacing: { after: 60 },
            })
          );
          break;

        case "table": {
          const headers = (para.headers as string[]) ?? [];
          const rows = (para.rows as string[][]) ?? [];

          if (headers.length > 0) {
            const headerRow = new TableRow({
              children: headers.map(
                (h) =>
                  new TableCell({
                    children: [
                      new Paragraph({
                        children: [new TextRun({ text: h, bold: true, size: 22 })],
                        alignment: AlignmentType.CENTER,
                      }),
                    ],
                    shading: { type: ShadingType.SOLID, color: "E0E0E0", fill: "E0E0E0" },
                  })
              ),
            });

            const dataRows = rows.map(
              (row) =>
                new TableRow({
                  children: headers.map(
                    (_, ci) =>
                      new TableCell({
                        children: [
                          new Paragraph({
                            children: [
                              new TextRun({ text: String(row[ci] ?? ""), size: 22 }),
                            ],
                          }),
                        ],
                      })
                  ),
                })
            );

            children.push(
              new Table({
                rows: [headerRow, ...dataRows],
                width: { size: 100, type: WidthType.PERCENTAGE },
                borders: {
                  top: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
                  bottom: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
                  left: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
                  right: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
                  insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
                  insideVertical: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
                },
              })
            );
          }
          break;
        }
      }
    }
  }

  // Endnotes section from citations
  const citations = doc.citations ?? [];
  if (citations.length > 0) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: "References", bold: true, size: 36 })],
        spacing: { before: 400 },
      })
    );
    for (const line of formatCitations(citations)) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: line, size: 20, color: "444444" })],
          spacing: { after: 60 },
        })
      );
    }
  }

  const document = new Document({
    creator: doc.metadata?.author ?? "Stuart",
    description: doc.metadata?.description ?? "",
    numbering: {
      config: [
        {
          reference: "default-numbering",
          levels: [
            {
              level: 0,
              format: "decimal" as unknown as (typeof import("docx"))["LevelFormat"]["DECIMAL"],
              text: "%1.",
              alignment: AlignmentType.LEFT,
            },
          ],
        },
      ],
    },
    sections: [{ children }],
  });

  const buffer = await Packer.toBuffer(document);
  await writeFile(outputPath, buffer);
}

// ---- XLSX Renderer ----

async function renderXlsx(
  payload: Record<string, unknown>,
  outputPath: string
): Promise<void> {
  const XLSX = await import("xlsx");

  const wb = payload as {
    sheets?: Array<{
      name: string;
      columns?: Array<{ header: string; width?: number }>;
      rows?: (string | number | boolean | null)[][];
    }>;
    sourceNotes?: string[];
  };

  const workbook = XLSX.utils.book_new();

  for (const sheet of wb.sheets ?? []) {
    const headers = (sheet.columns ?? []).map((c) => c.header);
    const aoa = [headers, ...(sheet.rows ?? [])];
    const ws = XLSX.utils.aoa_to_sheet(aoa);

    // Apply column widths
    if (sheet.columns) {
      ws["!cols"] = sheet.columns.map((c) => ({ wch: c.width ?? 15 }));
    }

    XLSX.utils.book_append_sheet(workbook, ws, sheet.name || "Sheet1");
  }

  // Add Sources sheet if sourceNotes are present
  if (wb.sourceNotes && wb.sourceNotes.length > 0) {
    const sourcesAoa = [["Source"], ...wb.sourceNotes.map((n) => [n])];
    const sourcesWs = XLSX.utils.aoa_to_sheet(sourcesAoa);
    sourcesWs["!cols"] = [{ wch: 80 }];
    XLSX.utils.book_append_sheet(workbook, sourcesWs, "Sources");
  }

  XLSX.writeFile(workbook, outputPath);
}

// ---- PPTX Renderer ----

async function renderPptx(
  payload: Record<string, unknown>,
  outputPath: string
): Promise<void> {
  const pptxModule = await import("pptxgenjs");
  const PptxGenJS = pptxModule.default ?? pptxModule;
  const pres = new (PptxGenJS as unknown as new () => import("pptxgenjs").default)();

  const data = payload as {
    theme?: { primaryColor?: string; fontFamily?: string };
    citations?: CitationRef[];
    slides?: Array<Record<string, unknown>>;
  };

  const primaryColor = data.theme?.primaryColor?.replace("#", "") ?? "2962FF";
  const fontFamily = data.theme?.fontFamily ?? "Arial";

  pres.layout = "LAYOUT_WIDE";

  for (const slide of data.slides ?? []) {
    const layout = slide.layout as string;
    const s = pres.addSlide();

    switch (layout) {
      case "title": {
        s.addText(String(slide.title ?? ""), {
          x: 0.5,
          y: 1.5,
          w: "90%",
          h: 1.5,
          fontSize: 36,
          fontFace: fontFamily,
          color: primaryColor,
          bold: true,
          align: "center",
        });
        if (slide.subtitle) {
          s.addText(String(slide.subtitle), {
            x: 0.5,
            y: 3.2,
            w: "90%",
            h: 0.8,
            fontSize: 18,
            fontFace: fontFamily,
            color: "666666",
            align: "center",
          });
        }
        break;
      }

      case "content": {
        s.addText(String(slide.title ?? ""), {
          x: 0.5,
          y: 0.3,
          w: "90%",
          h: 0.8,
          fontSize: 24,
          fontFace: fontFamily,
          color: primaryColor,
          bold: true,
        });
        const bullets = (slide.bullets as string[]) ?? [];
        s.addText(
          bullets.map((b) => ({
            text: b,
            options: { bullet: true, fontSize: 16, fontFace: fontFamily, color: "333333" },
          })),
          { x: 0.7, y: 1.3, w: "85%", h: 4.5, valign: "top" }
        );
        break;
      }

      case "two_column": {
        s.addText(String(slide.title ?? ""), {
          x: 0.5,
          y: 0.3,
          w: "90%",
          h: 0.8,
          fontSize: 24,
          fontFace: fontFamily,
          color: primaryColor,
          bold: true,
        });
        const left = (slide.left as string[]) ?? [];
        const right = (slide.right as string[]) ?? [];
        s.addText(
          left.map((b) => ({
            text: b,
            options: { bullet: true, fontSize: 14, fontFace: fontFamily, color: "333333" },
          })),
          { x: 0.5, y: 1.3, w: "45%", h: 4.5, valign: "top" }
        );
        s.addText(
          right.map((b) => ({
            text: b,
            options: { bullet: true, fontSize: 14, fontFace: fontFamily, color: "333333" },
          })),
          { x: 5.5, y: 1.3, w: "45%", h: 4.5, valign: "top" }
        );
        break;
      }

      case "table": {
        s.addText(String(slide.title ?? ""), {
          x: 0.5,
          y: 0.3,
          w: "90%",
          h: 0.8,
          fontSize: 24,
          fontFace: fontFamily,
          color: primaryColor,
          bold: true,
        });
        const headers = (slide.headers as string[]) ?? [];
        const rows = (slide.rows as string[][]) ?? [];
        const tableRows = [
          headers.map((h) => ({
            text: h,
            options: { bold: true, fontSize: 14, fontFace: fontFamily, fill: { color: "E0E0E0" } },
          })),
          ...rows.map((row) =>
            headers.map((_, ci) => ({
              text: String(row[ci] ?? ""),
              options: { fontSize: 12, fontFace: fontFamily },
            }))
          ),
        ];
        s.addTable(tableRows as Parameters<typeof s.addTable>[0], {
          x: 0.5,
          y: 1.3,
          w: 9,
          border: { pt: 0.5, color: "CCCCCC" },
        });
        break;
      }

      case "section": {
        s.addText(String(slide.title ?? ""), {
          x: 0.5,
          y: 2,
          w: "90%",
          h: 1.5,
          fontSize: 32,
          fontFace: fontFamily,
          color: primaryColor,
          bold: true,
          align: "center",
        });
        break;
      }

      case "sources": {
        const entries = (slide.entries as string[]) ?? [];
        s.addText("References", {
          x: 0.5,
          y: 0.3,
          w: "90%",
          h: 0.8,
          fontSize: 24,
          fontFace: fontFamily,
          color: primaryColor,
          bold: true,
        });
        s.addText(
          entries.map((e) => ({
            text: e,
            options: { fontSize: 11, fontFace: fontFamily, color: "555555", bullet: true },
          })),
          { x: 0.7, y: 1.3, w: "85%", h: 4.5, valign: "top" }
        );
        break;
      }
    }
  }

  // Auto-generated references slide from citations
  const citations = data.citations ?? [];
  if (citations.length > 0) {
    const refSlide = pres.addSlide();
    refSlide.addText("References", {
      x: 0.5,
      y: 0.3,
      w: "90%",
      h: 0.8,
      fontSize: 24,
      fontFace: fontFamily,
      color: primaryColor,
      bold: true,
    });
    refSlide.addText(
      formatCitations(citations).map((line) => ({
        text: line,
        options: { fontSize: 10, fontFace: fontFamily, color: "555555", bullet: true },
      })),
      { x: 0.7, y: 1.3, w: "85%", h: 4.5, valign: "top" }
    );
  }

  await pres.writeFile({ fileName: outputPath });
}

// ---- PDF Renderer ----

// Unicode-friendly math symbol replacement for LaTeX-like expressions
function renderMathText(raw: string): string {
  return raw
    // Greek letters
    .replace(/\\alpha/g, "\u03B1").replace(/\\beta/g, "\u03B2").replace(/\\gamma/g, "\u03B3")
    .replace(/\\delta/g, "\u03B4").replace(/\\epsilon/g, "\u03B5").replace(/\\zeta/g, "\u03B6")
    .replace(/\\eta/g, "\u03B7").replace(/\\theta/g, "\u03B8").replace(/\\iota/g, "\u03B9")
    .replace(/\\kappa/g, "\u03BA").replace(/\\lambda/g, "\u03BB").replace(/\\mu/g, "\u03BC")
    .replace(/\\nu/g, "\u03BD").replace(/\\xi/g, "\u03BE").replace(/\\pi/g, "\u03C0")
    .replace(/\\rho/g, "\u03C1").replace(/\\sigma/g, "\u03C3").replace(/\\tau/g, "\u03C4")
    .replace(/\\phi/g, "\u03C6").replace(/\\chi/g, "\u03C7").replace(/\\psi/g, "\u03C8")
    .replace(/\\omega/g, "\u03C9")
    .replace(/\\Gamma/g, "\u0393").replace(/\\Delta/g, "\u0394").replace(/\\Theta/g, "\u0398")
    .replace(/\\Lambda/g, "\u039B").replace(/\\Pi/g, "\u03A0").replace(/\\Sigma/g, "\u03A3")
    .replace(/\\Phi/g, "\u03A6").replace(/\\Psi/g, "\u03A8").replace(/\\Omega/g, "\u03A9")
    // Operators and symbols
    .replace(/\\times/g, "\u00D7").replace(/\\div/g, "\u00F7").replace(/\\cdot/g, "\u00B7")
    .replace(/\\pm/g, "\u00B1").replace(/\\mp/g, "\u2213")
    .replace(/\\leq/g, "\u2264").replace(/\\geq/g, "\u2265").replace(/\\neq/g, "\u2260")
    .replace(/\\approx/g, "\u2248").replace(/\\equiv/g, "\u2261")
    .replace(/\\infty/g, "\u221E").replace(/\\partial/g, "\u2202")
    .replace(/\\nabla/g, "\u2207").replace(/\\sqrt/g, "\u221A")
    .replace(/\\sum/g, "\u2211").replace(/\\prod/g, "\u220F").replace(/\\int/g, "\u222B")
    .replace(/\\forall/g, "\u2200").replace(/\\exists/g, "\u2203")
    .replace(/\\in/g, "\u2208").replace(/\\notin/g, "\u2209")
    .replace(/\\subset/g, "\u2282").replace(/\\supset/g, "\u2283")
    .replace(/\\cup/g, "\u222A").replace(/\\cap/g, "\u2229")
    .replace(/\\emptyset/g, "\u2205")
    .replace(/\\rightarrow/g, "\u2192").replace(/\\leftarrow/g, "\u2190")
    .replace(/\\Rightarrow/g, "\u21D2").replace(/\\Leftarrow/g, "\u21D0")
    .replace(/\\leftrightarrow/g, "\u2194").replace(/\\Leftrightarrow/g, "\u21D4")
    .replace(/\\lfloor/g, "\u230A").replace(/\\rfloor/g, "\u230B")
    .replace(/\\lceil/g, "\u2308").replace(/\\rceil/g, "\u2309")
    .replace(/\\ldots/g, "\u2026").replace(/\\cdots/g, "\u22EF")
    // Superscripts / subscripts (simple single-char)
    .replace(/\^2/g, "\u00B2").replace(/\^3/g, "\u00B3").replace(/\^n/g, "\u207F")
    .replace(/\^0/g, "\u2070").replace(/\^1/g, "\u00B9")
    .replace(/_0/g, "\u2080").replace(/_1/g, "\u2081").replace(/_2/g, "\u2082")
    .replace(/_i/g, "\u1D62").replace(/_n/g, "\u2099")
    // Clean up remaining LaTeX braces
    .replace(/[{}]/g, "")
    .replace(/\\\\/g, "  ");
}

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
      pdf.text(headers[ci] ?? "", x + ci * cellW + cellPad, tableY + cellPad, {
        width: cellW - cellPad * 2,
        height: rowH,
        lineBreak: false,
      });
    }
    tableY += rowH;

    // Data rows
    pdf.font("Helvetica").fillColor("#222222");
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri]!;
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

      switch (pType) {
        case "text":
          ensureSpace(baseFontSize + 4);
          pdf.fontSize(baseFontSize).font("Helvetica").fillColor("#333333")
            .text(content, col.x, pdf.y, { width: col.width, lineGap: 1.5 });
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
          pdf.text(content, col.x + 10, pdf.y, { width: col.width - 10, lineGap: 1 });
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
            .text(content, col.x + 14, pdf.y, { width: col.width - 14, lineGap: 1 });
          pdf.y += 1;
          break;

        case "callout": {
          const style = CALLOUT_STYLES[(para.style as string) ?? "info"] ?? CALLOUT_STYLES.info!;
          const calloutFontSize = baseFontSize - 0.5;
          // Measure text height
          const textH = pdf.fontSize(calloutFontSize).font("Helvetica")
            .heightOfString(content, { width: col.width - 14 });
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
            .text(content, col.x + 8, boxY + 4, { width: col.width - 14, lineGap: 1 });
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
            .text(`"${content}"`, col.x + 10, quoteY + 2, { width: col.width - 14, lineGap: 1 });
          pdf.y += 4;
          break;
        }

        case "citation_note":
          ensureSpace(baseFontSize);
          pdf.fontSize(Math.max(baseFontSize - 2, 5.5)).font("Helvetica-Oblique").fillColor("#9CA3AF")
            .text(content, col.x, pdf.y, { width: col.width, lineGap: 0.5 });
          pdf.y += 2;
          break;

        case "math": {
          const display = (para.display as boolean) ?? false;
          const rendered = renderMathText(content);
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
          const term = (para.term as string) ?? "";
          const def = (para.definition as string) ?? "";
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
              .text(entry.key, kvX, pdf.y, { width: keyW, continued: false });
            pdf.y -= baseFontSize + 2;
            pdf.fontSize(baseFontSize).font("Helvetica").fillColor("#555555")
              .text(entry.value, kvX + keyW, pdf.y, { width: kvW - keyW, lineGap: 1 });
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
        .text(line, col.x, pdf.y, { width: col.width, lineGap: 0.5 });
    }
  }

  // Footer on each page
  const pages = pdf.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
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
      await renderDocx(docPayload, outputPath);
      break;
    case "document_xlsx":
      await renderXlsx(docPayload, outputPath);
      break;
    case "document_pptx":
      await renderPptx(docPayload, outputPath);
      break;
    case "document_pdf":
      await renderPdf(docPayload, outputPath);
      break;
    default:
      throw new Error(`Unknown document kind: ${kind}`);
  }

  return outputPath;
}
