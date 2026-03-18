import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectSystemDiagnostics,
  ensureLocalEnvFile
} from "../packages/runtime-supervisor/src/diagnostics.js";
import { hasRequiredFailures, printQuickPreflight, spawnPnpmScript } from "./lib/onboarding.js";

async function main() {
  const mode = process.argv[2] ?? "web";
  const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

  const envResult = await ensureLocalEnvFile(workspaceRoot);
  if (envResult.created) {
    process.stdout.write(`Created ${envResult.path} from ${envResult.sourcePath}.\n`);
  }

  const diagnostics = await collectSystemDiagnostics({
    workspaceRoot,
    envFilePath: join(workspaceRoot, ".env"),
    dataDir: process.env.STUART_DATA_DIR
      ? resolve(workspaceRoot, process.env.STUART_DATA_DIR)
      : join(workspaceRoot, ".stuart-data"),
    codexBinaryPath: process.env.CODEX_BINARY_PATH,
    vmHelperBinaryPath: process.env.STUART_VM_HELPER_BINARY_PATH,
  });

  printQuickPreflight(diagnostics);
  if (hasRequiredFailures(diagnostics)) {
    process.exitCode = 1;
    return;
  }

  const scriptName =
    mode === "desktop"
      ? "_dev:desktop"
      : mode === "harness"
        ? "_dev:harness"
        : "_dev:web";

  const exitCode = await spawnPnpmScript(scriptName);
  process.exitCode = exitCode;
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
