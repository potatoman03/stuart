import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.STUART_SKIP_VM_HELPER === "1") {
  process.exit(0);
}

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const helperDir = join(workspaceRoot, "native", "vm-helper");
const preferredHelperBinary = join(helperDir, ".build", "debug", "StuartVMHelper");
const legacyHelperBinary = join(helperDir, ".build", "debug", "CoworkVMHelper");

if (existsSync(preferredHelperBinary) || existsSync(legacyHelperBinary)) {
  process.exit(0);
}

process.stdout.write("Building native VM helper for local Stuart startup.\n");
execFileSync("swift", ["build"], {
  cwd: helperDir,
  stdio: "inherit"
});
