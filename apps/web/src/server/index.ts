import { createHash } from "node:crypto";
import cors from "cors";
import express from "express";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, join, resolve } from "node:path";
import { build as buildBundle } from "esbuild";
import mammoth from "mammoth";
import {
  StuartHarness,
  StuartHarnessServer
} from "@stuart/harness";
import { extractUploadedPptxPreviewSlides } from "@stuart/runtime-supervisor";
import type { WorkspaceFileRecord } from "@stuart/shared";
import XLSX from "xlsx";

export interface StuartWebServerOptions {
  workspaceRoot?: string;
  dataDir?: string;
  staticDir?: string;
  vmHelperBinaryPath?: string;
  port?: number;
  openExternalPath?: (absolutePath: string) => Promise<void>;
}

export interface RunningStuartWebServer {
  harness: StuartHarness;
  server: StuartHarnessServer;
  app: express.Express;
  port: number;
  dataDir: string;
  workspaceRoot: string;
  close: () => Promise<void>;
}

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const reactEntry = require.resolve("react");
const reactDomClientEntry = require.resolve("react-dom/client");
const reactJsxRuntimeEntry = require.resolve("react/jsx-runtime");
const previewWorkspaceRoot = resolveWorkspaceRoot();

export async function startStuartWebServer(
  options: StuartWebServerOptions = {}
): Promise<RunningStuartWebServer> {
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);
  const dataDir = resolveDataDir(workspaceRoot, options.dataDir);
  const helperCandidate = resolveVmHelperBinaryPath(workspaceRoot, options.vmHelperBinaryPath);
  const staticDir = resolveStaticDir(workspaceRoot, options.staticDir);
  const harness = new StuartHarness({
    dataDir,
    vmHelperBinaryPath: helperCandidate,
    workspaceRoot
  });
  const server = new StuartHarnessServer({
    harness,
    openExternalPath: options.openExternalPath ?? defaultOpenExternalPath
  });
  const app = server.app;
  const port = Number(options.port ?? process.env.PORT ?? 8787);

  app.use(cors());

  app.get("/api/tasks/:taskId/workspace-files/:entryId/preview", asyncRoute(async (request, response) => {
    const taskId = firstParam(request.params.taskId);
    const entryId = firstParam(request.params.entryId);
    const taskRunId =
      typeof request.query.taskRunId === "string" ? request.query.taskRunId : undefined;
    const locator =
      typeof request.query.locator === "string" ? request.query.locator.trim() || undefined : undefined;
    const entry = await harness.runtime.resolveWorkspaceFile(
      taskId,
      entryId,
      taskRunId
    );

    switch (entry.previewKind) {
      case "pdf":
        response.type("application/pdf");
        response.sendFile(entry.absolutePath);
        return;
      case "image":
        response.sendFile(entry.absolutePath);
        return;
      case "html":
        response.type("text/html");
        response.send(
          rewriteHtmlAssets(
            await readFile(entry.absolutePath, "utf8"),
            taskId,
            entry.id,
            taskRunId
          )
        );
        return;
      case "docx":
        response.type("text/html");
        response.send(await renderDocxPreview(entry.absolutePath, entry.name));
        return;
      case "xlsx":
        response.type("text/html");
        response.send(renderWorkbookPreview(entry.absolutePath, entry.name));
        return;
      case "pptx":
        {
          const quickLookPreview = await ensureQuickLookHtmlPreview(entry.absolutePath, dataDir, "pptx");
          if (quickLookPreview) {
            response.type("text/html");
            response.send(
              enhanceQuickLookPptxPreviewHtml(
                rewriteGeneratedPreviewAssets(
                  await readFile(quickLookPreview.htmlPath, "utf8"),
                  taskId,
                  entry.id,
                  taskRunId
                ),
                locator
              )
            );
            return;
          }
          const pdfPreviewPath = await ensureOfficePdfPreview(entry.absolutePath, dataDir, "pptx");
          if (pdfPreviewPath) {
            response.type("application/pdf");
            response.sendFile(pdfPreviewPath);
            return;
          }
          response.type("text/html");
          response.send(await renderPptxPreview(entry.absolutePath, entry.name, entry.relativePath, locator));
        }
        return;
      case "jsx":
        response.type("text/html");
        response.send(await renderJsxPreview(entry.absolutePath, entry.name));
        return;
      case "text":
        response.type("text/html");
        response.send(renderTextPreview(await readFile(entry.absolutePath, "utf8"), entry.name));
        return;
      default:
        response.type("text/html");
        response.send(renderUnsupportedPreview(entry));
    }
  }));

  app.get("/api/tasks/:taskId/workspace-files/:entryId/preview-assets", asyncRoute(async (request, response) => {
    const taskId = firstParam(request.params.taskId);
    const entryId = firstParam(request.params.entryId);
    const relativeAssetPath =
      typeof request.query.asset === "string" ? request.query.asset.trim() : "";
    if (!relativeAssetPath) {
      response.status(400).send("Asset path is required.");
      return;
    }

    const taskRunId =
      typeof request.query.taskRunId === "string" ? request.query.taskRunId : undefined;
    const entry = await harness.runtime.resolveWorkspaceFile(
      taskId,
      entryId,
      taskRunId
    );
    const quickLookPreview = await ensureQuickLookHtmlPreview(entry.absolutePath, dataDir, "pptx");
    if (!quickLookPreview) {
      response.status(404).send("Preview assets are not available for this file.");
      return;
    }

    const assetPath = resolve(quickLookPreview.baseDir, relativeAssetPath);
    if (!assetPath.startsWith(quickLookPreview.baseDir)) {
      response.status(403).send("Asset path escapes the preview root.");
      return;
    }
    if (!existsSync(assetPath)) {
      response.status(404).send("Preview asset not found.");
      return;
    }

    response.sendFile(assetPath);
  }));

  app.get("/api/tasks/:taskId/workspace-files/:entryId/asset", asyncRoute(async (request, response) => {
    const taskId = firstParam(request.params.taskId);
    const entryId = firstParam(request.params.entryId);
    const relativeAssetPath =
      typeof request.query.asset === "string" ? request.query.asset.trim() : "";
    if (!relativeAssetPath) {
      response.status(400).send("Asset path is required.");
      return;
    }

    const taskRunId =
      typeof request.query.taskRunId === "string" ? request.query.taskRunId : undefined;
    const entry = await harness.runtime.resolveWorkspaceFile(
      taskId,
      entryId,
      taskRunId
    );
    const assetPath = resolve(dirname(entry.absolutePath), relativeAssetPath);
    if (!assetPath.startsWith(entry.rootPath)) {
      response.status(403).send("Asset path escapes the workspace root.");
      return;
    }
    if (!existsSync(assetPath)) {
      response.status(404).send("Asset not found.");
      return;
    }

    response.sendFile(assetPath);
  }));

  app.post("/api/dialogs/folder", async (request, response) => {
    const prompt =
      typeof request.body?.prompt === "string" && request.body.prompt.trim() !== ""
        ? request.body.prompt.trim()
        : "Choose a folder";

    response.json({
      path: await chooseFolder(prompt)
    });
  });

  if (existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get("*", (request, response, next) => {
      if (request.path.startsWith("/api/")) {
        next();
        return;
      }
      response.sendFile(join(staticDir, "index.html"));
    });
  }

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : "Unknown local server error";
    response.status(500).send(message);
  });

  await server.listen(port);
  process.stdout.write(`Stuart web api listening on http://localhost:${port}\n`);

  return {
    harness,
    server,
    app,
    port,
    dataDir,
    workspaceRoot,
    close: () => server.close()
  };
}

