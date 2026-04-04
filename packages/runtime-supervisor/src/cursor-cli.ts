import { spawn } from "node:child_process";
import { resolveCursorAgentBinPath, resolveCursorAgentPackageCwd } from "./cursor-agent-path.js";

export type CursorAgentStreamCallbacks = {
  /** Incremental assistant text for UI streaming (after deduplicating Cursor's chunk shapes). */
  onAssistantDelta?: (delta: string) => void;
};

function extractAssistantChunkText(obj: unknown): string | null {
  const o = obj as {
    type?: string;
    message?: { content?: Array<{ type?: string; text?: string }> };
  };
  if (o.type !== "assistant" || !o.message?.content?.length) {
    return null;
  }
  const part = o.message.content[0];
  const t = part?.text;
  return typeof t === "string" ? t : null;
}

/**
 * Map Cursor stream-json assistant lines to sequential deltas (handles both
 * growing-prefix chunks and disjoint append fragments, plus duplicate full lines).
 */
function assistantTextToDeltas(
  displayed: string,
  raw: string
): { deltas: string[]; nextDisplayed: string } {
  if (raw === displayed) {
    return { deltas: [], nextDisplayed: displayed };
  }
  if (raw.startsWith(displayed)) {
    const delta = raw.slice(displayed.length);
    return { deltas: delta ? [delta] : [], nextDisplayed: raw };
  }
  return { deltas: [raw], nextDisplayed: displayed + raw };
}

/**
 * Run Cursor Agent in headless mode with stream-json; invokes onAssistantDelta
 * as text arrives. Uses `result` line as the canonical final assistant body.
 */
export async function runCursorAgentStreamJson(options: {
  workspaceRoot: string;
  model: string;
  prompt: string;
  resumeSessionId?: string;
  callbacks?: CursorAgentStreamCallbacks;
}): Promise<{ text: string; error?: string; sessionId?: string }> {
  const bin = resolveCursorAgentBinPath();
  const cwd = resolveCursorAgentPackageCwd(bin);
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
    "--workspace",
    options.workspaceRoot,
    "--model",
    options.model,
  ];
  if (options.resumeSessionId?.trim()) {
    args.push("--resume", options.resumeSessionId.trim());
  }
  args.push(options.prompt);

  return new Promise((resolve) => {
    let stderr = "";
    let lineBuf = "";
    let displayedAssistant = "";
    let resultText = "";
    let sessionId: string | undefined;
    let resultError: string | undefined;
    let exitCode: number | null = null;

    const flushLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      const rec = parsed as {
        type?: string;
        subtype?: string;
        session_id?: string;
        is_error?: boolean;
        result?: string;
      };
      if (typeof rec.session_id === "string" && rec.session_id.trim() !== "") {
        sessionId = rec.session_id.trim();
      }

      if (rec.type === "result") {
        if (rec.subtype === "success" && !rec.is_error) {
          resultText = String(rec.result ?? "").trim();
        } else {
          resultError = rec.is_error
            ? String(rec.result ?? "Cursor Agent error")
            : "Cursor Agent returned an error result.";
        }
        return;
      }

      const chunk = extractAssistantChunkText(parsed);
      if (chunk === null || !options.callbacks?.onAssistantDelta) {
        return;
      }
      const { deltas, nextDisplayed } = assistantTextToDeltas(displayedAssistant, chunk);
      displayedAssistant = nextDisplayed;
      for (const d of deltas) {
        if (d) {
          options.callbacks.onAssistantDelta(d);
        }
      }
    };

    const child = spawn(bin, args, {
      cwd,
      env: {
        ...process.env,
        NO_COLOR: "1",
        TERM: "dumb",
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      lineBuf += chunk;
      const parts = lineBuf.split("\n");
      lineBuf = parts.pop() ?? "";
      for (const part of parts) {
        flushLine(part);
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      resolve({ text: "", error: err instanceof Error ? err.message : String(err) });
    });
    child.on("close", (code) => {
      exitCode = code;
      if (lineBuf.trim()) {
        flushLine(lineBuf);
      }
      if (exitCode !== 0) {
        const detail =
          stripAnsi(stderr).trim() || `Cursor Agent exited with code ${exitCode ?? "unknown"}`;
        resolve({ text: "", error: detail, sessionId });
        return;
      }
      if (resultError) {
        resolve({ text: "", error: resultError, sessionId });
        return;
      }
      const text = resultText;
      if (!text) {
        resolve({
          text: "",
          error: "Cursor Agent finished without a result payload.",
          sessionId,
        });
        return;
      }
      resolve({ text, sessionId });
    });
  });
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[\d;?]*[ -/]*[@-~]/g, "");
}
