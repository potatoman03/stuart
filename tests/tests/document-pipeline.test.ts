import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "../../packages/runtime-supervisor/node_modules/jszip";
import { afterEach, describe, expect, it } from "vitest";
import { renderDocumentArtifact, validateOfficePackage } from "../../packages/runtime-supervisor/src/document-pipeline";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("document pipeline", () => {
  it("renders DOCX as a direct OpenXML package with rich block support and a preview asset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stuart-docx-openxml-"));
    cleanupPaths.push(directory);
    const result = await renderDocumentArtifact(
      "document_docx",
      {
        kind: "document_docx",
        title: "Notes",
        document: {
          metadata: { author: "Stuart", subject: "Search", description: "Study notes" },
          citations: [
            {
              sourceId: "src-1",
              relativePath: "Lecture 1.pdf",
              locator: "p. 2",
              excerpt: "Breadth-first search explores level by level.",
            },
          ],
          sections: [
            {
              heading: "Search",
              level: 1,
              paragraphs: [
                { type: "text", content: "Breadth-first search expands the shallowest node first." },
                { type: "text", content: "Runtime grows as $b^d$ for branching factor $b$ and depth $d$." },
                { type: "bullet", content: "Complete for finite branching factor." },
                { type: "numbered", content: "Use a queue frontier." },
                { type: "quote", content: "BFS is complete when the branching factor is finite." },
                { type: "math", content: "f(n) = g(n) + h(n)", display: true },
                {
                  type: "svg",
                  svg: "<svg viewBox=\"0 0 240 120\" xmlns=\"http://www.w3.org/2000/svg\"><rect x=\"20\" y=\"20\" width=\"60\" height=\"36\" rx=\"8\" fill=\"#DBEAFE\" stroke=\"#1D4ED8\"/><text x=\"50\" y=\"43\" text-anchor=\"middle\" font-size=\"14\">Start</text><path d=\"M80 38 H150\" stroke=\"#2563EB\" stroke-width=\"3\" marker-end=\"url(#arrow)\"/><rect x=\"150\" y=\"20\" width=\"70\" height=\"36\" rx=\"8\" fill=\"#DCFCE7\" stroke=\"#059669\"/><text x=\"185\" y=\"43\" text-anchor=\"middle\" font-size=\"14\">Queue</text><defs><marker id=\"arrow\" markerWidth=\"8\" markerHeight=\"8\" refX=\"7\" refY=\"4\" orient=\"auto\"><path d=\"M0,0 L8,4 L0,8 z\" fill=\"#2563EB\"/></marker></defs></svg>",
                  caption: "Frontier flow from start state into the BFS queue.",
                },
                { type: "code", content: "frontier.push(start)\nwhile frontier.size > 0", language: "python" },
                { type: "definition", term: "Frontier", definition: "The collection of discovered but unexplored states." },
                { type: "kv", entries: [{ key: "Optimal", value: "Yes for unit-cost edges" }] },
                { type: "divider" },
                {
                  type: "table",
                  headers: ["Algorithm", "Optimal"],
                  rows: [["BFS", "Yes"], ["DFS", "No"]],
                },
              ],
            },
          ],
        },
      },
      directory,
      "notes"
    );

    const archive = await JSZip.loadAsync(await readFile(result.outputPath));
    const documentXml = await archive.file("word/document.xml")?.async("text");
    const documentRelsXml = await archive.file("word/_rels/document.xml.rels")?.async("text");
    const numberingXml = await archive.file("word/numbering.xml")?.async("text");
    const stylesXml = await archive.file("word/styles.xml")?.async("text");

    expect(documentXml).toContain("Breadth-first search expands the shallowest node first.");
    expect(documentXml).toContain("<w:numId w:val=\"1\"/>");
    expect(documentXml).toContain("<w:tbl>");
    expect(documentXml).toContain("<m:oMath");
    expect(documentXml).toContain("f(n)=g(n)+h(n)");
    expect(documentXml).toContain("<w:drawing>");
    expect(documentXml).toContain("bᵈ");
    expect(documentXml).toContain("Courier New");
    expect(documentXml).toContain("Frontier: ");
    expect(documentXml).toContain("The collection of discovered but unexplored states.");
    expect(documentXml).toContain("Key");
    expect(documentXml).toContain("References");
    expect(documentRelsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"');
    expect(archive.file("word/media/figure-1.png")).toBeTruthy();
    expect(numberingXml).toContain("decimal");
    expect(stylesXml).toContain("Heading1");
    expect(result.previewPath).toContain(".preview.html");
    expect(await readFile(result.previewPath, "utf8")).toContain("Breadth-first search expands the shallowest node first.");
    expect(await readFile(result.previewPath, "utf8")).toContain("Frontier flow from start state into the BFS queue.");
  }, 15000);

  it("renders XLSX as a direct OpenXML package with formulas, merges, panes, and a preview asset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stuart-xlsx-openxml-"));
    cleanupPaths.push(directory);
    const result = await renderDocumentArtifact(
      "document_xlsx",
      {
        kind: "document_xlsx",
        title: "Workbook",
        workbook: {
          sheets: [
            {
              name: "Summary",
              columns: [
                { header: "Topic", width: 24 },
                { header: "Score", width: 12 },
                { header: "Weighted", width: 16 },
              ],
              frozenRows: 1,
              frozenColumns: 1,
              autoFilter: true,
              merges: [{ startRow: 4, startColumn: 1, endRow: 4, endColumn: 2 }],
              rows: [
                [
                  { value: "Search $b^d$", style: "subheader" },
                  { value: 92, numberFormat: "0" },
                  { formula: "B2*1.1", value: 101.2, numberFormat: "0.0", style: "good" },
                ],
                [
                  { value: "Regression", style: "warning" },
                  { value: 81, numberFormat: "0" },
                  { formula: "B3*1.1", value: 89.1, numberFormat: "0.0" },
                ],
                [
                  { value: "Summary", style: "emphasis" },
                  { value: "Strong improvement", style: "muted" },
                  null,
                ],
              ],
            },
          ],
          sourceNotes: ["Lecture 1.pdf p.2", "Tutorial 3.pdf p.1"],
        },
      },
      directory,
      "workbook"
    );

    const archive = await JSZip.loadAsync(await readFile(result.outputPath));
    const workbookXml = await archive.file("xl/workbook.xml")?.async("text");
    const summarySheetXml = await archive.file("xl/worksheets/sheet1.xml")?.async("text");
    const sourcesSheetXml = await archive.file("xl/worksheets/sheet2.xml")?.async("text");
    const stylesXml = await archive.file("xl/styles.xml")?.async("text");

    expect(workbookXml).toContain('name="Summary"');
    expect(workbookXml).toContain('name="Sources"');
    expect(summarySheetXml).toContain("Topic");
    expect(summarySheetXml).toContain("<v>92</v>");
    expect(summarySheetXml).toContain("<f>B2*1.1</f>");
    expect(summarySheetXml).toContain("<pane xSplit=\"1\" ySplit=\"1\"");
    expect(summarySheetXml).toContain("<autoFilter ref=\"A1:C4\"/>");
    expect(summarySheetXml).toContain("<mergeCell ref=\"A4:B4\"/>");
    expect(summarySheetXml).toContain("Search bᵈ");
    expect(summarySheetXml).not.toContain("$");
    expect(sourcesSheetXml).toContain("Lecture 1.pdf p.2");
    expect(stylesXml).toContain("numFmtId");
    expect(stylesXml).toContain("wrapText=\"1\"");
    expect(result.previewPath).toContain(".preview.html");
    expect(await readFile(result.previewPath, "utf8")).toContain("Auto filter enabled");
    expect(await readFile(result.previewPath, "utf8")).toContain("Frozen panes: 1 row(s), 1 column(s)");
  });

  it("validates a minimal PPTX package and produces an HTML preview", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stuart-pptx-"));
    cleanupPaths.push(directory);
    const result = await renderDocumentArtifact(
      "document_pptx",
      {
        kind: "document_pptx",
        title: "Deck",
        presentation: {
          citations: [],
          slides: [
            { layout: "title", title: "Intro $E=mc^2$", subtitle: "Overview", notes: ["Open with the scope of the problem."] },
            { layout: "content", title: "Topic", bullets: ["Point A", "Point B $O(b^d)$"], notes: ["Use the diagram from lecture 2."] },
            {
              layout: "diagram",
              title: "Pruning sketch",
              svg: "<svg viewBox=\"0 0 360 180\" xmlns=\"http://www.w3.org/2000/svg\"><circle cx=\"180\" cy=\"28\" r=\"18\" fill=\"#DBEAFE\" stroke=\"#1D4ED8\"/><circle cx=\"100\" cy=\"100\" r=\"18\" fill=\"#DCFCE7\" stroke=\"#059669\"/><circle cx=\"260\" cy=\"100\" r=\"18\" fill=\"#FEE2E2\" stroke=\"#DC2626\"/><path d=\"M180 46 L100 82\" stroke=\"#374151\" stroke-width=\"3\"/><path d=\"M180 46 L260 82\" stroke=\"#374151\" stroke-width=\"3\" stroke-dasharray=\"8 6\"/><text x=\"180\" y=\"33\" text-anchor=\"middle\" font-size=\"13\">MAX</text><text x=\"100\" y=\"105\" text-anchor=\"middle\" font-size=\"13\">keep</text><text x=\"260\" y=\"105\" text-anchor=\"middle\" font-size=\"13\">prune</text></svg>",
              caption: "Alpha-beta can cut branches once a bound proves them irrelevant.",
              notes: ["Keep the labels minimal so the slide stays readable from a distance."],
            },
          ],
        },
      },
      directory,
      "deck"
    );

    const summary = await validateOfficePackage(result.outputPath, "document_pptx");
    expect(summary.entryPoint).toBe("ppt/presentation.xml");
    expect(summary.slideCount).toBeGreaterThanOrEqual(1);

    const archive = await JSZip.loadAsync(await readFile(result.outputPath));
    const presentationXml = await archive.file("ppt/presentation.xml")?.async("text");
    const slide1Xml = await archive.file("ppt/slides/slide1.xml")?.async("text");
    const slide2Xml = await archive.file("ppt/slides/slide2.xml")?.async("text");
    const slide3Xml = await archive.file("ppt/slides/slide3.xml")?.async("text");
    const slide3RelsXml = await archive.file("ppt/slides/_rels/slide3.xml.rels")?.async("text");
    const masterXml = await archive.file("ppt/slideMasters/slideMaster1.xml")?.async("text");
    const layoutXml = await archive.file("ppt/slideLayouts/slideLayout1.xml")?.async("text");
    const themeXml = await archive.file("ppt/theme/theme1.xml")?.async("text");

    expect(presentationXml).toContain("sldMasterIdLst");
    expect(slide1Xml).toContain("Intro E=mc²");
    expect(slide2Xml).toContain("Point B O(bᵈ)");
    expect(slide3Xml).toContain("<p:pic>");
    expect(slide1Xml).not.toContain("$");
    expect(slide2Xml).not.toContain("$");
    expect(slide3RelsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"');
    expect(archive.file("ppt/media/diagram-3.png")).toBeTruthy();
    expect(masterXml).toContain("txStyles");
    expect(layoutXml).toContain("masterClrMapping");
    expect(themeXml).toContain("Office Theme");
    expect(result.previewPath).toContain(".preview.html");
    expect(await readFile(result.previewPath, "utf8")).toContain("Presenter notes");
    expect(await readFile(result.previewPath, "utf8")).toContain("Use the diagram from lecture 2.");
    expect(await readFile(result.previewPath, "utf8")).toContain("Alpha-beta can cut branches once a bound proves them irrelevant.");
  });

  it("renders PDF artifacts without footer pagination crashes and uses the pdf as its preview asset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stuart-pdf-"));
    cleanupPaths.push(directory);
    const result = await renderDocumentArtifact(
      "document_pdf",
      {
        kind: "document_pdf",
        title: "Worked Guide",
        document: {
          metadata: { author: "Stuart", subject: "Worked Guide", description: "PDF study guide" },
          columns: 2,
          citations: [
            {
              sourceId: "src-1",
              relativePath: "Chapter 3.pdf",
              locator: "p. 12",
              excerpt: "Simplex chooses the entering variable by reduced cost.",
            },
          ],
          sections: [
            {
              heading: "Long Section",
              level: 1,
              paragraphs: [
                { type: "text", content: "A ".repeat(5000) },
                { type: "math", content: "$$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$", display: true },
                {
                  type: "svg",
                  svg: "<svg viewBox=\"0 0 320 160\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M30 130 L90 70 L160 90 L240 40 L290 55\" fill=\"none\" stroke=\"#2563EB\" stroke-width=\"6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><circle cx=\"30\" cy=\"130\" r=\"6\" fill=\"#2563EB\"/><circle cx=\"90\" cy=\"70\" r=\"6\" fill=\"#2563EB\"/><circle cx=\"160\" cy=\"90\" r=\"6\" fill=\"#2563EB\"/><circle cx=\"240\" cy=\"40\" r=\"6\" fill=\"#2563EB\"/><circle cx=\"290\" cy=\"55\" r=\"6\" fill=\"#2563EB\"/></svg>",
                  caption: "Trend line for the worked example.",
                },
              ],
            },
          ],
        },
      },
      directory,
      "worked-guide"
    );

    const pdfBuffer = await readFile(result.outputPath);
    expect(result.outputPath.endsWith(".pdf")).toBe(true);
    expect(result.previewPath).toBe(result.outputPath);
    expect(pdfBuffer.subarray(0, 5).toString()).toBe("%PDF-");
  }, 15000);

  it("fails validation when the Office entrypoint is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stuart-docx-"));
    cleanupPaths.push(directory);
    const filePath = join(directory, "notes.docx");
    await writeFile(filePath, "not-a-valid-office-package", "utf8");

    await expect(validateOfficePackage(filePath, "document_docx")).rejects.toThrow();
  });
});
