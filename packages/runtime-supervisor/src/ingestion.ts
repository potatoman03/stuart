import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile, rm, mkdtemp, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import JSZip from "jszip";
import mammoth from "mammoth";
import { XMLParser } from "fast-xml-parser";
// Lazy-imported to avoid DOMMatrix reference at load time (crashes in Electron main process).
type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let _pdfjs: PdfjsModule | null = null;
async function loadPdfjs(): Promise<PdfjsModule> {
  if (!_pdfjs) {
    _pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return _pdfjs;
}
import XLSX from "xlsx";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExtractedChunk = {
  heading?: string;
  locator?: string;
  text: string;
};

export type ParsedIngestionDocument =
  | {
      status: "indexed";
      parser: string;
      fileType: string;
      chunks: ExtractedChunk[];
    }
  | {
      status: "skipped" | "failed";
      parser: string;
      fileType: string;
      error?: string;
      chunks: [];
    };

type ChunkModality = "text" | "ocr";

type ExtractedSection = {
  heading?: string;
  locator?: string;
  modality?: ChunkModality;
  text: string;
};

type SemanticBlock = {
  content: string;
  headingPath: string[];
  tokenEstimate: number;
};

type InternalChunk = {
  ordinal: number;
  content: string;
  tokenEstimate: number;
  summary: string;
  headingPath: string[];
  keywords: string[];
  locator?: string;
  modality?: ChunkModality;
  spanStart: number;
  spanEnd: number;
  reconciled: boolean;
};

type PersistedVisualPreview = {
  id: string;
  kind: "rendered-page" | "embedded-image" | "standalone-image";
  locator: string;
  imagePath: string;
  textPreview: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const chunkTokenTarget = Number(process.env.STUART_INGESTION_CHUNK_TOKENS ?? 380);
const chunkOverlapTokens = Number(process.env.STUART_INGESTION_OVERLAP_TOKENS ?? 80);
const structuredChunkMaxChars = chunkTokenTarget * 4;

const structuredExtensions = new Set([".pdf", ".docx", ".xlsx", ".xls", ".pptx"]);
const ocrImageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);

const textLikeExtensions = new Set([
  ".md", ".txt", ".json", ".yml", ".yaml", ".csv", ".tsv",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".css", ".scss", ".xml", ".html", ".htm",
  ".toml", ".ini", ".cfg", ".conf",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".cpp", ".h", ".hpp",
  ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".graphql", ".gql",
  ".r", ".R", ".jl", ".lua", ".pl", ".pm",
  ".ex", ".exs", ".erl", ".hrl",
  ".hs", ".ml", ".mli", ".fs", ".fsx",
  ".dart", ".scala", ".clj", ".cljs",
  ".vue", ".svelte", ".astro",
  ".env", ".gitignore", ".npmrc", ".prettierrc", ".eslintrc",
  ".rtf", ".tex", ".bib", ".ipynb",
  ".dockerfile",
]);

const textLikeBaseNames = new Set([
  ".env", ".env.example", ".gitignore", ".npmrc", ".prettierrc", ".eslintrc",
  "dockerfile", "makefile",
]);

const stopWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "how", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "with",
]);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
});

const require_ = createRequire(import.meta.url);
const pdfStandardFontDataUrl = `${join(
  dirname(require_.resolve("pdfjs-dist/package.json")),
  "standard_fonts",
)}${sep}`;

const renderPdfScriptPath = resolve(
  dirname(new URL(import.meta.url).pathname),
  "../../ingestion-tools/scripts/render_pdf.swift",
);

const previewRoot = resolve(process.env.STUART_DATA_DIR ?? ".stuart-data", "ingestion-previews");

const commandAvailability = new Map<string, Promise<boolean>>();

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

const execFileAsync = (
  command: string,
  args: string[],
  cwd?: string,
  timeoutMs?: number,
) =>
  new Promise<{ stdout: string; stderr: string }>((resolve_, reject) => {
    execFile(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve_({ stdout, stderr });
    });
  });

const estimateTokens = (value: string) => Math.max(1, Math.ceil(value.length / 4));

const normalizeWhitespace = (value: string) =>
  value
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const dedupe = (values: string[]) => [...new Set(values.filter(Boolean))];

const coerceJoinedText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => coerceJoinedText(entry)).join("");
  return "";
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

const hasCommand = async (command: string) => {
  const existing = commandAvailability.get(command);
  if (existing) return existing;
  const pending = execFileAsync("which", [command])
    .then(() => true)
    .catch(() => false);
  commandAvailability.set(command, pending);
  return pending;
};

const createTempDir = async (prefix: string) => mkdtemp(join(tmpdir(), prefix));

const cleanupDir = async (directory: string | null | undefined) => {
  if (!directory || directory === "." || directory === resolve(".")) return;
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
};