async function main() {
  return startStuartWebServer();
}

async function chooseFolder(prompt: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      `try`,
      "-e",
      `POSIX path of (choose folder with prompt "${escapePrompt(prompt)}")`,
      "-e",
      `on error number -128`,
      "-e",
      `return ""`,
      "-e",
      `end try`
    ]);
    const path = stdout.trim();
    return path === "" ? null : path;
  } catch {
    return null;
  }
}

function escapePrompt(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function asyncRoute(
  handler: (
    request: express.Request,
    response: express.Response,
    next: express.NextFunction
  ) => Promise<void>
) {
  return (request: express.Request, response: express.Response, next: express.NextFunction) => {
    void handler(request, response, next).catch(next);
  };
}

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function resolveWorkspaceRoot(override?: string): string {
  if (override && override.trim() !== "") {
    return resolve(override);
  }

  if (process.env.STUART_WORKSPACE_ROOT) {
    return resolve(process.env.STUART_WORKSPACE_ROOT);
  }

  return resolve(fileURLToPath(new URL("../../../", import.meta.url)));
}

function resolveDataDir(workspaceRoot: string, override?: string): string {
  if (override && override.trim() !== "") {
    return resolve(override);
  }

  if (process.env.STUART_DATA_DIR) {
    const configured = process.env.STUART_DATA_DIR;
    return configured.startsWith("/")
      ? resolve(configured)
      : resolve(workspaceRoot, configured);
  }

  const preferred = join(workspaceRoot, ".stuart-data", "web");
  const legacy = join(workspaceRoot, ".cowork-data", "web");
  return existsSync(preferred) || !existsSync(legacy) ? preferred : legacy;
}

function resolveStaticDir(workspaceRoot: string, override?: string): string {
  if (override && override.trim() !== "") {
    return resolve(override);
  }

  if (process.env.STUART_WEB_STATIC_DIR) {
    return resolve(process.env.STUART_WEB_STATIC_DIR);
  }

  return join(workspaceRoot, "apps", "web", "dist");
}

function resolveVmHelperBinaryPath(workspaceRoot: string, override?: string): string | undefined {
  if (override && override.trim() !== "") {
    return resolve(override);
  }

  if (process.env.STUART_VM_HELPER_BINARY_PATH) {
    return resolve(process.env.STUART_VM_HELPER_BINARY_PATH);
  }

  const preferredHelperCandidate = join(
    workspaceRoot,
    "native",
    "vm-helper",
    ".build",
    "debug",
    "StuartVMHelper"
  );
  const legacyHelperCandidate = join(
    workspaceRoot,
    "native",
    "vm-helper",
    ".build",
    "debug",
    "CoworkVMHelper"
  );

  return existsSync(preferredHelperCandidate)
    ? preferredHelperCandidate
    : existsSync(legacyHelperCandidate)
      ? legacyHelperCandidate
      : undefined;
}

async function defaultOpenExternalPath(absolutePath: string) {
  await execFileAsync("open", [absolutePath]);
}

async function ensureOfficePdfPreview(
  absolutePath: string,
  dataDir: string,
  kind: "pptx" | "docx"
): Promise<string | null> {
  const sofficeBinary = await resolveSofficeBinary();
  if (!sofficeBinary) {
    return null;
  }

  const sourceStat = await stat(absolutePath);
  const cacheKey = createHash("sha1")
    .update(`${kind}:${absolutePath}:${sourceStat.size}:${sourceStat.mtimeMs}`)
    .digest("hex");
  const cacheDir = join(dataDir, "preview-cache", cacheKey);
  const pdfPath = join(cacheDir, `${basename(absolutePath, extname(absolutePath))}.pdf`);
  if (existsSync(pdfPath)) {
    return pdfPath;
  }

  await mkdir(cacheDir, { recursive: true });
  const sofficeProfileDir = join(cacheDir, "soffice-profile");
  await mkdir(sofficeProfileDir, { recursive: true });

  try {
    await execFileAsync(sofficeBinary, [
      `-env:UserInstallation=file://${sofficeProfileDir}`,
      "--invisible",
      "--headless",
      "--norestore",
      "--convert-to",
      "pdf",
      "--outdir",
      cacheDir,
      absolutePath,
    ]);
    return existsSync(pdfPath) ? pdfPath : null;
  } catch {
    return null;
  }
}

async function ensureQuickLookHtmlPreview(
  absolutePath: string,
  dataDir: string,
  kind: "pptx"
): Promise<{ htmlPath: string; baseDir: string } | null> {
  const quickLookBinary = await resolveQuickLookBinary();
  if (!quickLookBinary) {
    return null;
  }

  const sourceStat = await stat(absolutePath);
  const cacheKey = createHash("sha1")
    .update(`quicklook:${kind}:${absolutePath}:${sourceStat.size}:${sourceStat.mtimeMs}`)
    .digest("hex");
  const cacheDir = join(dataDir, "preview-cache", cacheKey, "quicklook");
  const previewDir = join(cacheDir, `${basename(absolutePath)}.qlpreview`);
  const htmlPath = join(previewDir, "Preview.html");
  if (existsSync(htmlPath)) {
    return { htmlPath, baseDir: previewDir };
  }

  await mkdir(cacheDir, { recursive: true });

  try {
    await execFileAsync(quickLookBinary, [
      "-p",
      "-o",
      cacheDir,
      absolutePath,
    ]);
    return existsSync(htmlPath) ? { htmlPath, baseDir: previewDir } : null;
  } catch {
    return null;
  }
}

async function resolveSofficeBinary(): Promise<string | null> {
  const configured = process.env.STUART_SOFFICE_PATH?.trim();
  if (configured) {
    return configured;
  }

  const candidates = [
    "/opt/homebrew/bin/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/usr/local/bin/soffice",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  try {
    await execFileAsync("soffice", ["--version"]);
    return "soffice";
  } catch {
    return null;
  }
}

async function resolveQuickLookBinary(): Promise<string | null> {
  const candidate = "/usr/bin/qlmanage";
  if (existsSync(candidate)) {
    return candidate;
  }

  try {
    await execFileAsync("qlmanage", ["-h"]);
    return "qlmanage";
  } catch {
    return null;
  }
}

async function renderDocxPreview(absolutePath: string, title: string): Promise<string> {
  const result = await mammoth.convertToHtml({ path: absolutePath });
  return buildPreviewDocument(title, result.value, result.messages.map((message) => message.message));
}

function renderWorkbookPreview(absolutePath: string, title: string): string {
  const workbook = XLSX.readFile(absolutePath);
  const sections = workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      return "";
    }
    return `
      <section class="sheet-preview">
        <header>
          <h2>${escapeHtml(sheetName)}</h2>
        </header>
        <div class="sheet-table">${XLSX.utils.sheet_to_html(sheet, { id: `sheet-${escapeHtmlAttribute(sheetName)}` })}</div>
      </section>
    `;
  }).join("\n");
  return buildPreviewDocument(title, sections || "<p>No worksheet content found.</p>");
}

