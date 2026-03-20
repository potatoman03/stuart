import { execFile } from "node:child_process";
import { copyFile, mkdir, access } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { buildCodexCommandArgs, resolveCodexCommandConfig } from "./codex-command.js";

export type SystemDiagnosticStatus = "ok" | "warn" | "error";
export type SystemDiagnosticsSurface = "developer" | "desktop";

export interface SystemDiagnosticCheck {
  id: string;
  label: string;
  status: SystemDiagnosticStatus;
  required: boolean;
  summary: string;
  detail?: string;
  command?: string;
  resolution?: string;
}

export interface SystemDiagnostics {
  generatedAt: string;
  overallStatus: SystemDiagnosticStatus;
  requiredReady: boolean;
  checks: SystemDiagnosticCheck[];
}

export interface CollectSystemDiagnosticsOptions {
  workspaceRoot?: string;
  dataDir?: string;
  envFilePath?: string;
  codexBinaryPath?: string;
  vmHelperBinaryPath?: string;
  sandboxAvailable?: boolean | null;
  surface?: SystemDiagnosticsSurface;
  managedCodex?: boolean;
}

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  detail?: string;
};

const DEFAULT_TIMEOUT_MS = 4000;

export async function collectSystemDiagnostics(
  options: CollectSystemDiagnosticsOptions = {}
): Promise<SystemDiagnostics> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const envFilePath = resolve(options.envFilePath ?? join(workspaceRoot, ".env"));
  const dataDir = resolve(options.dataDir ?? join(workspaceRoot, ".stuart-data"));
  const codexBinaryPath = options.codexBinaryPath ?? process.env.CODEX_BINARY_PATH ?? "codex";
  const codexCommand = resolveCodexCommandConfig(codexBinaryPath);
  const vmHelperPath = resolveVmHelperPath(workspaceRoot, options.vmHelperBinaryPath);
  const surface =
    options.surface ??
    (process.env.STUART_RUNTIME_MODE === "desktop" || process.env.STUART_RUNTIME_MODE === "standalone" ? "desktop" : "developer");
  const managedCodex =
    options.managedCodex ??
    process.env.STUART_DESKTOP_MANAGED_CODEX === "1";

  const checks: SystemDiagnosticCheck[] = [];

  if (surface === "developer") {
    const nodeVersion = process.version;
    const nodeMajor = Number.parseInt(nodeVersion.replace(/^v/, "").split(".")[0] ?? "0", 10);
    checks.push({
      id: "node",
      label: "Node.js",
      status: nodeMajor >= 22 ? "ok" : "error",
      required: true,
      summary: `Detected ${nodeVersion}`,
      detail: nodeMajor >= 22 ? undefined : "Stuart expects Node 22 or newer.",
      command: "node --version",
      resolution: nodeMajor >= 22 ? undefined : "Install Node 22+ and restart the shell.",
    });

    const pnpmVersion = await runCommand("pnpm", ["--version"]);
    checks.push(commandCheck({
      id: "pnpm",
      label: "pnpm",
      required: true,
      command: "pnpm --version",
      result: pnpmVersion,
      summary: pnpmVersion.stdout || "pnpm is available",
      failureSummary: "pnpm is not available.",
      resolution: "Install pnpm and run `pnpm install`.",
    }));
  } else {
    checks.push({
      id: "stuart-runtime",
      label: "Stuart desktop runtime",
      status: "ok",
      required: true,
      summary: "The app's built-in runtime is available.",
    });
  }

  const codexVersion = await runCommand(
    codexCommand.binaryPath,
    buildCodexCommandArgs(codexCommand, ["--version"]),
    codexCommand.env
  );
  checks.push({
    id: "codex-cli",
    label: surface === "desktop" ? "Codex runtime" : "Codex CLI",
    status: codexVersion.ok ? "ok" : "error",
    required: true,
    summary: codexVersion.ok
      ? (managedCodex
        ? `Included with Stuart (${codexVersion.stdout || "Codex runtime detected"})`
        : (codexVersion.stdout || "Codex CLI is available"))
      : (surface === "desktop"
        ? "Stuart could not load its built-in Codex runtime."
        : "Codex CLI is not available."),
    detail: codexVersion.ok ? undefined : codexVersion.detail || firstMeaningfulLine(codexVersion.stderr),
    command: surface === "developer" ? `${codexCommand.displayCommand} --version` : undefined,
    resolution: codexVersion.ok
      ? undefined
      : (surface === "desktop"
        ? "Reinstall Stuart or update to the latest desktop build."
        : "Install Codex CLI and ensure it is on PATH, or set CODEX_BINARY_PATH."),
  });

  const codexLogin = codexVersion.ok
    ? await runCommand(
      codexCommand.binaryPath,
      buildCodexCommandArgs(codexCommand, ["login", "status"]),
      codexCommand.env
    )
    : { ok: false, stdout: "", stderr: "", detail: "Skipped because Codex CLI is unavailable." };
  checks.push({
    id: "codex-auth",
    label: "Codex authentication",
    status: codexLogin.ok ? "ok" : "error",
    required: true,
    summary: codexLogin.ok
      ? firstMeaningfulLine(codexLogin.stdout, "ChatGPT account connected.")
      : (surface === "desktop" ? "Your ChatGPT account is not connected yet." : "Codex is not authenticated."),
    detail: codexLogin.ok ? undefined : codexLogin.detail || firstMeaningfulLine(codexLogin.stderr),
    command: surface === "developer" ? `${codexCommand.displayCommand} login status` : undefined,
    resolution: codexLogin.ok
      ? undefined
      : (surface === "desktop"
        ? "Use the “Connect ChatGPT” step in Stuart to finish signing in."
        : `Run \`${codexCommand.displayCommand} login\` and complete authentication.`),
  });

  if (surface === "developer") {
    const envPresent = existsSync(envFilePath);
    checks.push({
      id: "env-file",
      label: "Local .env",
      status: envPresent ? "ok" : "warn",
      required: false,
      summary: envPresent ? `.env found at ${envFilePath}` : `.env not found at ${envFilePath}`,
      resolution: envPresent ? undefined : "Run `pnpm bootstrap` to create a starter .env from .env.example.",
    });
  }

  const dataDirWritable = await ensurePathWritable(dataDir);
  checks.push({
    id: "data-dir",
    label: surface === "desktop" ? "Study data storage" : "Stuart data directory",
    status: dataDirWritable.ok ? "ok" : "error",
    required: true,
    summary: dataDirWritable.ok
      ? (surface === "desktop" ? "Stuart can save study history and artifacts locally." : `Using ${dataDir}`)
      : `Cannot write to ${dataDir}`,
    detail: dataDirWritable.detail,
    resolution: dataDirWritable.ok
      ? undefined
      : (surface === "desktop"
        ? "Check macOS file permissions and make sure Stuart can access its local app data folder."
        : "Check STUART_DATA_DIR and local filesystem permissions."),
  });

  const dockerVersion = await runCommand("docker", ["--version"]);
  const dockerInfo = dockerVersion.ok ? await runCommand("docker", ["info", "--format", "{{.ServerVersion}}"]) : dockerVersion;
  checks.push({
    id: "docker",
    label: "Docker sandbox",
    status: dockerInfo.ok ? "ok" : "warn",
    required: false,
    summary: dockerInfo.ok
      ? `Docker daemon reachable (${firstMeaningfulLine(dockerInfo.stdout, dockerVersion.stdout)})`
      : "Docker sandbox unavailable.",
    detail: dockerInfo.ok ? undefined : dockerInfo.detail || firstMeaningfulLine(dockerInfo.stderr, dockerVersion.stdout),
    command: surface === "developer" ? "docker info --format '{{.ServerVersion}}'" : undefined,
    resolution: dockerInfo.ok
      ? undefined
      : (surface === "desktop"
        ? "Optional only. Install or start Docker Desktop if you want advanced scripted document generation."
        : "Start Docker Desktop or another Docker daemon if you want sandboxed scripted artifact generation."),
  });

  if (surface === "developer") {
    const swiftVersion = await runCommand("swift", ["--version"]);
    checks.push(optionalCommandCheck({
      id: "swift",
      label: "Swift",
      command: "swift --version",
      result: swiftVersion,
      resolution: "Install Xcode Command Line Tools or Swift if you want the native VM helper and macOS PDF render path.",
    }));
  }

  const tesseractVersion = await runCommand("tesseract", ["--version"]);
  checks.push(optionalCommandCheck({
    id: "tesseract",
    label: "Tesseract OCR",
    command: surface === "developer" ? "tesseract --version" : undefined,
    result: tesseractVersion,
    resolution: surface === "desktop"
      ? "Optional only. Install Tesseract if you want OCR for scanned or image-heavy study material."
      : "Install Tesseract if you want OCR for image-heavy or scanned study material.",
  }));

  const sofficeVersion = await runCommand("soffice", ["--version"]);
  checks.push(optionalCommandCheck({
    id: "soffice",
    label: "LibreOffice",
    command: surface === "developer" ? "soffice --version" : undefined,
    result: sofficeVersion,
    resolution: surface === "desktop"
      ? "Optional only. Install LibreOffice if you want richer Word document extraction."
      : "Install LibreOffice if you want richer DOCX to PDF conversion during ingestion.",
  }));

  if (surface === "developer") {
    checks.push({
      id: "vm-helper",
      label: "Native VM helper",
      status: vmHelperPath && existsSync(vmHelperPath) ? "ok" : "warn",
      required: false,
      summary: vmHelperPath && existsSync(vmHelperPath)
        ? `Found ${basename(vmHelperPath)}`
        : "Native VM helper not built.",
      detail: vmHelperPath ? `Expected path: ${vmHelperPath}` : undefined,
      resolution: vmHelperPath && existsSync(vmHelperPath)
        ? undefined
        : "Run `node scripts/ensure-vm-helper.mjs` if you need the native helper. Normal web dev skips it by default.",
    });
  }

  if (typeof options.sandboxAvailable === "boolean") {
    checks.push({
      id: "sandbox-runtime",
      label: "Sandbox runtime warm status",
      status: options.sandboxAvailable ? "ok" : "warn",
      required: false,
      summary: options.sandboxAvailable
        ? "Sandbox executor warmed successfully."
        : "Sandbox executor is not available in this runtime.",
    });
  }

  const overallStatus = checks.some((check) => check.required && check.status === "error")
    ? "error"
    : checks.some((check) => check.status === "warn")
      ? "warn"
      : "ok";

  return {
    generatedAt: new Date().toISOString(),
    overallStatus,
    requiredReady: !checks.some((check) => check.required && check.status === "error"),
    checks,
  };
}