const isProbablyText = (buffer: Buffer) => {
  if (buffer.length === 0) return true;
  let printable = 0;
  for (const value of buffer.subarray(0, 4096)) {
    if (
      value === 9 || value === 10 || value === 13 ||
      (value >= 32 && value <= 126) || value >= 160
    ) {
      printable += 1;
    }
  }
  return printable / Math.min(buffer.length, 4096) > 0.92;
};

// ---------------------------------------------------------------------------
// Visual previews
// ---------------------------------------------------------------------------

const createPreviewId = (relativePath: string, locator: string, kind: PersistedVisualPreview["kind"]) =>
  createHash("sha1").update(`${relativePath}:${locator}:${kind}`).digest("hex").slice(0, 16);

const createPreviewDir = async (relativePath: string) => {
  const hash = createHash("sha1").update(relativePath).digest("hex").slice(0, 16);
  const directory = join(previewRoot, hash);
  await mkdir(directory, { recursive: true });
  return directory;
};

const persistVisualPreview = async (
  relativePath: string,
  kind: PersistedVisualPreview["kind"],
  locator: string,
  fileName: string,
  buffer: Buffer,
): Promise<PersistedVisualPreview> => {
  const directory = await createPreviewDir(relativePath);
  const imagePath = join(directory, fileName);
  await writeFile(imagePath, buffer);
  return {
    id: createPreviewId(relativePath, locator, kind),
    kind,
    locator,
    imagePath,
    textPreview: "",
  };
};

// ---------------------------------------------------------------------------
// OCR / rendering helpers
// ---------------------------------------------------------------------------

const runTesseract = async (filePath: string) => {
  if (!(await hasCommand("tesseract"))) return "";
  try {
    const { stdout } = await execFileAsync("tesseract", [filePath, "stdout", "--psm", "6"], undefined, 20_000);
    return normalizeWhitespace(stdout);
  } catch {
    return "";
  }
};

const renderPdfPages = async (filePath: string) => {
  if (process.platform !== "darwin") return [] as Array<{ pageNumber: number; imagePath: string }>;
  if (!(await hasCommand("swift"))) return [] as Array<{ pageNumber: number; imagePath: string }>;

  const outputDir = await createTempDir("stuart-render-pdf-");
  try {
    const { stdout } = await execFileAsync("swift", [renderPdfScriptPath, filePath, outputDir, "1600"], undefined, 60_000);
    const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      await cleanupDir(outputDir);
      return [];
    }
    return lines.map((imagePath, index) => ({ pageNumber: index + 1, imagePath }));
  } catch {
    await cleanupDir(outputDir);
    return [];
  }
};

const convertDocxToPdf = async (filePath: string) => {
  if (!(await hasCommand("soffice"))) return null;

  const profileDir = await createTempDir("stuart-soffice-profile-");
  const outputDir = await createTempDir("stuart-docx-pdf-");
  try {
    await execFileAsync("soffice", [
      `-env:UserInstallation=file://${profileDir}`,
      "--invisible", "--headless", "--norestore",
      "--convert-to", "pdf",
      "--outdir", outputDir,
      filePath,
    ], undefined, 60_000);
    const pdfPath = join(outputDir, `${basename(filePath, extname(filePath))}.pdf`);
    await access(pdfPath);
    await cleanupDir(profileDir);
    return { pdfPath, outputDir };
  } catch {
    await cleanupDir(profileDir);
    await cleanupDir(outputDir);
    return null;
  }
};

const ocrImageBuffers = async (
  relativePath: string,
  entries: Array<{ buffer: Buffer; extension: string; label: string; locator?: string }>,
  heading: string,
  kind: PersistedVisualPreview["kind"],
) => {
  if (entries.length === 0) {
    return { sections: [] as ExtractedSection[], previews: [] as PersistedVisualPreview[] };
  }

  const sections: ExtractedSection[] = [];
  const previews: PersistedVisualPreview[] = [];

  for (const [index, entry] of entries.entries()) {
    const safeExtension = ocrImageExtensions.has(entry.extension) ? entry.extension : ".png";
    const locator = entry.locator ?? entry.label;
    const preview = await persistVisualPreview(
      relativePath, kind, locator,
      `${slugify(locator) || `image-${index + 1}`}${safeExtension}`,
      entry.buffer,
    );
    const text = await runTesseract(preview.imagePath);
    preview.textPreview = text.slice(0, 180);
    previews.push(preview);
    if (!text) continue;
    sections.push({ heading, locator, modality: "ocr", text });
  }

  return { sections, previews };
};

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

const extractNotebookOutputText = (value: unknown): string => {
  if (!value || typeof value !== "object") return "";
  const output = value as {
    text?: unknown; data?: Record<string, unknown>;
    ename?: string; evalue?: string; traceback?: unknown;
  };
  const plainText =
    coerceJoinedText(output.text) ||
    coerceJoinedText(output.data?.["text/plain"]) ||
    coerceJoinedText(output.data?.["text/markdown"]) ||
    coerceJoinedText(output.data?.["application/json"]);
  if (plainText.trim()) return plainText;
  const traceback = coerceJoinedText(output.traceback);
  if (traceback.trim()) return traceback;
  if (output.ename || output.evalue) return [output.ename, output.evalue].filter(Boolean).join(": ");
  return "";
};

