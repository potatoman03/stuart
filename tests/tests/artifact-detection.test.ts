import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverReferencedInteractiveHtmlFiles,
  discoverInteractiveHtmlFiles,
  tryParseArtifactJson,
} from "@stuart/runtime-supervisor";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("interactive artifact detection", () => {
  it("resolves relative interactive artifact paths against the staged workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stuart-artifact-path-"));
    cleanupPaths.push(directory);
    const htmlPath = join(directory, "bfs-dfs-visualiser.html");
    await writeFile(
      htmlPath,
      "<!doctype html><html><head><title>BFS DFS Visualiser</title></head><body><script>console.log('ok')</script></body></html>",
      "utf8"
    );

    const parsed = tryParseArtifactJson(
      JSON.stringify({
        kind: "interactive",
        title: "BFS DFS Visualiser",
        path: "bfs-dfs-visualiser.html",
      }),
      directory
    );

    expect(parsed?.kind).toBe("interactive");
    expect((parsed?.data as { html?: string })?.html).toContain("<script>");
    expect((parsed?.data as { sourcePath?: string })?.sourcePath).toBe("bfs-dfs-visualiser.html");
  });

  it("discovers interactive html files recursively inside staged subfolders", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stuart-artifact-scan-"));
    cleanupPaths.push(directory);
    const nested = join(directory, "attachments", "source-copy");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(nested, "bfs-dfs-visualiser.html"),
      "<!doctype html><html><head><title>BFS DFS Visualiser</title></head><body><button onclick=\"void 0\">Run</button><script>console.log('ok')</script></body></html>",
      "utf8"
    );

    const discovered = discoverInteractiveHtmlFiles(directory, new Date(Date.now() - 5_000));

    expect(discovered.map((item) => item.relativePath)).toContain(
      "attachments/source-copy/bfs-dfs-visualiser.html"
    );
  });

  it("discovers referenced interactive html files from assistant prose", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stuart-artifact-reference-"));
    cleanupPaths.push(directory);
    await writeFile(
      join(directory, "bfs-dfs-visualiser.html"),
      "<!doctype html><html><head><title>BFS DFS Visualiser</title></head><body><button onclick=\"void 0\">Run</button><script>console.log('ok')</script></body></html>",
      "utf8"
    );

    const discovered = discoverReferencedInteractiveHtmlFiles(
      directory,
      "I added a dedicated BFS/DFS visualiser here: [bfs-dfs-visualiser.html](bfs-dfs-visualiser.html)."
    );

    expect(discovered.map((item) => item.relativePath)).toContain("bfs-dfs-visualiser.html");
  });

  it("normalizes interactive-web-preview payloads that use entry instead of path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stuart-artifact-entry-"));
    cleanupPaths.push(directory);
    const htmlPath = join(directory, "tower-of-hanoi-visualization.html");
    await writeFile(
      htmlPath,
      "<!doctype html><html><head><title>Tower of Hanoi Explorer</title></head><body><script>console.log('ok')</script></body></html>",
      "utf8"
    );

    const parsed = tryParseArtifactJson(
      JSON.stringify({
        kind: "interactive-web-preview",
        title: "Tower of Hanoi Explorer",
        entry: "tower-of-hanoi-visualization.html",
      }),
      directory
    );

    expect(parsed?.kind).toBe("interactive");
    expect((parsed?.data as { html?: string })?.html).toContain("<script>");
    expect((parsed?.data as { path?: string })?.path).toBe("tower-of-hanoi-visualization.html");
  });
});
