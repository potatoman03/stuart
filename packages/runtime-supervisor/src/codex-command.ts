export interface CodexCommandConfig {
  binaryPath: string;
  argsPrefix: string[];
  env: NodeJS.ProcessEnv;
  displayCommand: string;
}

export function resolveCodexCommandConfig(binaryPathOverride?: string): CodexCommandConfig {
  const binaryPath = binaryPathOverride ?? process.env.CODEX_BINARY_PATH ?? "codex";
  const scriptPath = process.env.CODEX_BINARY_SCRIPT_PATH?.trim();
  const runAsNode = process.env.CODEX_BINARY_RUN_AS_NODE === "1";

  return {
    binaryPath,
    argsPrefix: scriptPath ? [scriptPath] : [],
    env: runAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {},
    displayCommand: [binaryPath, scriptPath].filter(Boolean).join(" "),
  };
}

export function buildCodexCommandArgs(
  config: Pick<CodexCommandConfig, "argsPrefix">,
  args: string[]
): string[] {
  return [...config.argsPrefix, ...args];
}