const normalizeNotebook = (raw: string) => {
  try {
    const parsed = JSON.parse(raw) as {
      metadata?: { title?: string };
      cells?: Array<{ cell_type?: string; source?: unknown; outputs?: unknown[] }>;
    };
    const cells = Array.isArray(parsed.cells) ? parsed.cells : [];
    const sections: string[] = [parsed.metadata?.title ? `# ${parsed.metadata.title}` : "# Notebook"];

    for (const [index, cell] of cells.entries()) {
      const source = normalizeWhitespace(coerceJoinedText(cell.source));
      const kind = cell.cell_type === "markdown" ? "markdown" : "code";
      sections.push(`## Cell ${index + 1} (${kind})`);
      if (source) {
        if (kind === "code") {
          sections.push("```"); sections.push(source); sections.push("```");
        } else {
          sections.push(source);
        }
      }
      const outputText = normalizeWhitespace(
        (cell.outputs ?? []).map((o) => extractNotebookOutputText(o)).filter(Boolean).join("\n\n"),
      );
      if (outputText) {
        sections.push("### Output");
        sections.push(outputText);
      }
    }
    return normalizeWhitespace(sections.join("\n\n"));
  } catch {
    return raw;
  }
};

const stripRtf = (raw: string) =>
  normalizeWhitespace(
    raw
      .replace(/\\par[d]?/g, "\n")
      .replace(/\\line/g, "\n")
      .replace(/\\tab/g, "\t")
      .replace(/\\'([0-9a-f]{2})/gi, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/\\[a-z]+-?\d* ?/gi, " ")
      .replace(/[{}]/g, " "),
  );

const normalizeLatex = (raw: string) =>
  normalizeWhitespace(
    raw
      .replace(/\\section\*?\{([^}]+)\}/g, "\n# $1\n")
      .replace(/\\subsection\*?\{([^}]+)\}/g, "\n## $1\n")
      .replace(/\\subsubsection\*?\{([^}]+)\}/g, "\n### $1\n")
      .replace(/\\paragraph\*?\{([^}]+)\}/g, "\n#### $1\n")
      .replace(/\\item/g, "\n- ")
      .replace(/\\(?:textbf|textit|emph|underline)\{([^}]*)\}/g, "$1")
      .replace(/\\href\{[^}]*\}\{([^}]*)\}/g, "$1")
      .replace(/\\url\{([^}]*)\}/g, "$1")
      .replace(/\\(?:cite|citet|citep|ref|label)\*?(?:\[[^\]]*\])?\{[^}]*\}/g, " ")
      .replace(/\\begin\{[^}]+\}|\\end\{[^}]+\}/g, "\n")
      .replace(/\\[a-z@]+(?:\[[^\]]*\])?/gi, " ")
      .replace(/[{}]/g, " "),
  );

const stripHtml = (raw: string) =>
  raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

const normalizeText = (parser: string, raw: string) => {
  if (parser === "html") return normalizeWhitespace(stripHtml(raw));
  if (parser === "json") {
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return normalizeWhitespace(raw); }
  }
  if (parser === "notebook") return normalizeNotebook(raw);
  if (parser === "rtf") return stripRtf(raw);
  if (parser === "latex") return normalizeLatex(raw);
  if (parser === "markdown") return normalizeWhitespace(raw.replace(/^---[\s\S]*?---\n/, ""));
  return normalizeWhitespace(raw);
};

// ---------------------------------------------------------------------------
// XML / PPTX text extraction
// ---------------------------------------------------------------------------

const decodeXmlEntities = (value: string) =>
  value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const collectTextNodes = (value: unknown, into: string[]): void => {
  if (typeof value === "string") {
    const normalized = decodeXmlEntities(value).trim();
    if (normalized) into.push(normalized);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectTextNodes(entry, into);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "a:t" || key === "#text" || key === "w:t") {
      collectTextNodes(child, into);
      continue;
    }
    collectTextNodes(child, into);
  }
};

