import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const releaseDir = join(desktopDir, "release");
const packageJson = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
const version = packageJson.version ?? "0.1.0";
const mode = process.argv[2] ?? "dir";
const DEFAULT_NOTARY_KEYCHAIN_PROFILE = "stuart-notary";

function run(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: "inherit",
    cwd: desktopDir,
    env: process.env,
    ...options,
  });
}

function runCapture(command, args, options = {}) {
  return execFileSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: desktopDir,
    env: process.env,
    encoding: "utf8",
    ...options,
  });
}

function safeVolumePrefix() {
  const productName = String(packageJson.productName ?? "Stuart").trim();
  return `${productName} ${version}`;
}

function listMountedReleaseVolumes() {
  try {
    const output = runCapture("hdiutil", ["info"]);
    const lines = output.split("\n");
    const volumes = [];
    const prefix = safeVolumePrefix();
    for (const line of lines) {
      const match = line.match(/^\s*mount-point:\s+(\/Volumes\/.+)$/);
      if (!match) continue;
      const mountPath = match[1].trim();
      const volumeName = mountPath.split("/").pop() ?? "";
      if (volumeName.startsWith(prefix)) {
        volumes.push(mountPath);
      }
    }
    return volumes;
  } catch {
    return [];
  }
}

function detachMountedReleaseVolumes() {
  for (const mountPath of listMountedReleaseVolumes()) {
    try {
      execFileSync("hdiutil", ["detach", mountPath, "-force"], { stdio: "ignore" });
    } catch {
      // Best effort; packaging can still proceed if a stale mount disappears concurrently.
    }
  }
}

function listSigningIdentities() {
  try {
    return runCapture("security", ["find-identity", "-v", "-p", "codesigning"]);
  } catch {
    return "";
  }
}

function hasDeveloperIdIdentity() {
  const output = listSigningIdentities();
  return /Developer ID Application:/i.test(output);
}

function hasUsableKeychainProfile(profile) {
  if (!profile) {
    return { ok: false, reason: "missing" };
  }

  try {
    runCapture(
      "xcrun",
      ["notarytool", "history", "--keychain-profile", profile, "--output-format", "json"],
      { timeout: 15_000 },
    );
    return { ok: true };
  } catch (error) {
    const details = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.trim();
    if (details.includes("keychainLocked(")) {
      return { ok: false, reason: "keychain-locked", details };
    }
    if (details.includes("No Keychain password item found")) {
      return { ok: false, reason: "profile-missing", details };
    }
    return { ok: false, reason: "unknown", details };
  }
}

function resolveNotarizationCredentials() {
  const env = process.env;

  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) {
    return { type: "app-store-connect-api-key" };
  }

  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
    return { type: "apple-id" };
  }

  const explicitProfile = env.APPLE_KEYCHAIN_PROFILE?.trim() || env.STUART_NOTARY_PROFILE?.trim();
  if (explicitProfile) {
    const status = hasUsableKeychainProfile(explicitProfile);
    if (!status.ok) {
      const source = env.APPLE_KEYCHAIN_PROFILE?.trim() ? "APPLE_KEYCHAIN_PROFILE" : "STUART_NOTARY_PROFILE";
      if (status.reason === "keychain-locked") {
        throw new Error(
          `Apple notarization keychain profile ${explicitProfile} from ${source} is locked. Unlock the default keychain and rerun the mac release build.`,
        );
      }
      throw new Error(
        `Apple notarization keychain profile ${explicitProfile} from ${source} is not usable.${status.details ? `\n${status.details}` : ""}`,
      );
    }
    return {
      type: "keychain-profile",
      profile: explicitProfile,
      source: env.APPLE_KEYCHAIN_PROFILE?.trim() ? "APPLE_KEYCHAIN_PROFILE" : "STUART_NOTARY_PROFILE",
    };
  }

  if (mode === "mac") {
    const status = hasUsableKeychainProfile(DEFAULT_NOTARY_KEYCHAIN_PROFILE);
    if (status.ok) {
      return {
        type: "keychain-profile",
        profile: DEFAULT_NOTARY_KEYCHAIN_PROFILE,
        source: "default",
      };
    }
    if (status.reason === "keychain-locked") {
      process.stdout.write(
        `Apple notarization keychain profile ${DEFAULT_NOTARY_KEYCHAIN_PROFILE} exists but the default keychain is locked. Unlock it to enable notarization.\n`,
      );
    }
  }

  return null;
}

function resolveSigningIdentity() {
  const explicitIdentity = process.env.CSC_NAME?.trim();
  if (explicitIdentity) {
    return {
      mode: explicitIdentity === "-" ? "adhoc" : "named",
      identity: explicitIdentity,
      source: "CSC_NAME",
    };
  }

  if (hasDeveloperIdIdentity()) {
    return {
      mode: "auto-developer-id",
    };
  }

  return {
    mode: "adhoc",
    identity: "-",
    source: "fallback",
  };
}

