import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { StuartHarness, StuartHarnessServer } from "./index.js";

const dataDir = resolveDataDir();
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST;
const vmHelperBinaryPath =
  process.env.STUART_VM_HELPER_BINARY_PATH ?? process.env.COWORK_VM_HELPER_BINARY_PATH;

async function main(): Promise<void> {
  const harness = new StuartHarness({
    dataDir,
    vmHelperBinaryPath
  });
  const server = new StuartHarnessServer({ harness });

  await server.listen(port, host);
  process.stdout.write(
    `Stuart harness listening on http://${host ?? "localhost"}:${port} using ${dataDir}\n`
  );
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

function resolveDataDir(): string {
  if (process.env.STUART_DATA_DIR) {
    return process.env.STUART_DATA_DIR;
  }
  if (process.env.COWORK_DATA_DIR) {
    return process.env.COWORK_DATA_DIR;
  }

  const preferred = resolve(".stuart-data/harness");
  const legacy = resolve(".cowork-data/harness");
  return existsSync(preferred) || !existsSync(legacy) ? preferred : legacy;
}