const extractPptxText = (xml: string) => {
  try {
    const parsed = xmlParser.parse(xml);
    const collected: string[] = [];
    collectTextNodes(parsed, collected);
    return collected.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return decodeXmlEntities(xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
  }
};

// ---------------------------------------------------------------------------
// Parser detection
// ---------------------------------------------------------------------------

const resolveExtension = (filePath: string) => {
  const base = basename(filePath).toLowerCase();
  if (base.startsWith(".env")) return ".env";
  if (textLikeBaseNames.has(base)) return base;
  return extname(filePath).toLowerCase();
};

const detectParser = (extension: string, filePath: string) => {
  const base = basename(filePath).toLowerCase();
  if (extension === ".md") return "markdown";
  if (extension === ".html" || extension === ".xml") return "html";
  if (extension === ".json") return "json";
  if (extension === ".ipynb") return "notebook";
  if (extension === ".rtf") return "rtf";
  if (extension === ".tex" || extension === ".bib") return "latex";
  if (extension === ".pdf") return "pdfjs";
  if (extension === ".docx") return "mammoth";
  if (extension === ".xlsx" || extension === ".xls") return "xlsx";
  if (extension === ".pptx") return "pptx";
  if (ocrImageExtensions.has(extension)) return "tesseract";
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".swift"].includes(extension)) return "code";
  if ([".yml", ".yaml", ".toml", ".ini", ".env"].includes(extension) || textLikeBaseNames.has(base)) return "config";
  if (textLikeExtensions.has(extension)) return "plain-text";
  return "binary-placeholder";
};

// ---------------------------------------------------------------------------
// Section splitting (for structured documents)
// ---------------------------------------------------------------------------

const splitSections = (text: string, defaultHeading: string): ExtractedSection[] => {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];

  const blocks = normalized.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const sections: ExtractedSection[] = [];
  let currentHeading = defaultHeading;

  for (const block of blocks) {
    if (/^#{1,6}\s+/.test(block)) {
      currentHeading = block.replace(/^#{1,6}\s+/, "").trim();
      continue;
    }
    sections.push({ heading: currentHeading, text: block });
  }

  return sections;
};

// ---------------------------------------------------------------------------
// Keyword extraction
// ---------------------------------------------------------------------------

const tokenizeWords = (value: string) =>
  value
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/)
    .map((e) => e.trim())
    .filter((e) => e.length >= 3 && !stopWords.has(e));

const topKeywords = (value: string, count = 6, exclude: string[] = []) => {
  const frequency = new Map<string, number>();
  const blocked = new Set(exclude.map((e) => e.toLowerCase()));
  for (const token of tokenizeWords(value)) {
    if (blocked.has(token)) continue;
    frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  return [...frequency.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([token]) => token);
};

// ---------------------------------------------------------------------------
// Outline extraction
// ---------------------------------------------------------------------------

type OutlineItem = { id: string; label: string; depth: number };

const buildOutline = (parser: string, normalizedText: string): OutlineItem[] => {
  const outline: OutlineItem[] = [];
  const lines = normalizedText.split("\n");
  const supportsMarkdownHeadings = parser === "markdown" || parser === "notebook" || parser === "latex";

  if (supportsMarkdownHeadings) {
    for (const line of lines) {
      const match = line.match(/^(#{1,6})\s+(.+)$/);
      if (!match?.[1] || !match?.[2]) continue;
      const label = match[2]!.trim();
      outline.push({ id: slugify(label) || `heading-${outline.length + 1}`, label, depth: match[1]!.length });
    }
  }

  if (outline.length === 0 && parser === "code") {
    for (const line of lines) {
      const match = line.match(
        /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z0-9_]+)/,
      );
      if (!match?.[1]) continue;
      outline.push({ id: slugify(match[1]!) || `symbol-${outline.length + 1}`, label: match[1]!, depth: 1 });
    }
  }

  if (outline.length === 0) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      outline.push({ id: slugify(trimmed) || `line-${outline.length + 1}`, label: trimmed.slice(0, 96), depth: 0 });
      if (outline.length >= 3) break;
    }
  }

  return outline.slice(0, 24);
};

// ---------------------------------------------------------------------------
// Chunk summarization
// ---------------------------------------------------------------------------

const summarizeChunk = (content: string, headingPath: string[]) => {
  if (headingPath.length > 0) return `${headingPath.at(-1)}: ${content.slice(0, 160)}`.trim();
  return content.slice(0, 180).trim();
};

// ---------------------------------------------------------------------------
// Structured-document chunking (used for PDF, DOCX, XLSX, PPTX)
// ---------------------------------------------------------------------------

const chunkStructuredSections = (sections: ExtractedSection[]): InternalChunk[] => {
  const chunks: InternalChunk[] = [];
  const overlapChars = Math.max(120, Math.floor(structuredChunkMaxChars * 0.15));
  let ordinal = 0;

  for (const [sectionIndex, section] of sections.entries()) {
    const paragraphs = section.text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
    let buffer = "";

    const flush = (content: string) => {
      const headingPath = section.heading ? [section.heading] : [];
      chunks.push({
        ordinal,
        locator: section.locator,
        modality: section.modality ?? "text",
        content,
        tokenEstimate: estimateTokens(content),
        summary: summarizeChunk(content, headingPath),
        headingPath,
        keywords: topKeywords(content, 6, headingPath),
        spanStart: sectionIndex,
        spanEnd: sectionIndex,
        reconciled: true,
      });
      ordinal += 1;
    };

    for (const paragraph of paragraphs) {
      const candidate = buffer ? `${buffer}\n${paragraph}` : paragraph;
      if (candidate.length <= structuredChunkMaxChars) {
        buffer = candidate;
        continue;
      }
      if (buffer) flush(buffer);
      if (paragraph.length <= structuredChunkMaxChars) {
        buffer = paragraph;
        continue;
      }
      const step = Math.max(1, structuredChunkMaxChars - overlapChars);
      for (let start = 0; start < paragraph.length; start += step) {
        const slice = paragraph.slice(start, start + structuredChunkMaxChars).trim();
        if (slice) flush(slice);
      }
      buffer = "";
    }
    if (buffer) flush(buffer);
  }

  return chunks;
};