async function renderPptxPreview(
  absolutePath: string,
  title: string,
  relativePath: string,
  locator?: string
): Promise<string> {
  const slides = await extractUploadedPptxPreviewSlides(absolutePath);
  if (slides.length === 0) {
    return buildPreviewDocument(
      title,
      `<div class="unsupported-preview">
        <h2>${escapeHtml(title)}</h2>
        <p>No readable slide text was found in this deck.</p>
        <p><strong>Path:</strong> ${escapeHtml(relativePath)}</p>
      </div>`
    );
  }

  const outline = slides
    .map((slide) => {
      const anchorId = buildLocatorAnchor(`slide ${slide.slideNumber}`, slide.slideNumber - 1);
      return `<a href="#${escapeHtmlAttribute(anchorId)}">${escapeHtml(`slide ${slide.slideNumber}`)}</a>`;
    })
    .join("");
  const sections = slides
    .map((slide, index) => {
      const anchorId = buildLocatorAnchor(`slide ${slide.slideNumber}`, index);
      const heading =
        slide.paragraphs.length > 1 && slide.paragraphs[0]
          ? `<h2>${escapeHtml(slide.paragraphs[0])}</h2>`
          : "";
      const bodyParagraphs =
        slide.paragraphs.length > 1
          ? slide.paragraphs.slice(1)
          : slide.paragraphs;
      const notes =
        slide.notes.length > 0
          ? `<details class="slide-preview-notes"><summary>Presenter notes</summary>${formatPreviewParagraphs(slide.notes)}</details>`
          : "";
      return `
        <section class="slide-preview" id="${escapeHtmlAttribute(anchorId)}">
          <header class="slide-preview-header">
            <span class="slide-preview-badge">${escapeHtml(`slide ${slide.slideNumber}`)}</span>
            ${heading}
          </header>
          <div class="slide-preview-body">
            ${formatPreviewParagraphs(bodyParagraphs)}
          </div>
          ${notes}
        </section>
      `;
    })
    .join("\n");

  return enhanceBasicSlidePreviewHtml(buildPreviewDocument(title, `
    <nav class="slide-outline">${outline}</nav>
    ${sections}
  `), locator);
}

