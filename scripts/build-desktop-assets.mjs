import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, copyFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

process.stdout.write("Synced desktop app assets.\n");
