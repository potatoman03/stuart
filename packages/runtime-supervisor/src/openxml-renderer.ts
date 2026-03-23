import { writeFile } from "node:fs/promises";
import JSZip from "jszip";
import type {
  CitationRef,
  DocxDocumentPayload,
  DocxParagraph,
  PptxPresentationPayload,
  PptxSlide,
  XlsxCell,
  XlsxCellStyle,
  XlsxSheet,
  XlsxWorkbookPayload,
} from "@stuart/shared";
import { renderLatexToOmml, renderTextWithLatexToPlainText } from "./math-rendering.js";
import { clampSize, getSvgDimensions, normalizeSvgForHtml, renderSvgToPng } from "./svg-rendering.js";

const XML_HEADER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DOCX_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const PIC_NS = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const XLSX_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const PPT_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const CORE_NS = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
const DCTERMS_NS = "http://purl.org/dc/terms/";
const DC_NS = "http://purl.org/dc/elements/1.1/";
const DCMITYPE_NS = "http://purl.org/dc/dcmitype/";
const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";
const VT_NS = "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes";
const EMU_PER_INCH = 914400;
const PPT_WIDTH = 12192000;
const PPT_HEIGHT = 6858000;
const PPT_TABLE_STYLE_ID = "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}";

function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function xml(tag: string): string {
  return `${XML_HEADER}${tag}`;
}

function isoNow(): string {
  return new Date().toISOString();
}

function formatCitations(citations: CitationRef[]): string[] {
  return citations.map((citation, index) => {
    const parts: string[] = [`[${index + 1}]`];
    if (citation.excerpt) {
      parts.push(`"${citation.excerpt}"`);
    }
    const source = citation.relativePath || citation.sourceId;
    if (source) {
      parts.push(`- ${source}`);
    }
    if (citation.locator) {
      parts.push(`(${citation.locator})`);
    }
    return parts.join(" ");
  });
}

type DocxImageAsset = {
  relId: string;
  name: string;
  target: string;
  buffer: Buffer;
  widthEmu: number;
  heightEmu: number;
  altText: string;
};

type PptxImageAsset = {
  relId: string;
  name: string;
  target: string;
  buffer: Buffer;
  widthEmu: number;
  heightEmu: number;
  caption?: string;
};

function pxToEmu(value: number): number {
  return Math.round((Math.max(1, value) / 96) * EMU_PER_INCH);
}

function buildRootRelationships(documentTarget: string): string {
  return xml(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${DOC_REL_NS}/officeDocument" Target="${documentTarget}"/>` +
      `<Relationship Id="rId2" Type="${PACKAGE_REL_NS}/metadata/core-properties" Target="docProps/core.xml"/>` +
      `<Relationship Id="rId3" Type="${DOC_REL_NS}/extended-properties" Target="docProps/app.xml"/>` +
    `</Relationships>`
  );
}

function buildCoreProperties(title: string, subject: string, creator: string, description: string): string {
  const created = isoNow();
  return xml(
    `<cp:coreProperties xmlns:cp="${CORE_NS}" xmlns:dc="${DC_NS}" xmlns:dcterms="${DCTERMS_NS}" xmlns:dcmitype="${DCMITYPE_NS}" xmlns:xsi="${XSI_NS}">` +
      `<dc:title>${escapeXml(title)}</dc:title>` +
      `<dc:subject>${escapeXml(subject)}</dc:subject>` +
      `<dc:creator>${escapeXml(creator)}</dc:creator>` +
      `<cp:lastModifiedBy>${escapeXml(creator)}</cp:lastModifiedBy>` +
      `<dc:description>${escapeXml(description)}</dc:description>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>` +
    `</cp:coreProperties>`
  );
}

function buildWordAppProperties(): string {
  return xml(
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="${VT_NS}">` +
      `<Application>Stuart</Application>` +
      `<DocSecurity>0</DocSecurity>` +
      `<ScaleCrop>false</ScaleCrop>` +
      `<HeadingPairs><vt:vector size="2" baseType="variant">` +
        `<vt:variant><vt:lpstr>Sections</vt:lpstr></vt:variant>` +
        `<vt:variant><vt:i4>1</vt:i4></vt:variant>` +
      `</vt:vector></HeadingPairs>` +
      `<TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>Document</vt:lpstr></vt:vector></TitlesOfParts>` +
      `<Company></Company>` +
      `<LinksUpToDate>false</LinksUpToDate>` +
      `<SharedDoc>false</SharedDoc>` +
      `<HyperlinksChanged>false</HyperlinksChanged>` +
      `<AppVersion>1.0</AppVersion>` +
    `</Properties>`
  );
}

function buildSpreadsheetAppProperties(sheetNames: string[]): string {
  const titles = sheetNames.map((sheet) => `<vt:lpstr>${escapeXml(sheet)}</vt:lpstr>`).join("");
  return xml(
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="${VT_NS}">` +
      `<Application>Stuart</Application>` +
      `<DocSecurity>0</DocSecurity>` +
      `<ScaleCrop>false</ScaleCrop>` +
      `<HeadingPairs><vt:vector size="2" baseType="variant">` +
        `<vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant>` +
        `<vt:variant><vt:i4>${sheetNames.length}</vt:i4></vt:variant>` +
      `</vt:vector></HeadingPairs>` +
      `<TitlesOfParts><vt:vector size="${sheetNames.length}" baseType="lpstr">${titles}</vt:vector></TitlesOfParts>` +
      `<Company></Company>` +
      `<LinksUpToDate>false</LinksUpToDate>` +
      `<SharedDoc>false</SharedDoc>` +
      `<HyperlinksChanged>false</HyperlinksChanged>` +
      `<AppVersion>1.0</AppVersion>` +
    `</Properties>`
  );
}

function buildPresentationAppProperties(slideTitles: string[]): string {
  const titles = slideTitles.map((title) => `<vt:lpstr>${escapeXml(title || "Slide")}</vt:lpstr>`).join("");
  return xml(
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="${VT_NS}">` +
      `<Application>Stuart</Application>` +
      `<PresentationFormat>On-screen Show (16:9)</PresentationFormat>` +
      `<Slides>${slideTitles.length}</Slides>` +
      `<Notes>0</Notes>` +
      `<HiddenSlides>0</HiddenSlides>` +
      `<MMClips>0</MMClips>` +
      `<ScaleCrop>false</ScaleCrop>` +
      `<HeadingPairs><vt:vector size="2" baseType="variant">` +
        `<vt:variant><vt:lpstr>Slides</vt:lpstr></vt:variant>` +
        `<vt:variant><vt:i4>${slideTitles.length}</vt:i4></vt:variant>` +
      `</vt:vector></HeadingPairs>` +
      `<TitlesOfParts><vt:vector size="${slideTitles.length}" baseType="lpstr">${titles}</vt:vector></TitlesOfParts>` +
      `<Company></Company>` +
      `<LinksUpToDate>false</LinksUpToDate>` +
      `<SharedDoc>false</SharedDoc>` +
      `<HyperlinksChanged>false</HyperlinksChanged>` +
      `<AppVersion>1.0</AppVersion>` +
    `</Properties>`
  );
}

function buildWordContentTypes(): string {
  return xml(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="png" ContentType="image/png"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
      `<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>` +
      `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
    `</Types>`
  );
}

