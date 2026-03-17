#!/usr/bin/env node
import { createInterface } from "node:readline";
import type { JsonRpcRequest, JsonRpcResponse } from "@stuart/shared";

const VERSION = "0.1.0";

function createResponse<TResult>(
  id: string,
  result?: TResult,
  error?: { code: number; message: string }
): JsonRpcResponse<TResult> {
  return {
    jsonrpc: "2.0",
    id,
    result,
    error
  };
}

async function handleRequest(
  request: JsonRpcRequest
): Promise<JsonRpcResponse<unknown>> {
  switch (request.method) {
    case "guest.health":
      return createResponse(request.id, {
        ok: true,
        version: VERSION,
        detail: "stuartd scaffold is running."
      });
    case "task.prepare":
    case "task.startCodex":
    case "task.stopCodex":
    case "task.diff":
    case "task.applyPreview":
    case "worker.start":
    case "worker.stop":
    case "index.build":
    case "index.search":
    case "artifact.export":
    case "browser.session.start":
    case "browser.session.stop":
      return createResponse(request.id, {
        accepted: true,
        method: request.method,
        note: "Method scaffolded; implementation still needs guest runtime wiring."
      });
    default:
      return createResponse(request.id, undefined, {
        code: -32601,
        message: `Unknown method: ${request.method}`
      });
  }
}

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

rl.on("line", async (line) => {
  if (!line.trim()) {
    return;
  }

  try {
    const request = JSON.parse(line) as JsonRpcRequest;
    const response = await handleRequest(request);
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown stuartd error";
    process.stdout.write(
      `${JSON.stringify(
        createResponse("unknown", undefined, { code: -32700, message })
      )}\n`
    );
  }
});
