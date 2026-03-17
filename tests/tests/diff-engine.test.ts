import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StuartRuntime } from "@stuart/runtime-supervisor";

const createdPaths: string[] = [];

async function createTempDir(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("StuartRuntime diff preview", () => {
  it("detects creates, modifies, and moves inside a staged attachment", async () => {
    const hostRoot = await createTempDir("stuart-host-");
    const dataDir = await createTempDir("stuart-data-");
    await mkdir(join(hostRoot, "editable"), { recursive: true });
    await writeFile(join(hostRoot, "editable", "keep.txt"), "original", "utf8");
    await writeFile(join(hostRoot, "editable", "rename-me.txt"), "move me", "utf8");

    const runtime = new StuartRuntime({ dataDir });
    await runtime.bootstrap();
    const project = runtime.createProject({ name: "Test", rootPath: hostRoot });
    const task = runtime.createTask({
      projectId: project.id,
      title: "Organize files",
      objective: "Prepare a file organization plan.",
      attachments: [
        {
          id: "editable-root",
          hostPath: join(hostRoot, "editable"),
          mode: "editable"
        }
      ]
    });

    const run = await runtime.prepareTaskRun(task.id);
    await writeFile(join(run.stagingPath, "attachments", "editable-root-editable", "keep.txt"), "changed", "utf8");
    await rename(
      join(run.stagingPath, "attachments", "editable-root-editable", "rename-me.txt"),
      join(run.stagingPath, "attachments", "editable-root-editable", "renamed.txt")
    );
    await writeFile(join(run.stagingPath, "attachments", "editable-root-editable", "new.txt"), "brand new", "utf8");

    const preview = await runtime.previewTaskDiff(run.id);
    const kinds = preview.operations.map((operation) => operation.kind);

    expect(kinds).toContain("modify");
    expect(kinds).toContain("move");
    expect(kinds).toContain("create");
  });

  it("marks modified paths as stale when the host changes after staging", async () => {
    const hostRoot = await createTempDir("stuart-host-stale-");
    const dataDir = await createTempDir("stuart-data-stale-");
    await mkdir(join(hostRoot, "editable"), { recursive: true });
    await writeFile(join(hostRoot, "editable", "draft.txt"), "host-v1", "utf8");

    const runtime = new StuartRuntime({ dataDir });
    await runtime.bootstrap();
    const project = runtime.createProject({ name: "Stale", rootPath: hostRoot });
    const task = runtime.createTask({
      projectId: project.id,
      title: "Edit draft",
      objective: "Edit a staged file.",
      attachments: [
        {
          id: "editable-root",
          hostPath: join(hostRoot, "editable"),
          mode: "editable"
        }
      ]
    });

    const run = await runtime.prepareTaskRun(task.id);
    await writeFile(join(hostRoot, "editable", "draft.txt"), "host-v2", "utf8");
    await writeFile(
      join(run.stagingPath, "attachments", "editable-root-editable", "draft.txt"),
      "guest-v2",
      "utf8"
    );

    const preview = await runtime.previewTaskDiff(run.id);
    expect(preview.operations).toHaveLength(1);
    expect(preview.operations[0]?.kind).toBe("modify");
    expect(preview.operations[0]?.stale).toBe(true);
  });
});

