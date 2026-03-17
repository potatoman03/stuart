import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { StuartRuntime } from "../packages/runtime-supervisor/dist/index.js";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataDir = join(workspaceRoot, ".stuart-data", "web");
const helperCandidate = join(
  workspaceRoot,
  "native",
  "vm-helper",
  ".build",
  "debug",
  "StuartVMHelper"
);

async function main() {
  const runtime = new StuartRuntime({
    dataDir,
    vmHelperBinaryPath: existsSync(helperCandidate) ? helperCandidate : undefined
  });

  try {
    const result = await runtime.cleanupDemoData();
    process.stdout.write(
      `Removed ${result.removedTaskCount} demo task${result.removedTaskCount === 1 ? "" : "s"}, ` +
        `${result.removedProjectCount} smoke project${result.removedProjectCount === 1 ? "" : "s"}, ` +
        `and ${result.dedupedProjectCount} duplicate project${result.dedupedProjectCount === 1 ? "" : "s"}.\n`
    );
  } finally {
    await runtime.close();
  }
}

void main();
