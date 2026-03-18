import cors from "cors";
import express from "express";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { build as buildBundle } from "esbuild";
import mammoth from "mammoth";
import {
  StuartHarness,
  StuartHarnessServer
} from "@stuart/harness";
import type { WorkspaceFileRecord } from "@stuart/shared";
import XLSX from "xlsx";

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const require = createRequire(import.meta.url);
const dataDir = resolveDataDir();
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
const helperCandidate = existsSync(preferredHelperCandidate)
  ? preferredHelperCandidate
  : existsSync(legacyHelperCandidate)
    ? legacyHelperCandidate
    : undefined;
const staticDir = join(workspaceRoot, "apps", "web", "dist");
const reactEntry = require.resolve("react");
const reactDomClientEntry = require.resolve("react-dom/client");
const reactJsxRuntimeEntry = require.resolve("react/jsx-runtime");

const harness = new StuartHarness({
  dataDir,
  vmHelperBinaryPath: helperCandidate,
  workspaceRoot
});

const server = new StuartHarnessServer({
  harness,
  openExternalPath: async (absolutePath) => {
    await execFileAsync("open", [absolutePath]);
  }
});
const app = server.app;
const port = Number(process.env.PORT ?? 8787);

app.use(cors());

app.get("/api/tasks/:taskId/workspace-files/:entryId/preview", asyncRoute(async (request, response) => {
  const taskId = firstParam(request.params.taskId);
  const entryId = firstParam(request.params.entryId);
  const taskRunId =
    typeof request.query.taskRunId === "string" ? request.query.taskRunId : undefined;
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

async function main() {
  await server.listen(port);
  process.stdout.write(`Stuart web api listening on http://localhost:${port}\n`);
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

function resolveDataDir(): string {
  const preferred = join(workspaceRoot, ".stuart-data", "web");
  const legacy = join(workspaceRoot, ".cowork-data", "web");
  return existsSync(preferred) || !existsSync(legacy) ? preferred : legacy;
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
  const bundle = await buildBundle({
    absWorkingDir: dirname(absolutePath),
    nodePaths: [join(workspaceRoot, "node_modules"), join(workspaceRoot, "apps", "web", "node_modules")],
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

// Ensure child processes (codex app-server, sandbox) are cleaned up on exit
async function shutdown() {
  process.stdout.write("\n[stuart] shutting down...\n");
  try { await server.close(); } catch { /* best effort */ }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("beforeExit", () => void shutdown());

void main();