function buildSpreadsheetContentTypes(sheetCount: number): string {
  const worksheetOverrides = Array.from({ length: sheetCount }, (_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join("");
  return xml(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      worksheetOverrides +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
    `</Types>`
  );
}

function buildPresentationContentTypes(slideCount: number): string {
  const slideOverrides = Array.from({ length: slideCount }, (_, index) =>
    `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
  ).join("");
  return xml(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="png" ContentType="image/png"/>` +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
      `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
      `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
      `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
      `<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>` +
      `<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>` +
      `<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>` +
      slideOverrides +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
    `</Types>`
  );
}

function docxTextRuns(text: string, runProperties = ""): string {
  const segments = normalizeText(text).split("\n");
  const output: string[] = [];
  for (const [index, segment] of segments.entries()) {
    output.push(
      `<w:r>${runProperties ? `<w:rPr>${runProperties}</w:rPr>` : ""}<w:t xml:space="preserve">${escapeXml(segment)}</w:t></w:r>`
    );
    if (index < segments.length - 1) {
      output.push("<w:r><w:br/></w:r>");
    }
  }
  return output.join("");
}

function docxParagraphXml(
  text: string,
  options: {
    styleId?: string;
    numId?: number;
    spacingAfter?: number;
    italics?: boolean;
    color?: string;
    bold?: boolean;
    indentLeft?: number;
    indentRight?: number;
    shadingFill?: string;
    borderColor?: string;
    borderPosition?: "left" | "bottom";
    fontFamily?: string;
    align?: "left" | "center";
    preserveLatex?: boolean;
  } = {}
): string {
  const pPr: string[] = [];
  if (options.styleId) {
    pPr.push(`<w:pStyle w:val="${escapeXml(options.styleId)}"/>`);
  }
  if (options.numId) {
    pPr.push(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${options.numId}"/></w:numPr>`);
  }
  if (options.spacingAfter) {
    pPr.push(`<w:spacing w:after="${options.spacingAfter}"/>`);
  }
  if (options.align === "center") {
    pPr.push(`<w:jc w:val="center"/>`);
  }
  if (options.indentLeft || options.indentRight) {
    pPr.push(
      `<w:ind${options.indentLeft ? ` w:left="${options.indentLeft}"` : ""}${options.indentRight ? ` w:right="${options.indentRight}"` : ""}/>`
    );
  }
  if (options.shadingFill) {
    pPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${options.shadingFill}"/>`);
  }
  if (options.borderColor) {
    const side = options.borderPosition === "bottom"
      ? `<w:bottom w:val="single" w:sz="8" w:space="6" w:color="${options.borderColor}"/>`
      : `<w:left w:val="single" w:sz="8" w:space="6" w:color="${options.borderColor}"/>`;
    pPr.push(`<w:pBdr>${side}</w:pBdr>`);
  }
  const rPr: string[] = [];
  if (options.fontFamily) {
    rPr.push(`<w:rFonts w:ascii="${escapeXml(options.fontFamily)}" w:hAnsi="${escapeXml(options.fontFamily)}"/>`);
  }
  if (options.bold) {
    rPr.push("<w:b/>");
  }
  if (options.italics) {
    rPr.push("<w:i/>");
  }
  if (options.color) {
    rPr.push(`<w:color w:val="${options.color}"/>`);
  }
  const renderedText = options.preserveLatex ? text : renderTextWithLatexToPlainText(text);
  return `<w:p>${pPr.length > 0 ? `<w:pPr>${pPr.join("")}</w:pPr>` : ""}${docxTextRuns(renderedText, rPr.join(""))}</w:p>`;
}

function docxTableXml(headers: string[], rows: string[][]): string {
  const grid = headers.map(() => `<w:gridCol w:w="${Math.floor(9000 / Math.max(headers.length, 1))}"/>`).join("");
  const headerCells = headers.map((header) =>
    `<w:tc>` +
      `<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="E0E0E0"/></w:tcPr>` +
      docxParagraphXml(header, { bold: true }) +
    `</w:tc>`
  ).join("");
  const bodyRows = rows.map((row) =>
    `<w:tr>` +
      headers.map((_, columnIndex) =>
        `<w:tc>${docxParagraphXml(String(row[columnIndex] ?? ""))}</w:tc>`
      ).join("") +
    `</w:tr>`
  ).join("");
  return (
    `<w:tbl>` +
      `<w:tblPr>` +
        `<w:tblW w:w="0" w:type="auto"/>` +
        `<w:tblBorders>` +
          `<w:top w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>` +
          `<w:left w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>` +
          `<w:bottom w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>` +
          `<w:right w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>` +
          `<w:insideH w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>` +
          `<w:insideV w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>` +
        `</w:tblBorders>` +
      `</w:tblPr>` +
      `<w:tblGrid>${grid}</w:tblGrid>` +
      `<w:tr>${headerCells}</w:tr>` +
      bodyRows +
    `</w:tbl>`
  );
}

function docxParagraphWithRunsXml(
  runs: Array<{
    text: string;
    bold?: boolean;
    italics?: boolean;
    color?: string;
    fontFamily?: string;
    preserveLatex?: boolean;
  }>,
  options: Parameters<typeof docxParagraphXml>[1] = {}
): string {
  const pPr: string[] = [];
  if (options.styleId) {
    pPr.push(`<w:pStyle w:val="${escapeXml(options.styleId)}"/>`);
  }
  if (options.numId) {
    pPr.push(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${options.numId}"/></w:numPr>`);
  }
  if (options.spacingAfter) {
    pPr.push(`<w:spacing w:after="${options.spacingAfter}"/>`);
  }
  if (options.align === "center") {
    pPr.push(`<w:jc w:val="center"/>`);
  }
  if (options.indentLeft || options.indentRight) {
    pPr.push(
      `<w:ind${options.indentLeft ? ` w:left="${options.indentLeft}"` : ""}${options.indentRight ? ` w:right="${options.indentRight}"` : ""}/>`
    );
  }
  if (options.shadingFill) {
    pPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${options.shadingFill}"/>`);
  }
  if (options.borderColor) {
    const side = options.borderPosition === "bottom"
      ? `<w:bottom w:val="single" w:sz="8" w:space="6" w:color="${options.borderColor}"/>`
      : `<w:left w:val="single" w:sz="8" w:space="6" w:color="${options.borderColor}"/>`;
    pPr.push(`<w:pBdr>${side}</w:pBdr>`);
  }

  const runXml = runs.map((run) => {
    const rPr: string[] = [];
    if (run.fontFamily) {
      rPr.push(`<w:rFonts w:ascii="${escapeXml(run.fontFamily)}" w:hAnsi="${escapeXml(run.fontFamily)}"/>`);
    }
    if (run.bold) {
      rPr.push("<w:b/>");
    }
    if (run.italics) {
      rPr.push("<w:i/>");
    }
    if (run.color) {
      rPr.push(`<w:color w:val="${run.color}"/>`);
    }
    return docxTextRuns(run.preserveLatex ? run.text : renderTextWithLatexToPlainText(run.text), rPr.join(""));
  }).join("");

  return `<w:p>${pPr.length > 0 ? `<w:pPr>${pPr.join("")}</w:pPr>` : ""}${runXml}</w:p>`;
}

async function docxMathParagraphXml(latex: string, display = false): Promise<string> {
  const omml = await renderLatexToOmml(latex, display);
  if (display) {
    return (
      `<w:p>` +
        `<w:pPr><w:jc w:val="center"/><w:spacing w:after="120"/></w:pPr>` +
        `<m:oMathPara><m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr>${omml}</m:oMathPara>` +
      `</w:p>`
    );
  }
  return `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>${omml}</w:p>`;
}

async function createDocxImageAsset(
  paragraph: Extract<DocxParagraph, { type: "svg" }>,
  imageIndex: number
): Promise<DocxImageAsset> {
  const normalizedSvg = normalizeSvgForHtml(paragraph.svg);
  const intrinsic = getSvgDimensions(normalizedSvg);
  const desiredWidth = typeof paragraph.width === "number" && paragraph.width > 0 ? paragraph.width : intrinsic.widthPx;
  const desiredHeight = typeof paragraph.height === "number" && paragraph.height > 0 ? paragraph.height : intrinsic.heightPx;
  const scaled = clampSize(desiredWidth, desiredHeight, 624, 420);
  const rendered = renderSvgToPng(normalizedSvg, { width: scaled.width });
  return {
    relId: `rId${imageIndex + 4}`,
    name: `figure-${imageIndex}.png`,
    target: `media/figure-${imageIndex}.png`,
    buffer: rendered.png,
    widthEmu: pxToEmu(rendered.widthPx),
    heightEmu: pxToEmu(rendered.heightPx),
    altText: paragraph.alt?.trim() || paragraph.caption?.trim() || `Figure ${imageIndex}`,
  };
}

function docxImageParagraphXml(asset: DocxImageAsset, docPrId: number): string {
  return (
    `<w:p>` +
      `<w:pPr><w:jc w:val="center"/><w:spacing w:after="120"/></w:pPr>` +
      `<w:r>` +
        `<w:drawing>` +
          `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
            `<wp:extent cx="${asset.widthEmu}" cy="${asset.heightEmu}"/>` +
            `<wp:docPr id="${docPrId}" name="${escapeXml(asset.name)}" descr="${escapeXml(asset.altText)}"/>` +
            `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
            `<a:graphic>` +
              `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
                `<pic:pic>` +
                  `<pic:nvPicPr>` +
                    `<pic:cNvPr id="${docPrId}" name="${escapeXml(asset.name)}" descr="${escapeXml(asset.altText)}"/>` +
                    `<pic:cNvPicPr/>` +
                  `</pic:nvPicPr>` +
                  `<pic:blipFill>` +
                    `<a:blip r:embed="${asset.relId}"/>` +
                    `<a:stretch><a:fillRect/></a:stretch>` +
                  `</pic:blipFill>` +
                  `<pic:spPr>` +
                    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${asset.widthEmu}" cy="${asset.heightEmu}"/></a:xfrm>` +
                    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
                  `</pic:spPr>` +
                `</pic:pic>` +
              `</a:graphicData>` +
            `</a:graphic>` +
          `</wp:inline>` +
        `</w:drawing>` +
      `</w:r>` +
    `</w:p>`
  );
}

async function docxBodyXml(payload: DocxDocumentPayload): Promise<{ documentXml: string; imageAssets: DocxImageAsset[] }> {
  const bodyParts: string[] = [];
  const imageAssets: DocxImageAsset[] = [];
  let nextImageId = 1;
  for (const section of payload.sections ?? []) {
    bodyParts.push(
      docxParagraphXml(section.heading, {
        styleId: `Heading${section.level}`,
        spacingAfter: 160,
      })
    );
    for (const paragraph of section.paragraphs ?? []) {
      switch (paragraph.type) {
        case "text":
          bodyParts.push(docxParagraphXml(paragraph.content, { spacingAfter: 120 }));
          break;
        case "bullet":
          bodyParts.push(docxParagraphXml(paragraph.content, { numId: 1 }));
          break;
        case "numbered":
          bodyParts.push(docxParagraphXml(paragraph.content, { numId: 2 }));
          break;
        case "callout":
          {
            const style = paragraph.style ?? "info";
            const tone = style === "warning"
              ? { fill: "FFF7E6", border: "F59E0B", color: "92400E" }
              : style === "tip"
                ? { fill: "ECFDF5", border: "10B981", color: "065F46" }
                : style === "important"
                  ? { fill: "FEF2F2", border: "EF4444", color: "991B1B" }
                  : { fill: "E8F0FE", border: "2962FF", color: "1E40AF" };
          bodyParts.push(
            docxParagraphXml(paragraph.content, {
              italics: true,
              color: tone.color,
              shadingFill: tone.fill,
              borderColor: tone.border,
              indentLeft: 360,
              indentRight: 240,
              spacingAfter: 140,
            })
          );
          break;
          }
        case "citation_note":
          bodyParts.push(
            docxParagraphXml(paragraph.content, {
              italics: true,
              color: "666666",
              spacingAfter: 60,
            })
          );
          break;
        case "table":
          bodyParts.push(docxTableXml(paragraph.headers, paragraph.rows));
          break;
        case "quote":
          bodyParts.push(
            docxParagraphXml(paragraph.content, {
              italics: true,
              color: "4B5563",
              borderColor: "9CA3AF",
              indentLeft: 420,
              spacingAfter: 120,
            })
          );
          break;
        case "math":
          bodyParts.push(await docxMathParagraphXml(paragraph.content, paragraph.display));
          break;
        case "svg":
          {
            const asset = await createDocxImageAsset(paragraph, nextImageId);
            imageAssets.push(asset);
            bodyParts.push(docxImageParagraphXml(asset, 1000 + nextImageId));
            if (paragraph.caption?.trim()) {
              bodyParts.push(
                docxParagraphXml(paragraph.caption, {
                  italics: true,
                  color: "6B7280",
                  align: "center",
                  spacingAfter: 120,
                })
              );
            }
            nextImageId += 1;
            break;
          }
        case "code":
          bodyParts.push(
            docxParagraphXml(paragraph.content, {
              fontFamily: "Courier New",
              preserveLatex: true,
              color: "1F2937",
              shadingFill: "F3F4F6",
              borderColor: "CBD5E1",
              borderPosition: "left",
              indentLeft: 240,
              indentRight: 240,
              spacingAfter: 120,
            })
          );
          break;
        case "divider":
          bodyParts.push(
            docxParagraphXml(" ", {
              borderColor: "D1D5DB",
              borderPosition: "bottom",
              spacingAfter: 100,
            })
          );
          break;
        case "definition":
          bodyParts.push(
            docxParagraphWithRunsXml(
              [
                { text: `${paragraph.term}: `, bold: true, color: "111827" },
                { text: paragraph.definition, color: "374151" },
              ],
              {
                spacingAfter: 120,
                indentLeft: 180,
                borderColor: "D1D5DB",
                borderPosition: "left",
              }
            )
          );
          break;
        case "kv":
          bodyParts.push(
            docxTableXml(
              ["Key", "Value"],
              paragraph.entries.map((entry) => [entry.key, entry.value])
            )
          );
          break;
      }
    }
  }
  if ((payload.citations ?? []).length > 0) {
    bodyParts.push(docxParagraphXml("References", { styleId: "Heading1", spacingAfter: 160 }));
    for (const citationLine of formatCitations(payload.citations)) {
      bodyParts.push(docxParagraphXml(citationLine, { color: "555555", spacingAfter: 60 }));
    }
  }
  bodyParts.push(
    `<w:sectPr>` +
      `<w:pgSz w:w="11906" w:h="16838" w:orient="portrait"/>` +
      `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>` +
      `<w:pgNumType/>` +
      `<w:docGrid w:linePitch="360"/>` +
    `</w:sectPr>`
  );
  return {
    documentXml: xml(
    `<w:document xmlns:w="${DOCX_NS}" xmlns:r="${DOC_REL_NS}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">` +
      `<w:body>${bodyParts.join("")}</w:body>` +
    `</w:document>`
    ).replace(
      `<w:document xmlns:w="${DOCX_NS}" xmlns:r="${DOC_REL_NS}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">`,
      `<w:document xmlns:w="${DOCX_NS}" xmlns:r="${DOC_REL_NS}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:wp="${WP_NS}" xmlns:a="${DRAWING_NS}" xmlns:pic="${PIC_NS}">`
    ),
    imageAssets,
  };
}

function buildDocxStylesXml(): string {
  return xml(
    `<w:styles xmlns:w="${DOCX_NS}">` +
      `<w:docDefaults>` +
        `<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>` +
        `<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>` +
      `</w:docDefaults>` +
      `<w:style w:type="paragraph" w:default="1" w:styleId="Normal">` +
        `<w:name w:val="Normal"/><w:qFormat/>` +
      `</w:style>` +
      `<w:style w:type="paragraph" w:styleId="Heading1">` +
        `<w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
        `<w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>` +
        `<w:rPr><w:b/><w:sz w:val="34"/><w:color w:val="1F2937"/></w:rPr>` +
      `</w:style>` +
      `<w:style w:type="paragraph" w:styleId="Heading2">` +
        `<w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
        `<w:pPr><w:spacing w:before="200" w:after="100"/></w:pPr>` +
        `<w:rPr><w:b/><w:sz w:val="30"/><w:color w:val="1F2937"/></w:rPr>` +
      `</w:style>` +
      `<w:style w:type="paragraph" w:styleId="Heading3">` +
        `<w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
        `<w:pPr><w:spacing w:before="160" w:after="80"/></w:pPr>` +
        `<w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="374151"/></w:rPr>` +
      `</w:style>` +
    `</w:styles>`
  );
}

function buildDocxSettingsXml(): string {
  return xml(
    `<w:settings xmlns:w="${DOCX_NS}">` +
      `<w:zoom w:percent="100"/>` +
      `<w:defaultTabStop w:val="720"/>` +
      `<w:compat/>` +
    `</w:settings>`
  );
}

function buildDocxNumberingXml(): string {
  return xml(
    `<w:numbering xmlns:w="${DOCX_NS}">` +
      `<w:abstractNum w:abstractNumId="1">` +
        `<w:multiLevelType w:val="singleLevel"/>` +
        `<w:lvl w:ilvl="0">` +
          `<w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/>` +
          `<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>` +
        `</w:lvl>` +
      `</w:abstractNum>` +
      `<w:abstractNum w:abstractNumId="2">` +
        `<w:multiLevelType w:val="singleLevel"/>` +
        `<w:lvl w:ilvl="0">` +
          `<w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>` +
          `<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>` +
        `</w:lvl>` +
      `</w:abstractNum>` +
      `<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>` +
      `<w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>` +
    `</w:numbering>`
  );
}

function buildDocxDocumentRelationships(imageAssets: DocxImageAsset[]): string {
  const imageRelationships = imageAssets
    .map((asset) => `<Relationship Id="${asset.relId}" Type="${DOC_REL_NS}/image" Target="${asset.target}"/>`)
    .join("");
  return xml(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${DOC_REL_NS}/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId2" Type="${DOC_REL_NS}/settings" Target="settings.xml"/>` +
      `<Relationship Id="rId3" Type="${DOC_REL_NS}/numbering" Target="numbering.xml"/>` +
      imageRelationships +
    `</Relationships>`
  );
}

function columnName(index: number): string {
  let value = "";
  let remaining = index + 1;
  while (remaining > 0) {
    const modulo = (remaining - 1) % 26;
    value = String.fromCharCode(65 + modulo) + value;
    remaining = Math.floor((remaining - modulo) / 26);
  }
  return value;
}

type SpreadsheetStyleDefinition = {
  fontId: number;
  fillId: number;
  borderId: number;
  applyFont?: boolean;
  applyFill?: boolean;
  applyBorder?: boolean;
  applyAlignment?: boolean;
  horizontal?: "left" | "center";
  wrapText?: boolean;
  numFmtId?: number;
  applyNumberFormat?: boolean;
};

type SpreadsheetStyleRegistry = {
  styleIndexFor(baseStyle?: XlsxCellStyle, numberFormat?: string): number;
  toXml(): string;
};

function isXlsxCell(value: XlsxSheet["rows"][number][number]): value is XlsxCell {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeXlsxCell(value: XlsxSheet["rows"][number][number]): XlsxCell {
  if (isXlsxCell(value)) {
    return value;
  }
  return { value: value ?? null };
}

function buildSpreadsheetStyleRegistry(sheets: XlsxSheet[]): SpreadsheetStyleRegistry {
  const baseDefinitions: Record<"default" | XlsxCellStyle, SpreadsheetStyleDefinition> = {
    default: {
      fontId: 0,
      fillId: 0,
      borderId: 0,
      applyAlignment: true,
      horizontal: "left",
      wrapText: true,
    },
    header: {
      fontId: 1,
      fillId: 2,
      borderId: 1,
      applyFont: true,
      applyFill: true,
      applyBorder: true,
      applyAlignment: true,
      horizontal: "center",
      wrapText: true,
    },
    subheader: {
      fontId: 1,
      fillId: 3,
      borderId: 1,
      applyFont: true,
      applyFill: true,
      applyBorder: true,
      applyAlignment: true,
      horizontal: "left",
      wrapText: true,
    },
    emphasis: {
      fontId: 2,
      fillId: 0,
      borderId: 0,
      applyFont: true,
      applyAlignment: true,
      horizontal: "left",
      wrapText: true,
    },
    good: {
      fontId: 0,
      fillId: 4,
      borderId: 1,
      applyFill: true,
      applyBorder: true,
      applyAlignment: true,
      horizontal: "left",
      wrapText: true,
    },
    warning: {
      fontId: 0,
      fillId: 5,
      borderId: 1,
      applyFill: true,
      applyBorder: true,
      applyAlignment: true,
      horizontal: "left",
      wrapText: true,
    },
    muted: {
      fontId: 3,
      fillId: 0,
      borderId: 0,
      applyFont: true,
      applyAlignment: true,
      horizontal: "left",
      wrapText: true,
    },
  };

  const styleOrder: Array<"default" | XlsxCellStyle> = [
    "default",
    "header",
    "subheader",
    "emphasis",
    "good",
    "warning",
    "muted",
  ];
  const styleIndexes = new Map<string, number>();
  const customNumFmtIds = new Map<string, number>();
  const cellXfs: SpreadsheetStyleDefinition[] = styleOrder.map((styleName, index) => {
    styleIndexes.set(`${styleName}|`, index);
    return { ...baseDefinitions[styleName] };
  });

  let nextNumFmtId = 164;
  for (const sheet of sheets) {
    for (const row of sheet.rows ?? []) {
      for (const entry of row) {
        if (!isXlsxCell(entry) || !entry.numberFormat) {
          continue;
        }
        const baseStyle = entry.style ?? "default";
        const key = `${baseStyle}|${entry.numberFormat}`;
        if (styleIndexes.has(key)) {
          continue;
        }
        let numFmtId = customNumFmtIds.get(entry.numberFormat);
        if (!numFmtId) {
          numFmtId = nextNumFmtId++;
          customNumFmtIds.set(entry.numberFormat, numFmtId);
        }
        cellXfs.push({
          ...baseDefinitions[baseStyle],
          numFmtId,
          applyNumberFormat: true,
        });
        styleIndexes.set(key, cellXfs.length - 1);
      }
    }
  }

  return {
    styleIndexFor(baseStyle, numberFormat) {
      const styleName = baseStyle ?? "default";
      if (!numberFormat) {
        return styleIndexes.get(`${styleName}|`) ?? 0;
      }
      return styleIndexes.get(`${styleName}|${numberFormat}`) ?? styleIndexes.get(`${styleName}|`) ?? 0;
    },
    toXml() {
      const numFmtXml = Array.from(customNumFmtIds.entries())
        .map(([formatCode, numFmtId]) => `<numFmt numFmtId="${numFmtId}" formatCode="${escapeXml(formatCode)}"/>`)
        .join("");
      const cellXfsXml = cellXfs.map((definition) => {
        const alignment = definition.applyAlignment
          ? `<alignment horizontal="${definition.horizontal ?? "left"}" vertical="top"${definition.wrapText ? ` wrapText="1"` : ""}/>`
          : "";
        return (
          `<xf numFmtId="${definition.numFmtId ?? 0}" fontId="${definition.fontId}" fillId="${definition.fillId}" borderId="${definition.borderId}" xfId="0"` +
            `${definition.applyFont ? ` applyFont="1"` : ""}` +
            `${definition.applyFill ? ` applyFill="1"` : ""}` +
            `${definition.applyBorder ? ` applyBorder="1"` : ""}` +
            `${definition.applyAlignment ? ` applyAlignment="1"` : ""}` +
            `${definition.applyNumberFormat ? ` applyNumberFormat="1"` : ""}` +
          `>` +
            alignment +
          `</xf>`
        );
      }).join("");

      return xml(
        `<styleSheet xmlns="${XLSX_NS}">` +
          (numFmtXml ? `<numFmts count="${customNumFmtIds.size}">${numFmtXml}</numFmts>` : "") +
          `<fonts count="4">` +
            `<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>` +
            `<font><b/><sz val="11"/><color rgb="FF111827"/><name val="Calibri"/><family val="2"/></font>` +
            `<font><i/><sz val="11"/><color rgb="FF1F2937"/><name val="Calibri"/><family val="2"/></font>` +
            `<font><sz val="11"/><color rgb="FF6B7280"/><name val="Calibri"/><family val="2"/></font>` +
          `</fonts>` +
          `<fills count="6">` +
            `<fill><patternFill patternType="none"/></fill>` +
            `<fill><patternFill patternType="gray125"/></fill>` +
            `<fill><patternFill patternType="solid"><fgColor rgb="FFE5E7EB"/><bgColor indexed="64"/></patternFill></fill>` +
            `<fill><patternFill patternType="solid"><fgColor rgb="FFDBEAFE"/><bgColor indexed="64"/></patternFill></fill>` +
            `<fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/><bgColor indexed="64"/></patternFill></fill>` +
            `<fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/><bgColor indexed="64"/></patternFill></fill>` +
          `</fills>` +
          `<borders count="2">` +
            `<border><left/><right/><top/><bottom/><diagonal/></border>` +
            `<border><left style="thin"><color rgb="FFD1D5DB"/></left><right style="thin"><color rgb="FFD1D5DB"/></right><top style="thin"><color rgb="FFD1D5DB"/></top><bottom style="thin"><color rgb="FFD1D5DB"/></bottom><diagonal/></border>` +
          `</borders>` +
          `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
          `<cellXfs count="${cellXfs.length}">${cellXfsXml}</cellXfs>` +
          `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
        `</styleSheet>`
      );
    },
  };
}

function sheetCellXml(
  cellRef: string,
  rawValue: XlsxSheet["rows"][number][number],
  styles: SpreadsheetStyleRegistry,
  options: { header?: boolean } = {}
): string {
  const cell = normalizeXlsxCell(rawValue);
  const styleIndex = styles.styleIndexFor(options.header ? "header" : cell.style, cell.numberFormat);
  const styleAttr = styleIndex ? ` s="${styleIndex}"` : "";
  const formula = typeof cell.formula === "string" && cell.formula.trim()
    ? cell.formula.trim().replace(/^=/, "")
    : "";
  const value = cell.value ?? null;

  if (formula) {
    if (typeof value === "boolean") {
      return `<c r="${cellRef}"${styleAttr} t="b"><f>${escapeXml(formula)}</f><v>${value ? 1 : 0}</v></c>`;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return `<c r="${cellRef}"${styleAttr}><f>${escapeXml(formula)}</f><v>${value}</v></c>`;
    }
    if (typeof value === "string") {
      return `<c r="${cellRef}"${styleAttr} t="str"><f>${escapeXml(formula)}</f><v>${escapeXml(value)}</v></c>`;
    }
    return `<c r="${cellRef}"${styleAttr}><f>${escapeXml(formula)}</f></c>`;
  }

  if (value === null || value === undefined || value === "") {
    return `<c r="${cellRef}"${styleAttr} t="inlineStr"><is><t></t></is></c>`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${cellRef}"${styleAttr}><v>${value}</v></c>`;
  }
  if (typeof value === "boolean") {
    return `<c r="${cellRef}"${styleAttr} t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  return `<c r="${cellRef}"${styleAttr} t="inlineStr"><is><t>${escapeXml(renderTextWithLatexToPlainText(String(value)))}</t></is></c>`;
}

function buildWorksheetXml(sheet: XlsxSheet, styles: SpreadsheetStyleRegistry): string {
  const mergeEndRow = Math.max(0, ...(sheet.merges ?? []).map((merge) => merge.endRow));
  const mergeEndColumn = Math.max(0, ...(sheet.merges ?? []).map((merge) => merge.endColumn));
  const dataWidth = Math.max(0, ...((sheet.rows ?? []).map((row) => row.length)));
  const rowCount = Math.max((sheet.rows?.length ?? 0) + 1, mergeEndRow, 1);
  const colCount = Math.max(sheet.columns?.length ?? 0, dataWidth, mergeEndColumn, 1);
  const lastCell = `${columnName(colCount - 1)}${rowCount}`;
  const cols = (sheet.columns ?? [])
    .map((column, index) =>
      column.width ? `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>` : ""
    )
    .join("");
  const paneXml = (sheet.frozenRows ?? 0) > 0 || (sheet.frozenColumns ?? 0) > 0
    ? `<pane${(sheet.frozenColumns ?? 0) > 0 ? ` xSplit="${sheet.frozenColumns}"` : ""}${(sheet.frozenRows ?? 0) > 0 ? ` ySplit="${sheet.frozenRows}"` : ""} topLeftCell="${columnName(sheet.frozenColumns ?? 0)}${(sheet.frozenRows ?? 0) + 1}" activePane="${(sheet.frozenRows ?? 0) > 0 && (sheet.frozenColumns ?? 0) > 0 ? "bottomRight" : (sheet.frozenRows ?? 0) > 0 ? "bottomLeft" : "topRight"}" state="frozen"/>`
    : "";
  const selectionXml = paneXml
    ? `<selection pane="${(sheet.frozenRows ?? 0) > 0 && (sheet.frozenColumns ?? 0) > 0 ? "bottomRight" : (sheet.frozenRows ?? 0) > 0 ? "bottomLeft" : "topRight"}" activeCell="${columnName(sheet.frozenColumns ?? 0)}${(sheet.frozenRows ?? 0) + 1}" sqref="${columnName(sheet.frozenColumns ?? 0)}${(sheet.frozenRows ?? 0) + 1}"/>`
    : "";
  const headerRow =
    `<row r="1">` +
      Array.from({ length: colCount }, (_, index) => {
        const header = sheet.columns?.[index]?.header ?? `Column ${index + 1}`;
        return sheetCellXml(`${columnName(index)}1`, { value: header, style: "header" }, styles, { header: true });
      }).join("") +
    `</row>`;
  const dataRows = (sheet.rows ?? []).map((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    return (
      `<row r="${rowNumber}">` +
        Array.from({ length: colCount }, (_, columnIndex) =>
          sheetCellXml(`${columnName(columnIndex)}${rowNumber}`, row[columnIndex] ?? null, styles)
        ).join("") +
      `</row>`
    );
  }).join("");
  const mergeCells = (sheet.merges ?? []).map((merge) =>
    `<mergeCell ref="${columnName(merge.startColumn - 1)}${merge.startRow}:${columnName(merge.endColumn - 1)}${merge.endRow}"/>`
  ).join("");
  return xml(
    `<worksheet xmlns="${XLSX_NS}" xmlns:r="${DOC_REL_NS}">` +
      `<dimension ref="A1:${lastCell}"/>` +
      `<sheetViews><sheetView workbookViewId="0">${paneXml}${selectionXml}</sheetView></sheetViews>` +
      `<sheetFormatPr defaultRowHeight="15"/>` +
      (cols ? `<cols>${cols}</cols>` : "") +
      `<sheetData>${headerRow}${dataRows}</sheetData>` +
      (sheet.autoFilter ? `<autoFilter ref="A1:${lastCell}"/>` : "") +
      (mergeCells ? `<mergeCells count="${sheet.merges?.length ?? 0}">${mergeCells}</mergeCells>` : "") +
    `</worksheet>`
  );
}

function buildWorkbookXml(sheets: XlsxSheet[]): string {
  const sheetXml = sheets.map((sheet, index) =>
    `<sheet name="${escapeXml(sheet.name || `Sheet${index + 1}`)}" sheetId="${index + 1}" r:id="rId${index + 2}"/>`
  ).join("");
  return xml(
    `<workbook xmlns="${XLSX_NS}" xmlns:r="${DOC_REL_NS}">` +
      `<workbookPr codeName="ThisWorkbook"/>` +
      `<bookViews><workbookView xWindow="240" yWindow="15" windowWidth="16095" windowHeight="9660"/></bookViews>` +
      `<sheets>${sheetXml}</sheets>` +
      `<calcPr calcId="191029"/>` +
    `</workbook>`
  );
}

function buildWorkbookRelationships(sheetCount: number): string {
  const relationships = [
    `<Relationship Id="rId1" Type="${DOC_REL_NS}/styles" Target="styles.xml"/>`,
    ...Array.from({ length: sheetCount }, (_, index) =>
      `<Relationship Id="rId${index + 2}" Type="${DOC_REL_NS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
    ),
  ];
  return xml(`<Relationships xmlns="${PACKAGE_REL_NS}">${relationships.join("")}</Relationships>`);
}

function normalizeHexColor(color: string | undefined, fallback: string): string {
  const value = String(color ?? fallback).replace(/[^a-fA-F0-9]/g, "");
  if (value.length === 3) {
    return value.split("").map((character) => character + character).join("").toUpperCase();
  }
  if (value.length === 6) {
    return value.toUpperCase();
  }
  return fallback.toUpperCase();
}

function emu(valueInInches: number): number {
  return Math.round(valueInInches * EMU_PER_INCH);
}

function buildTextBody(
  paragraphs: Array<{
    text: string;
    bullet?: boolean;
    fontSize?: number;
    color?: string;
    bold?: boolean;
    align?: "l" | "ctr";
    fontFamily?: string;
  }>
): string {
  const paragraphXml = paragraphs.map((paragraph) => {
    const renderedText = renderTextWithLatexToPlainText(paragraph.text);
    const runProperties = [
      paragraph.fontSize ? ` sz="${Math.round(paragraph.fontSize * 100)}"` : "",
      ` lang="en-US" dirty="0"`,
      paragraph.bold ? ` b="1"` : "",
    ].join("");
    const fontXml = paragraph.fontFamily
      ? `<a:latin typeface="${escapeXml(paragraph.fontFamily)}"/><a:ea typeface="${escapeXml(paragraph.fontFamily)}"/><a:cs typeface="${escapeXml(paragraph.fontFamily)}"/>`
      : "";
    return (
      `<a:p>` +
        `<a:pPr${paragraph.align ? ` algn="${paragraph.align}"` : ""}${paragraph.bullet ? ` marL="342900" indent="-342900"` : ` indent="0" marL="0"`}>` +
          (paragraph.bullet ? `<a:buSzPct val="100000"/><a:buChar char="&#x2022;"/>` : `<a:buNone/>`) +
        `</a:pPr>` +
        `<a:r>` +
          `<a:rPr${runProperties}>` +
            `<a:solidFill><a:srgbClr val="${normalizeHexColor(paragraph.color, "111827")}"/></a:solidFill>` +
            fontXml +
          `</a:rPr>` +
          `<a:t>${escapeXml(renderedText)}</a:t>` +
        `</a:r>` +
        `<a:endParaRPr lang="en-US" dirty="0">${fontXml}</a:endParaRPr>` +
      `</a:p>`
    );
  }).join("");
  return `<p:txBody><a:bodyPr wrap="square" rtlCol="0" anchor="ctr"/><a:lstStyle/>${paragraphXml}</p:txBody>`;
}

function buildShapeXml(
  id: number,
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  paragraphs: Array<{
    text: string;
    bullet?: boolean;
    fontSize?: number;
    color?: string;
    bold?: boolean;
    align?: "l" | "ctr";
    fontFamily?: string;
  }>
): string {
  return (
    `<p:sp>` +
      `<p:nvSpPr>` +
        `<p:cNvPr id="${id}" name="${escapeXml(name)}"/>` +
        `<p:cNvSpPr/>` +
        `<p:nvPr/>` +
      `</p:nvSpPr>` +
      `<p:spPr>` +
        `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
        `<a:noFill/>` +
        `<a:ln/>` +
      `</p:spPr>` +
      buildTextBody(paragraphs) +
    `</p:sp>`
  );
}

function buildTableCellParagraph(text: string, fontFamily?: string): string {
  const renderedText = renderTextWithLatexToPlainText(text);
  const fontXml = fontFamily
    ? `<a:latin typeface="${escapeXml(fontFamily)}"/><a:ea typeface="${escapeXml(fontFamily)}"/><a:cs typeface="${escapeXml(fontFamily)}"/>`
    : "";
  return (
    `<a:p>` +
      `<a:r>` +
        `<a:rPr lang="en-US" sz="1200" dirty="0">${fontXml}</a:rPr>` +
        `<a:t>${escapeXml(renderedText)}</a:t>` +
      `</a:r>` +
      `<a:endParaRPr lang="en-US" dirty="0">${fontXml}</a:endParaRPr>` +
    `</a:p>`
  );
}

function buildTableGraphicXml(
  id: number,
  x: number,
  y: number,
  width: number,
  height: number,
  headers: string[],
  rows: string[][],
  fontFamily?: string
): string {
  const columnWidth = Math.floor(width / Math.max(headers.length, 1));
  const gridColumns = headers.map(() => `<a:gridCol w="${columnWidth}"/>`).join("");
  const tableRows = [
    headers,
    ...rows,
  ].map((row, rowIndex) => {
    const rowHeight = rowIndex === 0 ? 420000 : 360000;
    return (
      `<a:tr h="${rowHeight}">` +
        headers.map((_, cellIndex) =>
          `<a:tc>` +
            `<a:txBody><a:bodyPr/><a:lstStyle/>${buildTableCellParagraph(String(row[cellIndex] ?? ""), fontFamily)}</a:txBody>` +
            `<a:tcPr${rowIndex === 0 ? `><a:solidFill><a:srgbClr val="E5E7EB"/></a:solidFill></a:tcPr>` : `/>`}` +
          `</a:tc>`
        ).join("") +
      `</a:tr>`
    );
  }).join("");
  return (
    `<p:graphicFrame>` +
      `<p:nvGraphicFramePr>` +
        `<p:cNvPr id="${id}" name="Table ${id}"/>` +
        `<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr>` +
        `<p:nvPr/>` +
      `</p:nvGraphicFramePr>` +
      `<p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></p:xfrm>` +
      `<a:graphic>` +
        `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
          `<a:tbl>` +
            `<a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>${PPT_TABLE_STYLE_ID}</a:tableStyleId></a:tblPr>` +
            `<a:tblGrid>${gridColumns}</a:tblGrid>` +
            tableRows +
          `</a:tbl>` +
        `</a:graphicData>` +
      `</a:graphic>` +
    `</p:graphicFrame>`
  );
}

function buildPictureXml(
  id: number,
  name: string,
  relId: string,
  x: number,
  y: number,
  width: number,
  height: number
): string {
  return (
    `<p:pic>` +
      `<p:nvPicPr>` +
        `<p:cNvPr id="${id}" name="${escapeXml(name)}"/>` +
        `<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>` +
        `<p:nvPr/>` +
      `</p:nvPicPr>` +
      `<p:blipFill>` +
        `<a:blip r:embed="${relId}"/>` +
        `<a:stretch><a:fillRect/></a:stretch>` +
      `</p:blipFill>` +
      `<p:spPr>` +
        `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      `</p:spPr>` +
    `</p:pic>`
  );
}

function slideTitle(slide: PptxSlide): string {
  if ("title" in slide) {
    return slide.title;
  }
  return "Slide";
}

function buildSlideXml(
  slide: PptxSlide,
  index: number,
  theme: { primaryColor: string; fontFamily: string },
  options: { imageAsset?: PptxImageAsset } = {}
): string {
  const shapes: string[] = [];
  let nextId = 2;
  switch (slide.layout) {
    case "title":
      shapes.push(
        buildShapeXml(nextId++, `Text ${index}-title`, emu(0.75), emu(1.5), emu(11.75), emu(1.1), [
          {
            text: slide.title,
            fontSize: 30,
            color: theme.primaryColor,
            bold: true,
            align: "ctr",
            fontFamily: theme.fontFamily,
          },
        ])
      );
      if (slide.subtitle) {
        shapes.push(
          buildShapeXml(nextId++, `Text ${index}-subtitle`, emu(1), emu(3.1), emu(11.2), emu(0.8), [
            {
              text: slide.subtitle,
              fontSize: 16,
              color: "666666",
              align: "ctr",
              fontFamily: theme.fontFamily,
            },
          ])
        );
      }
      break;
    case "content":
      shapes.push(
        buildShapeXml(nextId++, `Text ${index}-title`, emu(0.5), emu(0.35), emu(12), emu(0.7), [
          {
            text: slide.title,
            fontSize: 22,
            color: theme.primaryColor,
            bold: true,
            fontFamily: theme.fontFamily,
          },
        ])
      );
      shapes.push(
        buildShapeXml(
          nextId++,
          `Text ${index}-body`,
          emu(0.7),
          emu(1.3),
          emu(11.7),
          emu(5.0),
          slide.bullets.map((bullet) => ({
            text: bullet,
            bullet: true,
            fontSize: 15,
            color: "333333",
            fontFamily: theme.fontFamily,
          }))
        )
      );
      break;
    case "two_column":
      shapes.push(
        buildShapeXml(nextId++, `Text ${index}-title`, emu(0.5), emu(0.35), emu(12), emu(0.7), [
          {
            text: slide.title,
            fontSize: 22,
            color: theme.primaryColor,
            bold: true,
            fontFamily: theme.fontFamily,
          },
        ])
      );
      shapes.push(
        buildShapeXml(
          nextId++,
          `Text ${index}-left`,
          emu(0.5),
          emu(1.3),
          emu(5.8),
          emu(5),
          slide.left.map((item) => ({
            text: item,
            bullet: true,
            fontSize: 14,
            color: "333333",
            fontFamily: theme.fontFamily,
          }))
        )
      );
      shapes.push(
        buildShapeXml(
          nextId++,
          `Text ${index}-right`,
          emu(6.1),
          emu(1.3),
          emu(5.8),
          emu(5),
          slide.right.map((item) => ({
            text: item,
            bullet: true,
            fontSize: 14,
            color: "333333",
            fontFamily: theme.fontFamily,
          }))
        )
      );
      break;
    case "table":
      shapes.push(
        buildShapeXml(nextId++, `Text ${index}-title`, emu(0.5), emu(0.35), emu(12), emu(0.7), [
          {
            text: slide.title,
            fontSize: 22,
            color: theme.primaryColor,
            bold: true,
            fontFamily: theme.fontFamily,
          },
        ])
      );
      shapes.push(
        buildTableGraphicXml(nextId++, emu(0.5), emu(1.3), emu(12.0), emu(4.8), slide.headers, slide.rows, theme.fontFamily)
      );
      break;
    case "diagram":
      shapes.push(
        buildShapeXml(nextId++, `Text ${index}-title`, emu(0.5), emu(0.35), emu(12), emu(0.7), [
          {
            text: slide.title,
            fontSize: 22,
            color: theme.primaryColor,
            bold: true,
            fontFamily: theme.fontFamily,
          },
        ])
      );
      if (options.imageAsset) {
        const maxWidth = emu(11.2);
        const maxHeight = emu(4.4);
        const scaled = clampSize(options.imageAsset.widthEmu, options.imageAsset.heightEmu, maxWidth, maxHeight);
        const imageX = Math.round((PPT_WIDTH - scaled.width) / 2);
        const imageY = emu(1.25);
        shapes.push(
          buildPictureXml(
            nextId++,
            options.imageAsset.name,
            options.imageAsset.relId,
            imageX,
            imageY,
            Math.round(scaled.width),
            Math.round(scaled.height)
          )
        );
        if (slide.caption?.trim()) {
          shapes.push(
            buildShapeXml(nextId++, `Text ${index}-caption`, emu(0.8), imageY + Math.round(scaled.height) + emu(0.1), emu(11.0), emu(0.5), [
              {
                text: slide.caption,
                fontSize: 12,
                color: "666666",
                align: "ctr",
                fontFamily: theme.fontFamily,
              },
            ])
          );
        }
      }
      break;
    case "section":
      shapes.push(
        buildShapeXml(nextId++, `Text ${index}-section`, emu(1), emu(2.1), emu(11), emu(1.4), [
          {
            text: slide.title,
            fontSize: 28,
            color: theme.primaryColor,
            bold: true,
            align: "ctr",
            fontFamily: theme.fontFamily,
          },
        ])
      );
      break;
    case "sources":
      shapes.push(
        buildShapeXml(nextId++, `Text ${index}-title`, emu(0.5), emu(0.35), emu(12), emu(0.7), [
          {
            text: "References",
            fontSize: 22,
            color: theme.primaryColor,
            bold: true,
            fontFamily: theme.fontFamily,
          },
        ])
      );
      shapes.push(
        buildShapeXml(
          nextId++,
          `Text ${index}-sources`,
          emu(0.7),
          emu(1.3),
          emu(11.7),
          emu(5.2),
          slide.entries.map((entry) => ({
            text: entry,
            bullet: true,
            fontSize: 11,
            color: "555555",
            fontFamily: theme.fontFamily,
          }))
        )
      );
      break;
  }
  return xml(
    `<p:sld xmlns:a="${DRAWING_NS}" xmlns:r="${DOC_REL_NS}" xmlns:p="${PPT_NS}">` +
      `<p:cSld name="Slide ${index + 1}">` +
        `<p:spTree>` +
          `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
          `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
          shapes.join("") +
        `</p:spTree>` +
      `</p:cSld>` +
      `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
    `</p:sld>`
  );
}

function buildPresentationXml(slides: PptxSlide[]): string {
  const slideIds = slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join("");
  return xml(
    `<p:presentation xmlns:a="${DRAWING_NS}" xmlns:r="${DOC_REL_NS}" xmlns:p="${PPT_NS}" saveSubsetFonts="1" autoCompressPictures="0">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      `<p:sldIdLst>${slideIds}</p:sldIdLst>` +
      `<p:sldSz cx="${PPT_WIDTH}" cy="${PPT_HEIGHT}"/>` +
      `<p:notesSz cx="6858000" cy="12192000"/>` +
      `<p:defaultTextStyle>` +
        `<a:lvl1pPr marL="0" algn="l" defTabSz="914400"><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr>` +
      `</p:defaultTextStyle>` +
    `</p:presentation>`
  );
}

function buildPresentationRelationships(slideCount: number): string {
  const slideRelationships = Array.from({ length: slideCount }, (_, index) =>
    `<Relationship Id="rId${index + 2}" Type="${DOC_REL_NS}/slide" Target="slides/slide${index + 1}.xml"/>`
  ).join("");
  return xml(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${DOC_REL_NS}/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
      slideRelationships +
      `<Relationship Id="rId${slideCount + 2}" Type="${DOC_REL_NS}/presProps" Target="presProps.xml"/>` +
      `<Relationship Id="rId${slideCount + 3}" Type="${DOC_REL_NS}/viewProps" Target="viewProps.xml"/>` +
      `<Relationship Id="rId${slideCount + 4}" Type="${DOC_REL_NS}/theme" Target="theme/theme1.xml"/>` +
      `<Relationship Id="rId${slideCount + 5}" Type="${DOC_REL_NS}/tableStyles" Target="tableStyles.xml"/>` +
    `</Relationships>`
  );
}

function buildSlideMasterXml(): string {
  return xml(
    `<p:sldMaster xmlns:a="${DRAWING_NS}" xmlns:r="${DOC_REL_NS}" xmlns:p="${PPT_NS}">` +
      `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
      `</p:spTree></p:cSld>` +
      `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
      `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
      `<p:hf sldNum="0" hdr="0" ftr="0" dt="0"/>` +
      `<p:txStyles>` +
        `<p:titleStyle><a:lvl1pPr algn="ctr" defTabSz="914400"><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>` +
        `<p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900" algn="l" defTabSz="914400"><a:spcBef><a:spcPct val="20000"/></a:spcBef><a:buFont typeface="Arial" pitchFamily="34" charset="0"/><a:buChar char="•"/><a:defRPr sz="3200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:bodyStyle>` +
        `<p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr><a:lvl1pPr marL="0" algn="l" defTabSz="914400"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:otherStyle>` +
      `</p:txStyles>` +
    `</p:sldMaster>`
  );
}

function buildSlideMasterRelationships(): string {
  return xml(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${DOC_REL_NS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
      `<Relationship Id="rId2" Type="${DOC_REL_NS}/theme" Target="../theme/theme1.xml"/>` +
    `</Relationships>`
  );
}

function buildSlideLayoutXml(): string {
  return xml(
    `<p:sldLayout xmlns:a="${DRAWING_NS}" xmlns:r="${DOC_REL_NS}" xmlns:p="${PPT_NS}" preserve="1">` +
      `<p:cSld name="DEFAULT">` +
        `<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>` +
        `<p:spTree>` +
          `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
          `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
        `</p:spTree>` +
      `</p:cSld>` +
      `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
    `</p:sldLayout>`
  );
}

function buildSlideLayoutRelationships(): string {
  return xml(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${DOC_REL_NS}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
    `</Relationships>`
  );
}

function buildSlideRelationships(imageAssets: PptxImageAsset[] = []): string {
  const imageRelationships = imageAssets
    .map((asset) => `<Relationship Id="${asset.relId}" Type="${DOC_REL_NS}/image" Target="${asset.target}"/>`)
    .join("");
  return xml(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${DOC_REL_NS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
      imageRelationships +
    `</Relationships>`
  );
}

function buildViewPropsXml(): string {
  return xml(
    `<p:viewPr xmlns:a="${DRAWING_NS}" xmlns:r="${DOC_REL_NS}" xmlns:p="${PPT_NS}">` +
      `<p:normalViewPr horzBarState="maximized"><p:restoredLeft sz="15611"/><p:restoredTop sz="94610"/></p:normalViewPr>` +
      `<p:slideViewPr><p:cSldViewPr snapToGrid="0" snapToObjects="1"><p:cViewPr varScale="1"><p:scale><a:sx n="136" d="100"/><a:sy n="136" d="100"/></p:scale><p:origin x="216" y="312"/></p:cViewPr><p:guideLst/></p:cSldViewPr></p:slideViewPr>` +
      `<p:notesTextViewPr><p:cViewPr><p:scale><a:sx n="1" d="1"/><a:sy n="1" d="1"/></p:scale><p:origin x="0" y="0"/></p:cViewPr></p:notesTextViewPr>` +
      `<p:gridSpacing cx="76200" cy="76200"/>` +
    `</p:viewPr>`
  );
}

function buildPresentationPropsXml(): string {
  return xml(`<p:presentationPr xmlns:a="${DRAWING_NS}" xmlns:r="${DOC_REL_NS}" xmlns:p="${PPT_NS}"/>`);
}

function buildTableStylesXml(): string {
  return xml(`<a:tblStyleLst xmlns:a="${DRAWING_NS}" def="${PPT_TABLE_STYLE_ID}"/>`);
}

function buildThemeXml(): string {
  return xml(
    `<a:theme xmlns:a="${DRAWING_NS}" name="Office Theme">` +
      `<a:themeElements>` +
        `<a:clrScheme name="Office">` +
          `<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>` +
          `<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
          `<a:dk2><a:srgbClr val="44546A"/></a:dk2>` +
          `<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>` +
          `<a:accent1><a:srgbClr val="4472C4"/></a:accent1>` +
          `<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>` +
          `<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>` +
          `<a:accent4><a:srgbClr val="FFC000"/></a:accent4>` +
          `<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>` +
          `<a:accent6><a:srgbClr val="70AD47"/></a:accent6>` +
          `<a:hlink><a:srgbClr val="0563C1"/></a:hlink>` +
          `<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>` +
        `</a:clrScheme>` +
        `<a:fontScheme name="Office">` +
          `<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
          `<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>` +
        `</a:fontScheme>` +
        `<a:fmtScheme name="Office">` +
          `<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>` +
          `<a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln></a:lnStyleLst>` +
          `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
          `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>` +
        `</a:fmtScheme>` +
      `</a:themeElements>` +
      `<a:objectDefaults/>` +
      `<a:extraClrSchemeLst/>` +
    `</a:theme>`
  );
}

async function createPptxImageAsset(
  slide: Extract<PptxSlide, { layout: "diagram" }>,
  imageIndex: number
): Promise<PptxImageAsset> {
  const normalizedSvg = normalizeSvgForHtml(slide.svg);
  const intrinsic = getSvgDimensions(normalizedSvg);
  const scaled = clampSize(intrinsic.widthPx, intrinsic.heightPx, 960, 480);
  const rendered = renderSvgToPng(normalizedSvg, { width: scaled.width });
  return {
    relId: "rId2",
    name: `Diagram ${imageIndex}`,
    target: `../media/diagram-${imageIndex}.png`,
    buffer: rendered.png,
    widthEmu: pxToEmu(rendered.widthPx),
    heightEmu: pxToEmu(rendered.heightPx),
    caption: slide.caption,
  };
}

export async function renderDocxOpenXml(payload: DocxDocumentPayload, outputPath: string): Promise<void> {
  const zip = new JSZip();
  const author = payload.metadata?.author ?? "Stuart";
  const subject = payload.metadata?.subject ?? payload.sections?.[0]?.heading ?? "Study notes";
  const description = payload.metadata?.description ?? "Generated by Stuart";
  const { documentXml, imageAssets } = await docxBodyXml(payload);

  zip.file("[Content_Types].xml", buildWordContentTypes());
  zip.file("_rels/.rels", buildRootRelationships("word/document.xml"));
  zip.file("docProps/core.xml", buildCoreProperties(subject, subject, author, description));
  zip.file("docProps/app.xml", buildWordAppProperties());
  zip.file("word/document.xml", documentXml);
  zip.file("word/_rels/document.xml.rels", buildDocxDocumentRelationships(imageAssets));
  zip.file("word/styles.xml", buildDocxStylesXml());
  zip.file("word/settings.xml", buildDocxSettingsXml());
  zip.file("word/numbering.xml", buildDocxNumberingXml());
  imageAssets.forEach((asset) => {
    zip.file(`word/${asset.target}`, asset.buffer);
  });

  await writeFile(outputPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

export async function renderXlsxOpenXml(payload: XlsxWorkbookPayload, outputPath: string): Promise<void> {
  const zip = new JSZip();
  const baseSheets = [...(payload.sheets ?? [])];
  const sourceNotes = payload.sourceNotes ?? [];
  if (sourceNotes.length > 0) {
    baseSheets.push({
      name: "Sources",
      columns: [{ header: "Source", width: 80 }],
      rows: sourceNotes.map((note) => [note]),
    });
  }
  const sheets = baseSheets.map((sheet, index) => ({
    ...sheet,
    name: (sheet.name || `Sheet${index + 1}`).slice(0, 31),
  }));
  const styles = buildSpreadsheetStyleRegistry(sheets);

  zip.file("[Content_Types].xml", buildSpreadsheetContentTypes(sheets.length));
  zip.file("_rels/.rels", buildRootRelationships("xl/workbook.xml"));
  zip.file("docProps/core.xml", buildCoreProperties("Workbook", "Workbook", "Stuart", "Generated by Stuart"));
  zip.file("docProps/app.xml", buildSpreadsheetAppProperties(sheets.map((sheet) => sheet.name)));
  zip.file("xl/workbook.xml", buildWorkbookXml(sheets));
  zip.file("xl/_rels/workbook.xml.rels", buildWorkbookRelationships(sheets.length));
  zip.file("xl/styles.xml", styles.toXml());
  sheets.forEach((sheet, index) => {
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, buildWorksheetXml(sheet, styles));
  });

  await writeFile(outputPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

export async function renderPptxOpenXml(payload: PptxPresentationPayload, outputPath: string): Promise<void> {
  const zip = new JSZip();
  const theme = {
    primaryColor: normalizeHexColor(payload.theme?.primaryColor, "2962FF"),
    fontFamily: payload.theme?.fontFamily ?? "Arial",
  };
  const slides: PptxSlide[] = [...(payload.slides ?? [])];
  if ((payload.citations ?? []).length > 0) {
    slides.push({
      layout: "sources",
      entries: formatCitations(payload.citations),
    });
  }

  zip.file("[Content_Types].xml", buildPresentationContentTypes(slides.length));
  zip.file("_rels/.rels", buildRootRelationships("ppt/presentation.xml"));
  zip.file("docProps/core.xml", buildCoreProperties("Presentation", "Presentation", "Stuart", "Generated by Stuart"));
  zip.file("docProps/app.xml", buildPresentationAppProperties(slides.map((slide) => slideTitle(slide))));
  zip.file("ppt/presentation.xml", buildPresentationXml(slides));
  zip.file("ppt/_rels/presentation.xml.rels", buildPresentationRelationships(slides.length));
  zip.file("ppt/presProps.xml", buildPresentationPropsXml());
  zip.file("ppt/viewProps.xml", buildViewPropsXml());
  zip.file("ppt/tableStyles.xml", buildTableStylesXml());
  zip.file("ppt/theme/theme1.xml", buildThemeXml());
  zip.file("ppt/slideMasters/slideMaster1.xml", buildSlideMasterXml());
  zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels", buildSlideMasterRelationships());
  zip.file("ppt/slideLayouts/slideLayout1.xml", buildSlideLayoutXml());
  zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels", buildSlideLayoutRelationships());
  for (const [index, slide] of slides.entries()) {
    const imageAssets: PptxImageAsset[] = [];
    if (slide.layout === "diagram") {
      imageAssets.push(await createPptxImageAsset(slide, index + 1));
    }
    zip.file(`ppt/slides/slide${index + 1}.xml`, buildSlideXml(slide, index, theme, { imageAsset: imageAssets[0] }));
    zip.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`, buildSlideRelationships(imageAssets));
    imageAssets.forEach((asset) => {
      zip.file(`ppt/media/${asset.target.replace("../media/", "")}`, asset.buffer);
    });
  }

  await writeFile(outputPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}
