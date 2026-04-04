import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Executable used for Cursor Agent CLI (bundled in desktop extraResources, or official `agent` install).
 */
export function resolveCursorAgentBinPath(): string {
  const explicit = process.env.STUART_CURSOR_AGENT_BIN?.trim();
  if (explicit) {
    return explicit;
  }
  const bundled = process.env.STUART_BUNDLED_CURSOR_AGENT_BIN?.trim();
  if (bundled && existsSync(bundled)) {
    return bundled;
  }
  const local = join(homedir(), ".local", "bin", "agent");
  if (existsSync(local)) {
    return local;
  }
  return "agent";
}

/**
 * Working directory for spawning the CLI so Node can resolve sibling chunks (.index.js, .node).
 */
export function resolveCursorAgentPackageCwd(binPath: string): string {
  const root = process.env.STUART_BUNDLED_CURSOR_AGENT_ROOT?.trim();
  if (root && existsSync(root)) {
    return root;
  }
  return dirname(binPath);
}
