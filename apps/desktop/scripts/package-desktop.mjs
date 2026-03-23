import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
    return false;
  }

  try {
    runCapture(
      "xcrun",
      ["notarytool", "history", "--keychain-profile", profile, "--output-format", "json"],
      { timeout: 15_000 },
    );
    return true;
  } catch {
    return false;
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
    return {
      type: "keychain-profile",
      profile: explicitProfile,
      source: env.APPLE_KEYCHAIN_PROFILE?.trim() ? "APPLE_KEYCHAIN_PROFILE" : "STUART_NOTARY_PROFILE",
    };
  }

  if (mode === "mac" && hasUsableKeychainProfile(DEFAULT_NOTARY_KEYCHAIN_PROFILE)) {
    return {
      type: "keychain-profile",
      profile: DEFAULT_NOTARY_KEYCHAIN_PROFILE,
      source: "default",
    };
  }

  return null;
}

function resolveBuilderArgs() {
  const args = ["exec", "electron-builder", "--config", "electron-builder.json"];
  const notarization = resolveNotarizationCredentials();

  if (mode === "mac") {
    args.push("--mac", "dmg", "zip", "--publish", "never");
  } else if (mode === "dir") {
    args.push("--dir");
  } else {
    throw new Error(`Unsupported package mode: ${mode}`);
  }

  if (process.env.CSC_NAME?.trim()) {
    process.stdout.write(`Using explicit signing identity from CSC_NAME.\n`);
  } else if (hasDeveloperIdIdentity()) {
    process.stdout.write(`Using Developer ID Application certificate from keychain.\n`);
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

function verifyDmg(dmgPath) {
  const mountOutput = runCapture("hdiutil", ["attach", "-nobrowse", "-readonly", dmgPath]);
  const mountLine = mountOutput.trim().split("\n").filter(Boolean).at(-1);
  const mountPath = mountLine?.split("\t").filter(Boolean).at(-1)?.trim();

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
    .sort();
  if (candidates.length === 0) {
    throw new Error(`Could not find ${ext} artifact in ${releaseDir}`);
  }
  return join(releaseDir, candidates[candidates.length - 1]);
}

run("pnpm", ["run", "build"]);
run("pnpm", resolveBuilderArgs());

const packagedAppPath = join(releaseDir, "mac-arm64", "Stuart.app");
verifyApp(packagedAppPath);

if (mode === "mac") {
  verifyDmg(findReleaseArtifact(".dmg"));
}

process.stdout.write(`Packaging finished successfully.\n`);
