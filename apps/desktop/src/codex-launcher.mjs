#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const target = resolveTarget();
const binaryPath = resolveCodexBinary(target);
const extraPathDir = path.join(path.dirname(path.dirname(binaryPath)), "path");
const resolvedExtraPathDir = resolveMaybeUnpacked(extraPathDir);

const pathSep = process.platform === "win32" ? ";" : ":";
const existingPath = process.env.PATH || "";
const env = {
  ...process.env,
  PATH: [resolvedExtraPathDir, ...existingPath.split(pathSep).filter(Boolean)].join(pathSep),
  CODEX_MANAGED_BY_NPM: "1",
};

const child = spawn(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
  env,
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

["SIGINT", "SIGTERM", "SIGHUP"].forEach((signal) => {
  process.on(signal, () => {
    if (!child.killed) {
      try {
        child.kill(signal);
      } catch {
        // Ignore signal forwarding failures during shutdown.
      }
    }
  });
});

const childResult = await new Promise((resolve) => {
  child.on("exit", (code, signal) => {
    if (signal) {
      resolve({ type: "signal", signal });
      return;
    }
    resolve({ type: "code", exitCode: code ?? 1 });
  });
});

if (childResult.type === "signal") {
  process.kill(process.pid, childResult.signal);
} else {
  process.exit(childResult.exitCode);
}

function resolveTarget() {
  const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
  if (process.platform === "darwin" && process.arch === "arm64") {
    return {
      binaryName,
      targetTriple: "aarch64-apple-darwin",
      platformSuffix: "-darwin-arm64",
      packageName: "@stuart/codex-runtime-darwin-arm64",
    };
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return {
      binaryName,
      targetTriple: "x86_64-apple-darwin",
      platformSuffix: "-darwin-x64",
      packageName: "@stuart/codex-runtime-darwin-x64",
    };
  }
  if ((process.platform === "linux" || process.platform === "android") && process.arch === "arm64") {
    return {
      binaryName,
      targetTriple: "aarch64-unknown-linux-musl",
      platformSuffix: "-linux-arm64",
      packageName: "@stuart/codex-runtime-linux-arm64",
    };
  }
  if ((process.platform === "linux" || process.platform === "android") && process.arch === "x64") {
    return {
      binaryName,
      targetTriple: "x86_64-unknown-linux-musl",
      platformSuffix: "-linux-x64",
      packageName: "@stuart/codex-runtime-linux-x64",
    };
  }
  if (process.platform === "win32" && process.arch === "arm64") {
    return {
      binaryName,
      targetTriple: "aarch64-pc-windows-msvc",
      platformSuffix: "-win32-arm64",
      packageName: "@stuart/codex-runtime-win32-arm64",
    };
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return {
      binaryName,
      targetTriple: "x86_64-pc-windows-msvc",
      platformSuffix: "-win32-x64",
      packageName: "@stuart/codex-runtime-win32-x64",
    };
  }

  throw new Error(`Unsupported platform: ${process.platform} (${process.arch})`);
}

function resolveCodexBinary(target) {
  const directPackageRoot = resolvePackageRoot(target.packageName);
  if (directPackageRoot) {
    const directCandidate = resolveMaybeUnpacked(
      path.join(directPackageRoot, "vendor", target.targetTriple, "codex", target.binaryName)
    );
    if (existsSync(directCandidate)) {
      return directCandidate;
    }
  }

  const fallbackRoot = path.resolve(__dirname, "..", "node_modules", target.packageName);
  const fallbackCandidate = resolveMaybeUnpacked(
    path.join(fallbackRoot, "vendor", target.targetTriple, "codex", target.binaryName)
  );
  if (existsSync(fallbackCandidate)) {
    return fallbackCandidate;
  }

  const packageRoot = directPackageRoot ?? resolvePackageRoot("@openai/codex");
  if (packageRoot) {
    const pnpmRoot = path.resolve(packageRoot, "..", "..", "..", "..");
    if (existsSync(pnpmRoot)) {
      for (const entry of readdirSync(pnpmRoot)) {
        if (!entry.startsWith("@openai+codex@") || !entry.includes(target.platformSuffix)) {
          continue;
        }

        const candidate = resolveMaybeUnpacked(
          path.join(pnpmRoot, entry, "node_modules", "@openai", "codex", "vendor", target.targetTriple, "codex", target.binaryName)
        );
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }

  throw new Error(`Could not locate the bundled Codex runtime for ${target.targetTriple}. Reinstall Stuart.`);
}

function resolvePackageRoot(packageName) {
  try {
    return path.dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    return null;
  }
}

function resolveMaybeUnpacked(targetPath) {
  if (targetPath.includes("app.asar")) {
    return targetPath.replace(/app\.asar([/\\])/g, "app.asar.unpacked$1");
  }
  return targetPath;
}