function renderTextPreview(content: string, title: string): string {
  return buildPreviewDocument(title, `<pre>${escapeHtml(content)}</pre>`);
}

function renderUnsupportedPreview(entry: WorkspaceFileRecord): string {
  return buildPreviewDocument(
    entry.name,
    `<div class="unsupported-preview">
      <h2>${escapeHtml(entry.name)}</h2>
      <p>This file type does not have an inline preview yet.</p>
      <p><strong>Type:</strong> ${escapeHtml(entry.previewKind)}</p>
      <p><strong>Path:</strong> ${escapeHtml(entry.relativePath)}</p>
    </div>`
  );
}

function rewriteHtmlAssets(
  html: string,
  taskId: string,
  entryId: string,
  taskRunId?: string
): string {
  return html.replace(
    /\b(src|href)=["']([^"']+)["']/gi,
    (_match, attribute: string, value: string) => {
      if (!isLocalAssetReference(value)) {
        return `${attribute}="${value}"`;
      }

      const search = new URLSearchParams({ asset: value });
      if (taskRunId) {
        search.set("taskRunId", taskRunId);
      }

      return `${attribute}="/api/tasks/${taskId}/workspace-files/${entryId}/asset?${search.toString()}"`;
    }
  );
}

function rewriteGeneratedPreviewAssets(
  html: string,
  taskId: string,
  entryId: string,
  taskRunId?: string
): string {
  return html.replace(
    /\b(src|href)=["']([^"']+)["']/gi,
    (_match, attribute: string, value: string) => {
      if (!isLocalAssetReference(value)) {
        return `${attribute}="${value}"`;
      }

      const search = new URLSearchParams({ asset: value });
      if (taskRunId) {
        search.set("taskRunId", taskRunId);
      }

      return `${attribute}="/api/tasks/${taskId}/workspace-files/${entryId}/preview-assets?${search.toString()}"`;
    }
  );
}

