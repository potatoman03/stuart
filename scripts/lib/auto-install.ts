import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type InstallTarget = {
  id: "tesseract" | "libreoffice";
  label: string;
  brewName: string;
  kind: "formula" | "cask";
};

type InstallResult = {
  installed: string[];
  skipped: string[];
  failed: Array<{ label: string; reason: string }>;
  notes: string[];
};

const INSTALL_TARGETS: InstallTarget[] = [
  {
    id: "tesseract",
    label: "Tesseract OCR",
    brewName: "tesseract",
    kind: "formula",
  },
  {
    id: "libreoffice",
    label: "LibreOffice",
    brewName: "libreoffice",
    kind: "cask",
  },
];

async function hasCommand(command: string): Promise<boolean> {
  try {
    await execFileAsync("which", [command], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

async function brewPackageInstalled(target: InstallTarget): Promise<boolean> {
  try {
    await execFileAsync(
      "brew",
      target.kind === "cask" ? ["list", "--cask", target.brewName] : ["list", target.brewName],
      { encoding: "utf8" }
    );
    return true;
  } catch {
    return false;
  }
}

async function brewInstall(target: InstallTarget): Promise<void> {
  await execFileAsync(
    "brew",
    target.kind === "cask" ? ["install", "--cask", target.brewName] : ["install", target.brewName],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }
  );
}

export async function autoInstallOptionalMacTools(): Promise<InstallResult> {
  const result: InstallResult = {
    installed: [],
    skipped: [],
    failed: [],
    notes: [],
  };

  if (process.platform !== "darwin") {
    result.notes.push("Auto-install is only configured for macOS right now.");
    return result;
  }

  const autoInstallEnabled = process.env.STUART_BOOTSTRAP_AUTO_INSTALL !== "0";
  if (!autoInstallEnabled) {
    result.notes.push("Auto-install disabled by STUART_BOOTSTRAP_AUTO_INSTALL=0.");
    return result;
  }

  if (!(await hasCommand("brew"))) {
    result.notes.push("Homebrew is not installed, so Stuart could not auto-install optional OCR/document tools.");
    return result;
  }

  for (const target of INSTALL_TARGETS) {
    const isInstalled = await brewPackageInstalled(target);
    if (isInstalled) {
      result.skipped.push(target.label);
      continue;
    }

    try {
      await brewInstall(target);
      result.installed.push(target.label);
    } catch (error) {
      result.failed.push({
        label: target.label,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!(await hasCommand("swift"))) {
    result.notes.push("Swift is still missing. Install Xcode Command Line Tools if you want macOS PDF page rendering.");
  }

  return result;
}
