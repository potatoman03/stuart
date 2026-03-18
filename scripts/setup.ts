import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectSystemDiagnostics,
  ensureLocalEnvFile
} from "../packages/runtime-supervisor/src/diagnostics.js";
import { printDiagnosticsReport, hasRequiredFailures } from "./lib/onboarding.js";

async function main() {
  const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const envResult = await ensureLocalEnvFile(workspaceRoot);

  if (envResult.created) {
    process.stdout.write(
      `Created ${envResult.path} from ${envResult.sourcePath}. Update it if you need custom ports or paths.\n`
    );
  } else {
    process.stdout.write(`Using ${envResult.path}.\n`);
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

  printDiagnosticsReport(diagnostics);

  if (hasRequiredFailures(diagnostics)) {
    process.stderr.write("\nSetup is incomplete. Fix the required issues above, then rerun `pnpm bootstrap`.\n");
    process.exitCode = 1;
    return;
  }

  process.stdout.write("\nSetup looks good. Start Stuart with `pnpm dev` or `pnpm dev:desktop`.\n");
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