function enhanceQuickLookPptxPreviewHtml(html: string, locator?: string): string {
  const targetSlideNumber = parseSlideLocator(locator);
  const style = `
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0 !important;
        padding: 18px 14px 28px !important;
        background: linear-gradient(180deg, #eef4fb 0%, #e7eef8 100%) !important;
        overflow-x: hidden !important;
      }
      .stuart-ql-slide-frame {
        position: relative;
        width: min(100%, 1180px);
        margin: 0 auto 20px;
        padding: 16px;
        border-radius: 20px;
        border: 1px solid rgba(108,130,168,0.16);
        background: rgba(255,255,255,0.82);
        box-shadow: 0 20px 48px rgba(18,31,56,0.08);
        overflow: hidden;
        box-sizing: border-box;
        scroll-margin-top: 20px;
      }
      .stuart-ql-slide-frame.is-target {
        border-color: rgba(31,93,93,0.42);
        box-shadow: 0 0 0 3px rgba(31,93,93,0.12), 0 20px 48px rgba(18,31,56,0.08);
      }
      .stuart-ql-slide-label {
        position: absolute;
        top: 12px;
        right: 14px;
        z-index: 3;
        padding: 5px 10px;
        border-radius: 999px;
        background: rgba(31,93,93,0.09);
        color: #1f5d5d;
        font: 700 12px/1 system-ui, sans-serif;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .stuart-ql-slide-frame > .slide {
        margin: 0 !important;
        box-shadow: none !important;
      }
    </style>
  `;
  const script = `
    <script>
      (() => {
        const targetSlideNumber = ${targetSlideNumber ?? "null"};

        function wrapSlides() {
          const slides = Array.from(document.querySelectorAll("div.slide"));
          for (const [index, slideNode] of slides.entries()) {
            const slide = slideNode;
            if (!(slide instanceof HTMLElement)) continue;
            if (slide.parentElement?.classList.contains("stuart-ql-slide-frame")) continue;

            const slideNumber = index + 1;
            slide.id = slide.id || "slide-" + slideNumber;
            slide.style.position = "absolute";
            slide.style.top = "44px";
            slide.style.left = "16px";
            slide.style.transformOrigin = "top left";
            slide.style.margin = "0";

            const frame = document.createElement("section");
            frame.className = "stuart-ql-slide-frame";
            frame.dataset.slideNumber = String(slideNumber);
            if (slideNumber === targetSlideNumber) {
              frame.classList.add("is-target");
            }

            const label = document.createElement("div");
            label.className = "stuart-ql-slide-label";
            label.textContent = "slide " + slideNumber;

            slide.parentNode?.insertBefore(frame, slide);
            frame.appendChild(label);
            frame.appendChild(slide);
          }
        }

        function fitSlides() {
          const frames = Array.from(document.querySelectorAll(".stuart-ql-slide-frame"));
          for (const frameNode of frames) {
            const frame = frameNode;
            if (!(frame instanceof HTMLElement)) continue;
            const slide = frame.querySelector(".slide");
            if (!(slide instanceof HTMLElement)) continue;

            const computedStyle = window.getComputedStyle(slide);
            const baseWidth = parseFloat(computedStyle.width) || slide.scrollWidth || 960;
            const baseHeight = parseFloat(computedStyle.height) || slide.scrollHeight || 540;
            const availableWidth = Math.max(320, frame.clientWidth - 32);
            const scale = Math.min(1, availableWidth / baseWidth);

            slide.style.transform = "scale(" + scale + ")";
            frame.style.minHeight = Math.ceil(baseHeight * scale + 60) + "px";
          }
        }

        function scrollToTargetSlide() {
          if (!targetSlideNumber) return;
          const selector = '.stuart-ql-slide-frame[data-slide-number="' + targetSlideNumber + '"]';
          const target = document.querySelector(selector);
          if (target instanceof HTMLElement) {
            target.scrollIntoView({ block: "start" });
          }
        }

        function boot() {
          wrapSlides();
          fitSlides();
          scrollToTargetSlide();
        }

        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", boot, { once: true });
        } else {
          boot();
        }

        window.addEventListener("resize", fitSlides);
      })();
    </script>
  `;

  return injectBeforeTag(injectBeforeTag(html, "</head>", style), "</body>", script);
}