// ---------------------------------------------------------------------------
// Semantic block building (heading-aware for text files)
// ---------------------------------------------------------------------------

const buildBlocks = (parser: string, normalizedText: string): SemanticBlock[] => {
  const lines = normalizedText.split("\n");
  const blocks: SemanticBlock[] = [];
  let currentHeadingPath: string[] = [];
  let activeHeadingPath: string[] = [];
  let buffer: string[] = [];
  let inCodeFence = false;

  const flush = () => {
    const content = normalizeWhitespace(buffer.join("\n"));
    if (!content) { buffer = []; return; }
    blocks.push({ content, headingPath: [...activeHeadingPath], tokenEstimate: estimateTokens(content) });
    buffer = [];
  };

  const beginBuffer = () => {
    if (buffer.length === 0) activeHeadingPath = [...currentHeadingPath];
  };

  for (const line of lines) {
    const markdownHeading =
      parser === "markdown" || parser === "notebook" || parser === "latex"
        ? line.match(/^(#{1,6})\s+(.+)$/)
        : null;
    const codeSymbol =
      parser === "code"
        ? line.match(/^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z0-9_]+)/)
        : null;

    if (markdownHeading?.[1] && markdownHeading?.[2] && !inCodeFence) {
      flush();
      currentHeadingPath = currentHeadingPath
        .slice(0, Math.max(0, markdownHeading[1]!.length - 1))
        .concat(markdownHeading[2]!.trim());
      activeHeadingPath = [...currentHeadingPath];
      buffer = [markdownHeading[2]!.trim()];
      flush();
      continue;
    }

    if (codeSymbol?.[1] && !inCodeFence) {
      flush();
      currentHeadingPath = [codeSymbol[1]!];
      activeHeadingPath = [...currentHeadingPath];
      buffer = [line];
      flush();
      continue;
    }

    if (line.trim().startsWith("```")) {
      beginBuffer();
      buffer.push(line);
      inCodeFence = !inCodeFence;
      continue;
    }

    if (!inCodeFence && line.trim() === "") {
      flush();
      continue;
    }

    beginBuffer();
    buffer.push(line);
  }

  flush();

  if (blocks.length === 0 && normalizedText) {
    return [{ content: normalizedText, headingPath: [], tokenEstimate: estimateTokens(normalizedText) }];
  }

  return blocks;
};

// ---------------------------------------------------------------------------
// Semantic chunk set (380-token target with 80-token overlap)
// ---------------------------------------------------------------------------

const buildChunkSet = (blocks: SemanticBlock[]): InternalChunk[] => {
  if (blocks.length === 0) return [];

  const chunks: InternalChunk[] = [];
  let startIndex = 0;
  let ordinal = 0;

  while (startIndex < blocks.length) {
    let endIndex = startIndex;
    let tokenEstimate = 0;

    while (endIndex < blocks.length) {
      const nextBlock = blocks[endIndex]!;
      const wouldExceed =
        tokenEstimate + nextBlock.tokenEstimate > chunkTokenTarget &&
        tokenEstimate >= Math.floor(chunkTokenTarget * 0.65);
      if (wouldExceed) break;
      tokenEstimate += nextBlock.tokenEstimate;
      endIndex += 1;
    }

    if (endIndex === startIndex) {
      endIndex += 1;
      tokenEstimate = blocks[startIndex]!.tokenEstimate;
    }

    const slice = blocks.slice(startIndex, endIndex);
    const content = slice.map((b) => b.content).join("\n\n");
    const headingPath = dedupe(slice.flatMap((b) => b.headingPath));
    const keywords = topKeywords(content, 6, headingPath);

    chunks.push({
      ordinal,
      content,
      tokenEstimate,
      summary: summarizeChunk(content, headingPath),
      headingPath,
      keywords,
      spanStart: startIndex,
      spanEnd: endIndex - 1,
      reconciled: false,
    });

    if (endIndex >= blocks.length) break;

    let nextStart = endIndex;
    let overlapBudget = 0;
    while (nextStart > startIndex) {
      const previous = blocks[nextStart - 1]!;
      if (overlapBudget + previous.tokenEstimate > chunkOverlapTokens) break;
      overlapBudget += previous.tokenEstimate;
      nextStart -= 1;
    }
    startIndex = Math.max(startIndex + 1, nextStart);
    ordinal += 1;
  }

  return chunks;
};

