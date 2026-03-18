import { spawn } from "node:child_process";
import type { SystemDiagnostics } from "../../packages/runtime-supervisor/src/diagnostics.js";

export function printDiagnosticsReport(diagnostics: SystemDiagnostics): void {
  const requiredErrors = diagnostics.checks.filter((check) => check.required && check.status === "error");
  const optionalWarnings = diagnostics.checks.filter((check) => !check.required && check.status === "warn");

  process.stdout.write("\nStuart system check\n");
  process.stdout.write("===================\n");

  for (const check of diagnostics.checks) {
    const prefix =
      check.status === "ok" ? "[ok]   " : check.status === "warn" ? "[warn] " : "[fail] ";
    process.stdout.write(`${prefix}${check.label}: ${check.summary}\n`);
    if (check.detail) {
      process.stdout.write(`       ${check.detail}\n`);
    }
    if (check.resolution && check.status !== "ok") {
      process.stdout.write(`       Fix: ${check.resolution}\n`);
    }
    if (check.command && check.status !== "ok") {
      process.stdout.write(`       Check: ${check.command}\n`);
    }
  }

  process.stdout.write("\n");
  if (requiredErrors.length > 0) {
    process.stdout.write(
      `Required issues: ${requiredErrors.length}. Stuart will not boot cleanly until these are fixed.\n`
    );
  } else if (optionalWarnings.length > 0) {
    process.stdout.write(
      `Required checks passed. Optional gaps: ${optionalWarnings.length}. Stuart can still run.\n`
    );
  } else {
    process.stdout.write("All core and optional checks passed.\n");
  }
}

export function hasRequiredFailures(diagnostics: SystemDiagnostics): boolean {
  return diagnostics.checks.some((check) => check.required && check.status === "error");
}

export function printQuickPreflight(diagnostics: SystemDiagnostics): void {
  const requiredErrors = diagnostics.checks.filter((check) => check.required && check.status === "error");
  const optionalWarnings = diagnostics.checks.filter((check) => !check.required && check.status === "warn");

  if (requiredErrors.length > 0) {
    process.stderr.write("Stuart preflight failed.\n");
    for (const check of requiredErrors) {
      process.stderr.write(`- ${check.label}: ${check.summary}\n`);
      if (check.resolution) {
        process.stderr.write(`  ${check.resolution}\n`);
      }
    }
    process.stderr.write("Run `pnpm preflight` for the full report.\n");
    return;
  }

  if (optionalWarnings.length > 0) {
    process.stdout.write(
      `Stuart preflight passed with ${optionalWarnings.length} optional gap${optionalWarnings.length === 1 ? "" : "s"}. Run \`pnpm preflight\` for details.\n`
    );
    return;
  }

  process.stdout.write("Stuart preflight passed.\n");
}

export function spawnPnpmScript(scriptName: string): Promise<number> {
  const pnpmBinary = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  return new Promise((resolve, reject) => {
    const child = spawn(pnpmBinary, ["run", scriptName], {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${scriptName} terminated by signal ${signal}.`));
        return;
      }
      resolve(code ?? 0);
    });
  });
}
