import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, copyFile, access, writeFile, mkdtemp, chmod } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(workspaceRoot, "apps", "desktop");
const desktopDistDir = join(desktopDir, "dist");
const webClientDistDir = join(workspaceRoot, "apps", "web", "dist");
const webServerDistDir = join(workspaceRoot, "apps", "web", "dist-server");
const desktopClientOutDir = join(desktopDistDir, "web-client");
const desktopServerOutDir = join(desktopDistDir, "web-server");
const desktopBuildDir = join(desktopDir, "build");
const desktopIconSvgPath = join(desktopBuildDir, "icon.svg");
const desktopIconPngPath = join(desktopBuildDir, "icon.png");
const desktopIconIcnsPath = join(desktopBuildDir, "icon.icns");

async function commandExists(command) {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function ensureDesktopIconAssets() {
  if (process.platform !== "darwin") {
    return;
  }

  const [hasQlmanage, hasSips, hasIconutil] = await Promise.all([
    commandExists("qlmanage"),
    commandExists("sips"),
    commandExists("iconutil"),
  ]);

  if (!hasQlmanage || !hasSips || !hasIconutil) {
    process.stdout.write("Skipped desktop icon generation: macOS icon tools are unavailable.\n");
    return;
  }

  try {
    await access(desktopIconSvgPath, constants.R_OK);
  } catch {
    process.stdout.write("Skipped desktop icon generation: icon.svg is missing.\n");
    return;
  }

  const tempDir = join(desktopBuildDir, ".icon-build");
  const iconsetDir = join(desktopBuildDir, "icon.iconset");
  const renderedQuickLookPng = join(tempDir, `${basename(desktopIconSvgPath)}.png`);

  await rm(tempDir, { recursive: true, force: true });
  await rm(iconsetDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  await mkdir(iconsetDir, { recursive: true });

  execFileSync("qlmanage", ["-t", "-s", "1024", "-o", tempDir, desktopIconSvgPath], { stdio: "ignore" });
  await copyFile(renderedQuickLookPng, desktopIconPngPath);

  const iconsetTargets = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ];

  for (const [filename, size] of iconsetTargets) {
    execFileSync("sips", ["-z", String(size), String(size), desktopIconPngPath, "--out", join(iconsetDir, filename)], {
      stdio: "ignore",
    });
  }

  execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", desktopIconIcnsPath], { stdio: "ignore" });
  await copyFile(desktopIconPngPath, join(desktopDistDir, "icon.png"));
  process.stdout.write("Generated desktop icon assets.\n");
}

await mkdir(desktopDistDir, { recursive: true });
await mkdir(desktopBuildDir, { recursive: true });
await ensureDesktopIconAssets();

await copyFile(
  join(desktopDir, "src", "preload.cjs"),
  join(desktopDistDir, "preload.cjs")
);
await copyFile(
  join(desktopDir, "src", "codex-launcher.mjs"),
  join(desktopDistDir, "codex-launcher.mjs")
);

await rm(desktopClientOutDir, { recursive: true, force: true });
await rm(desktopServerOutDir, { recursive: true, force: true });

await cp(webClientDistDir, desktopClientOutDir, { recursive: true });
await cp(webServerDistDir, desktopServerOutDir, { recursive: true });

// Copy the platform-specific Codex binary to a well-known location
// (pnpm's virtual store structure isn't followed by electron-builder)
const codexVendorDir = join(desktopDir, "codex-vendor");
await rm(codexVendorDir, { recursive: true, force: true });

const platform = process.platform;
const arch = process.arch;
const targetMap = {
  "darwin-arm64": { triple: "aarch64-apple-darwin", suffix: "-darwin-arm64" },
  "darwin-x64": { triple: "x86_64-apple-darwin", suffix: "-darwin-x64" },
  "linux-arm64": { triple: "aarch64-unknown-linux-musl", suffix: "-linux-arm64" },
  "linux-x64": { triple: "x86_64-unknown-linux-musl", suffix: "-linux-x64" },
  "win32-arm64": { triple: "aarch64-pc-windows-msvc", suffix: "-win32-arm64" },
  "win32-x64": { triple: "x86_64-pc-windows-msvc", suffix: "-win32-x64" },
};

const target = targetMap[`${platform}-${arch}`];
if (target) {
  const binaryName = platform === "win32" ? "codex.exe" : "codex";
  // Search pnpm store for the codex binary
  const { readdirSync, existsSync } = await import("node:fs");
  const pnpmStore = join(workspaceRoot, "node_modules", ".pnpm");
  let codexBinaryPath = null;

  if (existsSync(pnpmStore)) {
    for (const entry of readdirSync(pnpmStore)) {
      if (!entry.startsWith("@openai+codex@") || !entry.includes(target.suffix)) continue;
      const candidate = join(pnpmStore, entry, "node_modules", "@openai", "codex", "vendor", target.triple, "codex", binaryName);
      if (existsSync(candidate)) {
        codexBinaryPath = candidate;
        break;
      }
    }
  }

  if (codexBinaryPath) {
    const vendorOutDir = join(codexVendorDir, target.triple, "codex");
    await mkdir(vendorOutDir, { recursive: true });
    await copyFile(codexBinaryPath, join(vendorOutDir, binaryName));
    // Also copy the path/ directory if it exists (companion binaries)
    const pathDir = join(dirname(dirname(codexBinaryPath)), "path");
    if (existsSync(pathDir)) {
      await cp(pathDir, join(codexVendorDir, target.triple, "path"), { recursive: true });
    }
    process.stdout.write(`Bundled Codex runtime for ${target.triple}.\n`);
  } else {
    process.stdout.write(`Warning: Codex runtime for ${target.triple} not found in pnpm store.\n`);
  }
} else {
  process.stdout.write(`Warning: No Codex runtime target for ${platform}-${arch}.\n`);
}

// Cursor Agent CLI: full dist-package (binary + adjacent assets), same layout as the official installer tarball/zip.
const CURSOR_AGENT_VENDOR_VERSION =
  process.env.CURSOR_AGENT_VENDOR_VERSION?.trim() || "2026.03.30-a5d3e17";
const cursorVendorDir = join(desktopDir, "cursor-vendor");
await rm(cursorVendorDir, { recursive: true, force: true });

const cursorArch = arch === "x64" ? "x64" : "arm64";
/** @type {{ url: string; zip: boolean } | null} */
let cursorRemote = null;
if (platform === "darwin") {
  cursorRemote = {
    url: `https://downloads.cursor.com/lab/${CURSOR_AGENT_VENDOR_VERSION}/darwin/${cursorArch}/agent-cli-package.tar.gz`,
    zip: false,
  };
} else if (platform === "linux") {
  cursorRemote = {
    url: `https://downloads.cursor.com/lab/${CURSOR_AGENT_VENDOR_VERSION}/linux/${cursorArch}/agent-cli-package.tar.gz`,
    zip: false,
  };
} else if (platform === "win32") {
  cursorRemote = {
    url: `https://downloads.cursor.com/lab/${CURSOR_AGENT_VENDOR_VERSION}/windows/${cursorArch}/agent-cli-package.zip`,
    zip: true,
  };
}

if (cursorRemote) {
  const outKey = `${platform}-${arch}`;
  const outDir = join(cursorVendorDir, outKey);
  const agentName = platform === "win32" ? "cursor-agent.exe" : "cursor-agent";
  const tmpRoot = await mkdtemp(join(tmpdir(), "stuart-cursor-agent-"));
  const archivePath = join(tmpRoot, cursorRemote.zip ? "agent-cli-package.zip" : "agent-cli-package.tar.gz");

  try {
    process.stdout.write(`Downloading Cursor Agent CLI (${CURSOR_AGENT_VENDOR_VERSION}) for ${outKey}…\n`);
    const res = await fetch(cursorRemote.url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    await writeFile(archivePath, Buffer.from(await res.arrayBuffer()));

    await mkdir(outDir, { recursive: true });

    if (cursorRemote.zip) {
      if (platform === "win32") {
        const ap = archivePath.replace(/'/g, "''");
        const dp = tmpRoot.replace(/'/g, "''");
        execFileSync(
          "powershell.exe",
          ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${ap}' -DestinationPath '${dp}\\zip-out' -Force`],
          { stdio: "inherit" }
        );
      } else {
        await mkdir(join(tmpRoot, "zip-out"), { recursive: true });
        execFileSync("unzip", ["-q", "-o", archivePath, "-d", join(tmpRoot, "zip-out")], { stdio: "inherit" });
      }
      const zipOut = join(tmpRoot, "zip-out");
      const flat = existsSync(join(zipOut, "dist-package")) ? join(zipOut, "dist-package") : zipOut;
      await cp(flat, outDir, { recursive: true });
    } else {
      execFileSync("tar", ["-xzf", archivePath, "-C", outDir, "--strip-components=1"], { stdio: "inherit" });
    }

    if (platform !== "win32") {
      try {
        await chmod(join(outDir, "cursor-agent"), 0o755);
      } catch {
        // best effort
      }
    }

    if (!existsSync(join(outDir, agentName))) {
      throw new Error(`Bundled layout missing ${agentName} after extract`);
    }
    process.stdout.write(`Bundled Cursor Agent CLI for ${outKey}.\n`);
  } catch (err) {
    process.stdout.write(
      `Warning: Could not bundle Cursor Agent CLI for ${outKey}: ${err instanceof Error ? err.message : String(err)}\n`
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
} else {
  process.stdout.write(`Warning: No Cursor Agent CLI download target for ${platform}-${arch}.\n`);
}

process.stdout.write("Synced desktop app assets.\n");