// ---------------------------------------------------------------------------
// Reconciliation: verify all blocks / headings are covered
// ---------------------------------------------------------------------------

const reconcileChunks = (
  outline: OutlineItem[],
  blocks: SemanticBlock[],
  chunks: InternalChunk[],
) => {
  if (chunks.length === 0 && blocks.length > 0) {
    chunks.push({
      ordinal: 0,
      content: blocks.map((b) => b.content).join("\n\n"),
      tokenEstimate: blocks.reduce((t, b) => t + b.tokenEstimate, 0),
      summary: "Full-text reconciliation chunk",
      headingPath: dedupe(blocks.flatMap((b) => b.headingPath)),
      keywords: topKeywords(blocks.map((b) => b.content).join("\n\n")),
      spanStart: 0,
      spanEnd: blocks.length - 1,
      reconciled: true,
    });
  }

  const coveredBlockIndexes = new Set<number>();
  for (const chunk of chunks) {
    for (let i = chunk.spanStart; i <= chunk.spanEnd; i += 1) coveredBlockIndexes.add(i);
  }

  const missingBlocks = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ index }) => !coveredBlockIndexes.has(index));

  if (missingBlocks.length > 0) {
    const content = missingBlocks.map(({ block }) => block.content).join("\n\n");
    chunks.push({
      ordinal: chunks.length,
      content,
      tokenEstimate: estimateTokens(content),
      summary: "Coverage reconciliation chunk",
      headingPath: dedupe(missingBlocks.flatMap(({ block }) => block.headingPath)),
      keywords: topKeywords(content),
      spanStart: missingBlocks[0]!.index,
      spanEnd: missingBlocks.at(-1)?.index ?? missingBlocks[0]!.index,
      reconciled: true,
    });
  }

  return chunks.map((chunk) => ({ ...chunk, reconciled: true }));
};

// ---------------------------------------------------------------------------
// Convert InternalChunk[] to ExtractedChunk[] (the public interface type)
// ---------------------------------------------------------------------------

const toExtractedChunks = (internal: InternalChunk[]): ExtractedChunk[] =>
  internal.map((chunk) => ({
    heading: chunk.headingPath.at(-1) ?? chunk.headingPath[0],
    locator: chunk.locator,
    text: chunk.content,
  }));

// ---------------------------------------------------------------------------
// PDF extraction (pdfjs-dist)
// ---------------------------------------------------------------------------

const extractPdfSections = async (
  filePath: string,
  buffer: Buffer,
  relativePath: string,
): Promise<{
  sections: ExtractedSection[];
  pageCount: number;
  sparsePageCount: number;
  previews: PersistedVisualPreview[];
}> => {
  const { getDocument } = await loadPdfjs();
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: pdfStandardFontDataUrl,
  });
  const pdf = await loadingTask.promise;
  const pages: Array<{ pageNumber: number; text: string; modality: ChunkModality }> = [];
  let sparsePageCount = 0;

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const items = textContent.items as Array<{ str?: string; transform?: number[] }>;
    const lines = new Map<number, string[]>();

    for (const item of items) {
      const text = item.str?.trim();
      if (!text) continue;
      const y = item.transform?.[5];
      const key = typeof y === "number" ? Math.round(y) : 0;
      const existing = lines.get(key) ?? [];
      existing.push(text);
      lines.set(key, existing);
    }

    const pageText = [...lines.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, text]) => text.join(" "))
      .join("\n");
    const normalizedPage = normalizeWhitespace(pageText);

    if (!normalizedPage || normalizedPage.length < 48) sparsePageCount += 1;

    pages.push({ pageNumber, text: normalizedPage, modality: "text" });
    page.cleanup();
  }

  await loadingTask.destroy();

  const sparsePages = pages.filter((p) => p.text.length < 48).map((p) => p.pageNumber);
  const previewTargets = sparsePages.length > 0 ? sparsePages : pages[0] ? [pages[0].pageNumber] : [];
  const previews: PersistedVisualPreview[] = [];

  if (previewTargets.length > 0) {
    const renderedPages = await renderPdfPages(filePath);
    if (renderedPages.length > 0) {
      const renderDir = dirname(renderedPages[0]!.imagePath);

      for (const pageNumber of previewTargets) {
        const renderedPage = renderedPages.find((e) => e.pageNumber === pageNumber);
        if (!renderedPage) continue;
        const pngBuffer = await readFile(renderedPage.imagePath);
        const preview = await persistVisualPreview(
          relativePath, "rendered-page", `page ${pageNumber}`,
          `page-${String(pageNumber).padStart(4, "0")}.png`, pngBuffer,
        );
        previews.push(preview);
      }

      for (const pageNumber of sparsePages) {
        const renderedPage = renderedPages.find((e) => e.pageNumber === pageNumber);
        if (!renderedPage) continue;
        const ocrText = await runTesseract(renderedPage.imagePath);
        const page = pages.find((e) => e.pageNumber === pageNumber);
        if (!ocrText || (page?.text.length ?? 0) >= ocrText.length) continue;
        if (page) { page.text = ocrText; page.modality = "ocr"; }
        else pages.push({ pageNumber, text: ocrText, modality: "ocr" });
      }

      await cleanupDir(renderDir);
    }
  }

  const sections = pages
    .filter((p) => p.text)
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .map((p) => ({
      heading: `Page ${p.pageNumber}`,
      locator: `page ${p.pageNumber}`,
      modality: p.modality,
      text: p.text,
    }));

  return { sections, pageCount: pdf.numPages, sparsePageCount, previews };
};

