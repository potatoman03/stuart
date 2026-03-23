import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { StuartHarness, createStuartHarnessApp } from "../../packages/harness/src/index";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("document preview route", () => {
  it("serves a rendered HTML preview for document artifacts instead of raw JSON", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "stuart-preview-route-"));
    cleanupPaths.push(dataDir);

    const harness = new StuartHarness({ dataDir });
    const project = harness.runtime.createProject({
      name: "Preview Test",
      rootPath: dataDir,
    });
    const task = harness.runtime.createTask({
      projectId: project.id,
      title: "Preview Task",
      objective: "Verify document previews render through the API.",
      attachments: [],
    });
    const artifact = harness.runtime.db.createStudyArtifact({
      taskId: task.id,
      kind: "document_xlsx",
      title: "Workbook Preview",
      payload: JSON.stringify({
        kind: "document_xlsx",
        title: "Workbook Preview",
        workbook: {
          sheets: [
            {
              name: "Overview",
              columns: [
                { header: "Topic", width: 24 },
                { header: "Confidence", width: 16 },
              ],
              frozenRows: 1,
              autoFilter: true,
              rows: [
                ["Search", 92],
                ["Regression", 81],
              ],
            },
          ],
          sourceNotes: ["Lecture 1.pdf p.2"],
        },
      }),
      payloadVersion: 2,
      renderStatus: "pending",
      previewStatus: "pending",
    });

    const app = createStuartHarnessApp({ harness });
    const server = await new Promise<import("node:http").Server>((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Server failed to bind to an ephemeral port.");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/api/study-artifacts/${artifact.id}/preview`);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(body).toContain("<table>");
      expect(body).toContain("Auto filter enabled");
      expect(body).not.toContain(`"kind":"document_xlsx"`);
      expect(harness.runtime.db.getStudyArtifact(artifact.id)?.previewPath).toContain(".preview.html");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await harness.close();
    }
  });
});