function enhanceBasicSlidePreviewHtml(html: string, locator?: string): string {
  const slideNumber = parseSlideLocator(locator);
  if (!slideNumber) {
    return html;
  }

  const script = `
    <script>
      (() => {
        const target = document.getElementById("slide-${slideNumber}");
        if (target instanceof HTMLElement) {
          window.requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
        }
      })();
    </script>
  `;

  return injectBeforeTag(html, "</body>", script);
}

function isLocalAssetReference(value: string): boolean {
  const normalized = value.trim();
  return !(
    normalized.startsWith("#") ||
    normalized.startsWith("data:") ||
    normalized.startsWith("javascript:") ||
    normalized.startsWith("mailto:") ||
    normalized.startsWith("tel:") ||
    /^[a-z]+:/i.test(normalized)
  );
}

async function renderJsxPreview(absolutePath: string, title: string): Promise<string> {
  const source = await readFile(absolutePath, "utf8");
  const shouldWrap = !/createRoot\s*\(|ReactDOM\.render\s*\(/.test(source);
  const virtualEntry = "__stuart_preview_entry__";
  try {
  const bundle = await buildBundle({
    absWorkingDir: dirname(absolutePath),
    nodePaths: [
      join(previewWorkspaceRoot, "node_modules"),
      join(previewWorkspaceRoot, "apps", "web", "node_modules")
    ],
    entryPoints: shouldWrap ? [virtualEntry] : [absolutePath],
    outdir: "stuart-preview",
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    target: ["es2020"],
    loader: {
      ".js": "jsx",
      ".jsx": "jsx",
      ".ts": "ts",
      ".tsx": "tsx",
      ".css": "css",
      ".svg": "dataurl",
      ".png": "dataurl",
      ".jpg": "dataurl",
      ".jpeg": "dataurl",
      ".gif": "dataurl",
      ".webp": "dataurl"
    },
    plugins: shouldWrap
      ? [
          {
            name: "stuart-react-alias",
            setup(build) {
              build.onResolve({ filter: /^react$/ }, () => ({ path: reactEntry }));
              build.onResolve({ filter: /^react-dom\/client$/ }, () => ({
                path: reactDomClientEntry
              }));
              build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({
                path: reactJsxRuntimeEntry
              }));
            }
          },
          {
            name: "stuart-preview-entry",
            setup(build) {
              build.onResolve({ filter: /^__stuart_preview_entry__$/ }, () => ({
                path: virtualEntry,
                namespace: "stuart-preview"
              }));
              build.onLoad({ filter: /.*/, namespace: "stuart-preview" }, () => ({
                contents: `
                  import React from "react";
                  import ReactDOM from "react-dom/client";
                  import PreviewDefault, * as PreviewNamespace from ${JSON.stringify(`./${basename(absolutePath)}`)};

                  const Component =
                    PreviewDefault ??
                    PreviewNamespace.default ??
                    PreviewNamespace.App ??
                    PreviewNamespace.Preview;

                  const root = document.getElementById("root");
                  if (!Component) {
                    root.innerHTML = "<pre>No default export, App export, or Preview export was found.</pre>";
                  } else {
                    ReactDOM.createRoot(root).render(React.createElement(Component));
                  }
                `,
                loader: "tsx",
                resolveDir: dirname(absolutePath)
              }));
            }
          }
        ]
      : [],
    define: {
      "process.env.NODE_ENV": "\"development\""
    }
  });

  const script =
    bundle.outputFiles.find((file) => file.path.endsWith(".js"))?.text ??
    bundle.outputFiles.find((file) => !file.path.endsWith(".css"))?.text ??
    "";
  const css = bundle.outputFiles
    .filter((file) => file.path.endsWith(".css"))
    .map((file) => file.text)
    .join("\n");

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${escapeHtml(title)}</title>
      <style>
        html, body, #root { margin: 0; min-height: 100%; }
        body { font-family: system-ui, sans-serif; background: #f5f7fb; color: #162032; }
        #root { min-height: 100vh; }
        ${css}
      </style>
    </head>
    <body>
      <div id="root"></div>
      <script>${script}</script>
    </body>
  </html>`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return buildPreviewDocument(
      title,
      `<pre>${escapeHtml(source)}</pre>`,
      [
        `Could not bundle this JSX preview (${escapeHtml(detail)}). Showing raw source. Interactive preview needs the esbuild native binary for your platform (included with the desktop app after pnpm install).`,
      ],
    );
  }
}

function buildPreviewDocument(title: string, content: string, notices: string[] = []): string {
  const noticeMarkup =
    notices.length === 0
      ? ""
      : `<div class="preview-notices">${notices
          .map((notice) => `<p>${escapeHtml(notice)}</p>`)
          .join("")}</div>`;

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${escapeHtml(title)}</title>
      <style>
        :root { color-scheme: light; font-family: Inter, system-ui, sans-serif; }
        body { margin: 0; background: #eef3fb; color: #162032; }
        .preview-shell { max-width: 1100px; margin: 0 auto; padding: 24px; }
        .preview-card { background: rgba(255,255,255,0.88); border: 1px solid rgba(108,130,168,0.18); border-radius: 24px; padding: 24px; box-shadow: 0 16px 48px rgba(18,31,56,0.08); }
        .preview-card h1 { margin: 0 0 16px; font-size: 32px; }
        .preview-notices { display: grid; gap: 8px; margin-bottom: 16px; }
        .preview-notices p { margin: 0; padding: 10px 12px; border-radius: 14px; background: #fff6e8; color: #6a4b17; }
        .sheet-preview { margin-top: 20px; }
        .sheet-preview h2 { margin: 0 0 12px; font-size: 22px; }
        .sheet-table { overflow: auto; border-radius: 16px; border: 1px solid rgba(108,130,168,0.12); background: white; }
        .slide-outline { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
        .slide-outline a { color: #1f5d5d; text-decoration: none; font-size: 13px; font-weight: 600; padding: 6px 10px; border-radius: 999px; background: rgba(31,93,93,0.08); }
        .slide-outline a:hover { background: rgba(31,93,93,0.14); }
        .slide-preview { margin-top: 18px; padding: 18px; border-radius: 18px; border: 1px solid rgba(108,130,168,0.14); background: rgba(255,255,255,0.92); scroll-margin-top: 20px; }
        .slide-preview-header { display: grid; gap: 10px; margin-bottom: 14px; }
        .slide-preview-header h2 { margin: 0; font-size: 24px; line-height: 1.25; color: #162032; }
        .slide-preview-badge { display: inline-block; padding: 4px 10px; border-radius: 999px; background: rgba(31,93,93,0.08); color: #1f5d5d; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
        .slide-preview-body { display: grid; gap: 12px; }
        .slide-preview-body p { margin: 0; line-height: 1.7; }
        .slide-preview-notes { margin-top: 14px; border-top: 1px solid rgba(108,130,168,0.12); padding-top: 14px; color: #44536b; }
        .slide-preview-notes summary { cursor: pointer; font-weight: 600; color: #1f5d5d; }
        .slide-preview-notes p { margin: 10px 0 0; line-height: 1.65; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid rgba(108,130,168,0.12); padding: 8px 10px; text-align: left; }
        pre { white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, monospace; background: #162032; color: #eff5ff; padding: 18px; border-radius: 16px; }
      </style>
    </head>
    <body>
      <main class="preview-shell">
        <section class="preview-card">
          <h1>${escapeHtml(title)}</h1>
          ${noticeMarkup}
          ${content}
        </section>
      </main>
    </body>
  </html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/\s+/g, "-").toLowerCase();
}

function formatPreviewParagraphs(paragraphs: string[]): string {
  return paragraphs
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("\n");
}

function buildLocatorAnchor(locator: string | undefined, index: number): string {
  const slideMatch = locator?.match(/^slide\s+(\d+)$/i);
  if (slideMatch) {
    return `slide-${slideMatch[1]}`;
  }
  return locator ? escapeHtmlAttribute(locator) : `chunk-${index + 1}`;
}

function parseSlideLocator(locator?: string): number | null {
  const match = locator?.match(/\bslide\s+(\d+)\b/i);
  if (!match) {
    return null;
  }
  const slideNumber = Number(match[1]);
  return Number.isFinite(slideNumber) && slideNumber > 0 ? slideNumber : null;
}

function injectBeforeTag(html: string, tag: string, content: string): string {
  return html.includes(tag) ? html.replace(tag, `${content}\n${tag}`) : `${html}\n${content}`;
}

// Only auto-start when running as a standalone server (not imported by the desktop app).
if (process.env.STUART_RUNTIME_MODE !== "desktop") {
  let runningServer: RunningStuartWebServer | null = null;

  async function shutdown() {
    process.stdout.write("\n[stuart] shutting down...\n");
    try { await runningServer?.close(); } catch { /* best effort */ }
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("beforeExit", () => void shutdown());

  void main().then((server) => {
    runningServer = server ?? null;
  });
}