// ---------------------------------------------------------------------------
// DOCX extraction
// ---------------------------------------------------------------------------

const extractDocxSections = async (buffer: Buffer): Promise<ExtractedSection[]> => {
  const result = await mammoth.extractRawText({ buffer });
  return splitSections(result.value, "Document");
};

const extractDocxMediaSections = async (relativePath: string, buffer: Buffer) => {
  const zip = await JSZip.loadAsync(buffer);
  const mediaEntries = Object.keys(zip.files)
    .filter((name) => /^word\/media\//i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const ocrEntries: Array<{ buffer: Buffer; extension: string; label: string; locator?: string }> = [];

  for (const [index, entryName] of mediaEntries.entries()) {
    const file = zip.file(entryName);
    if (!file) continue;
    const extension = extname(entryName).toLowerCase();
    if (!ocrImageExtensions.has(extension)) continue;
    ocrEntries.push({
      buffer: await file.async("nodebuffer"),
      extension,
      label: basename(entryName),
      locator: `embedded image ${index + 1}`,
    });
  }

  return ocrImageBuffers(relativePath, ocrEntries, "Embedded Media", "embedded-image");
};

// ---------------------------------------------------------------------------
// Spreadsheet extraction
// ---------------------------------------------------------------------------

const extractSpreadsheetSections = (buffer: Buffer): ExtractedSection[] => {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sections: ExtractedSection[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as unknown[][];
    const normalizedRows = rows
      .map((row) => row.map((cell) => String(cell ?? "").trim()).filter(Boolean).join(" | "))
      .filter(Boolean);

    for (let index = 0; index < normalizedRows.length; index += 30) {
      const slice = normalizedRows.slice(index, index + 30);
      if (slice.length === 0) continue;
      sections.push({
        heading: sheetName,
        locator: `rows ${index + 1}-${index + slice.length}`,
        text: slice.join("\n"),
      });
    }
  }

  return sections;
};

// ---------------------------------------------------------------------------
// PPTX extraction
// ---------------------------------------------------------------------------

const extractPptxSections = async (buffer: Buffer): Promise<ExtractedSection[]> => {
  const zip = await JSZip.loadAsync(buffer);
  const sections: ExtractedSection[] = [];
  const slideEntries = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  for (const slideEntry of slideEntries) {
    const slideXml = await zip.file(slideEntry)?.async("string");
    if (!slideXml) continue;
    const slideNumber = slideEntry.match(/slide(\d+)\.xml/i)?.[1] ?? "?";
    const notesEntry = `ppt/notesSlides/notesSlide${slideNumber}.xml`;
    const notesXml = await zip.file(notesEntry)?.async("string");
    const slideText = extractPptxText(slideXml);
    const notesText = notesXml ? extractPptxText(notesXml) : "";
    const combined = [slideText, notesText].filter(Boolean).join("\n\n");
    if (!combined.trim()) continue;
    sections.push({ heading: `Slide ${slideNumber}`, locator: `slide ${slideNumber}`, text: combined });
  }

  return sections;
};

// ---------------------------------------------------------------------------
// Image extraction
// ---------------------------------------------------------------------------

const extractImageSections = async (
  relativePath: string,
  filePath: string,
  buffer: Buffer,
): Promise<{ sections: ExtractedSection[]; previews: PersistedVisualPreview[] }> => {
  const extension = extname(filePath).toLowerCase();
  return ocrImageBuffers(
    relativePath,
    [{ buffer, extension, label: basename(filePath), locator: basename(filePath) }],
    basename(filePath),
    "standalone-image",
  );
};

// ---------------------------------------------------------------------------
// Master structured-document extraction dispatcher
// ---------------------------------------------------------------------------

const extractStructuredDocument = async (
  filePath: string,
  relativePath: string,
  extension: string,
  buffer: Buffer,
): Promise<{
  parser: string;
  sections: ExtractedSection[];
}> => {
  if (extension === ".pdf") {
    const extracted = await extractPdfSections(filePath, buffer, relativePath);
    return { parser: "pdfjs", sections: extracted.sections };
  }

  if (extension === ".docx") {
    const sections = await extractDocxSections(buffer);
    const media = await extractDocxMediaSections(relativePath, buffer);
    const allSections = sections.concat(media.sections);

    if (allSections.length === 0) {
      const converted = await convertDocxToPdf(filePath);
      if (converted) {
        const renderedPages = await renderPdfPages(converted.pdfPath);
        const renderDir = renderedPages[0] ? dirname(renderedPages[0].imagePath) : null;
        for (const renderedPage of renderedPages) {
          const ocrText = await runTesseract(renderedPage.imagePath);
          if (!ocrText) continue;
          allSections.push({
            heading: `Page ${renderedPage.pageNumber}`,
            locator: `page ${renderedPage.pageNumber}`,
            modality: "ocr",
            text: ocrText,
          });
        }
        await cleanupDir(converted.outputDir);
        await cleanupDir(renderDir);
      }
    }

    return { parser: "mammoth", sections: allSections };
  }

  if (extension === ".xlsx" || extension === ".xls") {
    return { parser: "xlsx", sections: extractSpreadsheetSections(buffer) };
  }

  return { parser: "pptx", sections: await extractPptxSections(buffer) };
};

// ---------------------------------------------------------------------------
// Public API: isIngestiblePath
// ---------------------------------------------------------------------------

export function isIngestiblePath(filePath: string): boolean {
  const extension = resolveExtension(filePath);
  return (
    textLikeExtensions.has(extension) ||
    structuredExtensions.has(extension) ||
    ocrImageExtensions.has(extension) ||
    textLikeBaseNames.has(basename(filePath).toLowerCase())
  );
}

// ---------------------------------------------------------------------------
// Public API: parseDocumentForIngestion
// ---------------------------------------------------------------------------

export async function parseDocumentForIngestion(filePath: string): Promise<ParsedIngestionDocument> {
  const extension = resolveExtension(filePath);
  const parser = detectParser(extension, filePath);
  const fileType = extension.replace(/^\./, "") || "text";

  try {
    const buffer = await readFile(filePath);

    // ---- Structured documents (PDF, DOCX, XLSX, PPTX) ----
    if (structuredExtensions.has(extension)) {
      const relativePath = basename(filePath);
      const extracted = await extractStructuredDocument(filePath, relativePath, extension, buffer);
      const chunks = chunkStructuredSections(extracted.sections);

      if (chunks.length === 0) {
        return {
          status: "indexed",
          parser: extracted.parser,
          fileType,
          chunks: [],
        };
      }

      return {
        status: "indexed",
        parser: extracted.parser,
        fileType,
        chunks: toExtractedChunks(chunks),
      };
    }

    // ---- Image files (OCR via Tesseract) ----
    if (ocrImageExtensions.has(extension)) {
      const relativePath = basename(filePath);
      const extracted = await extractImageSections(relativePath, filePath, buffer);
      const chunks = chunkStructuredSections(extracted.sections);

      return {
        status: chunks.length > 0 ? "indexed" : "skipped",
        parser: "tesseract",
        fileType,
        chunks: chunks.length > 0 ? toExtractedChunks(chunks) : [],
      } as ParsedIngestionDocument;
    }

    // ---- Text-based sources ----
    const isText = textLikeExtensions.has(extension) ||
      textLikeBaseNames.has(basename(filePath).toLowerCase()) ||
      isProbablyText(buffer);

    if (!isText) {
      return {
        status: "skipped",
        parser: "binary-placeholder",
        fileType,
        chunks: [],
      };
    }

    const raw = buffer.toString("utf8");
    const normalizedText = normalizeText(parser, raw);

    if (!normalizedText) {
      return {
        status: "indexed",
        parser,
        fileType,
        chunks: [],
      };
    }

    const outline = buildOutline(parser, normalizedText);
    const blocks = buildBlocks(parser, normalizedText);
    const chunkSet = buildChunkSet(blocks);
    const reconciledChunks = reconcileChunks(outline, blocks, chunkSet);

    return {
      status: "indexed",
      parser,
      fileType,
      chunks: toExtractedChunks(reconciledChunks),
    };
  } catch (error) {
    return {
      status: "failed",
      parser,
      fileType,
      error: error instanceof Error ? error.message : String(error),
      chunks: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Public API: buildChunkIdentifiers
// ---------------------------------------------------------------------------

export function buildChunkIdentifiers(documentId: string, chunks: ExtractedChunk[]) {
  return chunks.map((chunk, index) => ({
    ...chunk,
    chunkId: createHash("sha1")
      .update(`${documentId}:${index}:${chunk.heading ?? ""}:${chunk.locator ?? ""}:${chunk.text}`)
      .digest("hex"),
  }));
}