export async function ensureLocalEnvFile(
  workspaceRoot = process.cwd()
): Promise<{ created: boolean; path: string; sourcePath?: string }> {
  const root = resolve(workspaceRoot);
  const envPath = join(root, ".env");
  if (existsSync(envPath)) {
    return { created: false, path: envPath };
  }

  const examplePath = join(root, ".env.example");
  if (!existsSync(examplePath)) {
    return { created: false, path: envPath };
  }

  await copyFile(examplePath, envPath);
  return { created: true, path: envPath, sourcePath: examplePath };
}

function commandCheck(input: {
  id: string;
  label: string;
  required: boolean;
  command: string;
  result: CommandResult;
  summary: string;
  failureSummary: string;
  resolution: string;
}): SystemDiagnosticCheck {
  return {
    id: input.id,
    label: input.label,
    status: input.result.ok ? "ok" : "error",
    required: input.required,
    command: input.command,
    summary: input.result.ok ? input.summary : input.failureSummary,
    detail: input.result.ok ? undefined : input.result.detail || firstMeaningfulLine(input.result.stderr),
    resolution: input.result.ok ? undefined : input.resolution,
  };
}

function optionalCommandCheck(input: {
  id: string;
  label: string;
  command?: string;
  result: CommandResult;
  resolution: string;
}): SystemDiagnosticCheck {
  return {
    id: input.id,
    label: input.label,
    status: input.result.ok ? "ok" : "warn",
    required: false,
    command: input.command,
    summary: input.result.ok
      ? firstMeaningfulLine(input.result.stdout, `${input.label} is available.`)
      : `${input.label} is not available.`,
    detail: input.result.ok ? undefined : input.result.detail || firstMeaningfulLine(input.result.stderr),
    resolution: input.result.ok ? undefined : input.resolution,
  };
}

