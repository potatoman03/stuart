import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const targets = [
  { port: 5173, label: "web client" },
  { port: 8787, label: "local api" }
];

async function main() {
  for (const target of targets) {
    const pids = findListeningPids(target.port);
    if (!pids.length) {
      continue;
    }

    for (const pid of pids) {
      const command = readCommand(pid);
      const cwd = readCwd(pid);
      const belongsToWorkspace =
        command.includes(workspaceRoot) ||
        cwd.startsWith(workspaceRoot) ||
        command.includes("@stuart/web") ||
        command.includes("tsx src/server/index.ts") ||
        command.includes("vite");

      if (!belongsToWorkspace) {
        process.stderr.write(
          `Port ${target.port} is in use by PID ${pid}, which does not look like this workspace.\n`
        );
        process.stderr.write(`Command: ${command || "<unknown>"}\n`);
        process.exit(1);
      }

      process.stdout.write(
        `Reclaiming port ${target.port} from stale ${target.label} process ${pid}.\n`
      );
      killProcessGroup(pid);
    }

    await waitForPortToClear(target.port);
  }
}

function findListeningPids(port) {
  try {
    const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8"
    }).trim();
    return output === ""
      ? []
      : [...new Set(output.split("\n").map((line) => Number(line.trim())).filter(Boolean))];
  } catch {
    return [];
  }
}

function readCommand(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8"
    }).trim();
  } catch {
    return "";
  }
}

function readCwd(pid) {
  try {
    const output = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8"
    });
    const line = output
      .split("\n")
      .find((entry) => entry.startsWith("n"));
    return line ? line.slice(1).trim() : "";
  } catch {
    return "";
  }
}

function readProcessGroupId(pid) {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "pgid="], {
      encoding: "utf8"
    }).trim();
    const pgid = Number(output);
    return Number.isFinite(pgid) && pgid > 0 ? pgid : null;
  } catch {
    return null;
  }
}

function killProcessGroup(pid) {
  const pgid = readProcessGroupId(pid);
  if (pgid) {
    try {
      process.kill(-pgid, "SIGTERM");
      return;
    } catch {
      // Fall through to killing the individual process.
    }
  }

  process.kill(pid, "SIGTERM");
}

async function waitForPortToClear(port) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (findListeningPids(port).length === 0) {
      return;
    }
    await delay(150);
  }

  process.stderr.write(`Port ${port} did not clear after sending SIGTERM.\n`);
  process.exit(1);
}

void main();
