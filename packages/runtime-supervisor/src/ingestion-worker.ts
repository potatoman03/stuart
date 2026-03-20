import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

type WorkerInput = {
  filePath: string;
};

async function loadParser() {
  const jsUrl = new URL("./ingestion.js", import.meta.url);
  const moduleUrl = existsSync(fileURLToPath(jsUrl))
    ? jsUrl
    : new URL("./ingestion.ts", import.meta.url);
  return import(moduleUrl.href);
}

async function main() {
  const { filePath } = workerData as WorkerInput;
  const { parseDocumentForIngestion } = await loadParser();
  const parsed = await parseDocumentForIngestion(filePath);
  parentPort?.postMessage({
    ok: true,
    parsed,
  });
}

void main().catch((error) => {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
});