async function runCommand(
  command: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout: DEFAULT_TIMEOUT_MS,
        env: {
          ...process.env,
          ...extraEnv,
        },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolveResult({
            ok: true,
            stdout: String(stdout).trim(),
            stderr: String(stderr).trim(),
          });
          return;
        }

        const errorDetail =
          typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
            ? `${command} was not found on PATH.`
            : error instanceof Error
              ? error.message
              : String(error);

        resolveResult({
          ok: false,
          stdout: String(stdout ?? "").trim(),
          stderr: String(stderr ?? "").trim(),
          detail: errorDetail,
        });
      }
    );
  });
}

async function ensurePathWritable(path: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    await mkdir(path, { recursive: true });
    await access(path, constants.W_OK);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveVmHelperPath(workspaceRoot: string, override?: string): string | undefined {
  if (override) {
    return resolve(override);
  }

  const preferred = join(workspaceRoot, "native", "vm-helper", ".build", "debug", "StuartVMHelper");
  const legacy = join(workspaceRoot, "native", "vm-helper", ".build", "debug", "CoworkVMHelper");
  if (existsSync(preferred)) {
    return preferred;
  }
  if (existsSync(legacy)) {
    return legacy;
  }
  return preferred;
}

function firstMeaningfulLine(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (!value) {
      continue;
    }
    const line = value
      .split("\n")
      .map((entry) => entry.trim())
      .find(Boolean);
    if (line) {
      return line;
    }
  }
  return "";
}