function assertSigningReady(identity) {
  if (identity.mode === "adhoc") {
    return;
  }

  const signTarget =
    identity.mode === "named"
      ? identity.identity
      : listSigningIdentities()
          .split("\n")
          .map((line) => line.match(/"(Developer ID Application:.+)"/)?.[1] ?? null)
          .find(Boolean);

  if (!signTarget) {
    throw new Error("Could not resolve a Developer ID Application identity for codesigning.");
  }

  const tempDir = mkdtempSync(join(tmpdir(), "stuart-codesign-check-"));
  const tempBinaryPath = join(tempDir, "true");

  try {
    copyFileSync("/usr/bin/true", tempBinaryPath);
    runCapture("codesign", ["--sign", signTarget, "--force", "--timestamp", "--options", "runtime", tempBinaryPath], {
      timeout: 30_000,
    });
  } catch (error) {
    const details = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.trim();
    if (details.includes("errSecInternalComponent")) {
      throw new Error(
        `Developer ID signing identity is present but the private key is not usable. Unlock the keychain or grant codesign access, then rerun the mac release build.${details ? `\n${details}` : ""}`,
      );
    }
    throw new Error(`Developer ID signing preflight failed.${details ? `\n${details}` : ""}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function resolveBuilderArgs() {
  const args = ["exec", "electron-builder", "--config", "electron-builder.json"];
  const signingIdentity = resolveSigningIdentity();
  const notarization = resolveNotarizationCredentials();

  if (mode === "mac") {
    args.push("--mac", "dmg", "zip", "--publish", "never");
  } else if (mode === "dir") {
    args.push("--dir");
  } else {
    throw new Error(`Unsupported package mode: ${mode}`);
  }

  if (signingIdentity.mode === "named") {
    process.stdout.write(`Using explicit signing identity from CSC_NAME.\n`);
  } else if (signingIdentity.mode === "auto-developer-id") {
    process.stdout.write(`Using Developer ID Application certificate from keychain.\n`);
  } else if (signingIdentity.source === "CSC_NAME") {
    process.stdout.write(`Using ad-hoc signing because CSC_NAME is set to -.\n`);
    args.push("-c.mac.identity=-");
  } else {
    process.stdout.write(`No Developer ID Application certificate found. Falling back to ad-hoc signing.\n`);
    args.push("-c.mac.identity=-");
  }

  if (notarization?.type === "keychain-profile") {
    process.env.APPLE_KEYCHAIN_PROFILE = notarization.profile;
    process.stdout.write(
      `Apple notarization credentials detected via keychain profile ${notarization.profile} (${notarization.source}). Enabling notarization.\n`,
    );
    args.push("-c.mac.notarize=true");
  } else if (notarization) {
    process.stdout.write(`Apple notarization credentials detected (${notarization.type}). Enabling notarization.\n`);
    args.push("-c.mac.notarize=true");
  } else {
    process.stdout.write(
      `No Apple notarization credentials detected. Skipping notarization. If you use a notarytool keychain profile, rerun with APPLE_KEYCHAIN_PROFILE=<profile> (for example APPLE_KEYCHAIN_PROFILE=${DEFAULT_NOTARY_KEYCHAIN_PROFILE}).\n`,
    );
  }

  return args;
}

function verifyApp(appPath) {
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
}

function parseMountedVolumePaths(plistOutput) {
  const matches = [...plistOutput.matchAll(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/g)];
  return matches.map((match) => match[1]).filter(Boolean);
}

function verifyDmg(dmgPath) {
  detachMountedReleaseVolumes();
  const mountOutput = runCapture("hdiutil", ["attach", "-plist", "-nobrowse", "-readonly", dmgPath]);
  const mountPath = parseMountedVolumePaths(mountOutput).at(-1);

  if (!mountPath) {
    throw new Error(`Could not determine DMG mount path for ${dmgPath}`);
  }

  const appPath = join(mountPath, "Stuart.app");
  try {
    verifyApp(appPath);
  } finally {
    try {
      execFileSync("hdiutil", ["detach", mountPath, "-force"], { stdio: "ignore" });
    } catch {
      // Ignore detach failures.
    }
  }
}

function findReleaseArtifact(ext) {
  const candidates = readdirSync(releaseDir)
    .filter((entry) => entry.endsWith(ext) && entry.includes(version))
    .map((entry) => ({ entry, mtimeMs: statSync(join(releaseDir, entry)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.entry.localeCompare(b.entry));
  if (candidates.length === 0) {
    throw new Error(`Could not find ${ext} artifact in ${releaseDir}`);
  }
  return join(releaseDir, candidates[0].entry);
}

detachMountedReleaseVolumes();
run("pnpm", ["run", "build"]);
const signingIdentity = resolveSigningIdentity();
if (mode === "mac") {
  assertSigningReady(signingIdentity);
}
run("pnpm", resolveBuilderArgs());

const packagedAppPath = join(releaseDir, "mac-arm64", "Stuart.app");
verifyApp(packagedAppPath);

if (mode === "mac") {
  // electron-builder's DMG sometimes comes out empty. Rebuild it from the
  // verified .app using hdiutil directly as a reliable fallback.
  const dmgPath = findReleaseArtifact(".dmg");
  try {
    verifyDmg(dmgPath);
  } catch (dmgError) {
    process.stdout.write(`electron-builder DMG verification failed (${dmgError.message}). Rebuilding DMG from .app...\n`);
    try { unlinkSync(dmgPath); } catch { /* ignore */ }
    run("hdiutil", [
      "create",
      "-volname", "Stuart",
      "-srcfolder", packagedAppPath,
      "-ov",
      "-format", "UDZO",
      dmgPath,
    ]);
    verifyDmg(dmgPath);
  }
}

process.stdout.write(`Packaging finished successfully.\n`);
