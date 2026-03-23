import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { buildCodexCommandArgs, resolveCodexCommandConfig } from "./codex-command.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id: string;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
};

const DEFAULT_RPC_TIMEOUT_MS = Number(process.env.STUART_CODEX_RPC_TIMEOUT_MS ?? 20_000);

type SocketLike = {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
};

interface CodexAppServerClientOptions {
  binaryPath?: string;
  onNotification: (notification: JsonRpcNotification) => void;
  onServerRequest: (request: JsonRpcRequest) => Promise<unknown> | unknown;
  onStderr?: (chunk: string) => void;
}

export class CodexAppServerClient {
  private readonly binaryPath: string;
  private readonly binaryArgsPrefix: string[];
  private readonly binaryEnv: NodeJS.ProcessEnv;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly onNotification: CodexAppServerClientOptions["onNotification"];
  private readonly onServerRequest: CodexAppServerClientOptions["onServerRequest"];
  private readonly onStderr?: CodexAppServerClientOptions["onStderr"];
  private child?: ChildProcess;
  private socket?: SocketLike;
  private readyPromise?: Promise<void>;
  private requestCounter = 0;
  private lastActivityAt = Date.now();
  private reconnecting = false;

  constructor(options: CodexAppServerClientOptions) {
    const command = resolveCodexCommandConfig(options.binaryPath);
    this.binaryPath = command.binaryPath;
    this.binaryArgsPrefix = command.argsPrefix;
    this.binaryEnv = command.env;
    this.onNotification = options.onNotification;
    this.onServerRequest = options.onServerRequest;
    this.onStderr = options.onStderr;
  }

  /** Track that we received activity from the server. */
  private markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  /** Seconds since last activity from the server. */
  get idleSeconds(): number {
    return Math.floor((Date.now() - this.lastActivityAt) / 1000);
  }

  /** Returns true if the connection appears healthy. */
  get isConnected(): boolean {
    return this.socket !== undefined && this.child !== undefined;
  }

  async ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.start();
    }

    try {
      await this.readyPromise;
    } catch (error) {
      this.readyPromise = undefined;
      throw error;
    }
  }

  /**
   * Tear down the current connection and start a fresh one.
   * Rejects all in-flight requests. Callers should re-issue any needed requests.
   */
  async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      process.stderr.write("[stuart] reconnecting codex app-server...\n");
      await this.close();
      this.readyPromise = this.start();
      await this.readyPromise;
      process.stderr.write("[stuart] codex app-server reconnected.\n");
    } finally {
      this.reconnecting = false;
    }
  }

  async request<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    await this.ensureReady();
    return this.requestInternal(method, params);
  }

  private requestInternal<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    const id = String(++this.requestCounter);
    const responsePromise = new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for codex app-server response to ${method}.`));
      }, DEFAULT_RPC_TIMEOUT_MS);
      timeout.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timeout);
          reject(reason);
        },
      });
    });

    this.send({
      jsonrpc: "2.0",
      id,
      method,
      params
    });

    return responsePromise;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.ensureReady();
    this.send({
      jsonrpc: "2.0",
      method,
      params
    });
  }

  async close(): Promise<void> {
    this.readyPromise = undefined;
    this.failAll(new Error("codex app-server client is closing."));

    try {
      this.socket?.close();
    } catch {
      // Ignore socket shutdown errors during teardown.
    }
    this.socket = undefined;

    const child = this.child;
    this.child = undefined;
    if (!child) {
      return;
    }

    await new Promise<void>((resolve) => {
      const finish = () => resolve();
      child.once("exit", finish);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        resolve();
      }, 2000).unref();
    });
  }

  private async start(): Promise<void> {
    const port = await reservePort();
    const child = spawn(
      this.binaryPath,
      buildCodexCommandArgs({ argsPrefix: this.binaryArgsPrefix }, [
        "app-server",
        "--listen",
        `ws://127.0.0.1:${port}`
      ]),
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...this.binaryEnv,
        }
      }
    );

    this.child = child;

    child.stderr.on("data", (chunk: Buffer) => {
      this.onStderr?.(chunk.toString("utf8"));
    });

    child.on("error", (error) => {
      this.failAll(error);
      this.readyPromise = undefined;
    });

    child.on("exit", (code, signal) => {
      const reason =
        code === 0
          ? "codex app-server exited."
          : `codex app-server stopped unexpectedly (code=${code}, signal=${signal}).`;
      this.failAll(new Error(reason));
      this.child = undefined;
      this.socket = undefined;
      this.readyPromise = undefined;
    });

    const socket = await openWebSocket(`ws://127.0.0.1:${port}`, child);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      void this.handleIncoming(event);
    });
    socket.addEventListener("close", () => {
      this.failAll(new Error("Connection to codex app-server closed."));
      this.socket = undefined;
      this.readyPromise = undefined;
    });
    socket.addEventListener("error", () => {
      this.failAll(new Error("Connection to codex app-server failed."));
      this.socket = undefined;
      this.readyPromise = undefined;
    });

    await this.requestInternal("initialize", {
      clientInfo: {
        name: "stuart-local",
        title: "Stuart",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.send({
      jsonrpc: "2.0",
      method: "initialized"
    });
  }

  private send(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (!this.socket) {
      throw new Error("codex app-server is not connected.");
    }

    this.socket.send(JSON.stringify(message));
  }

  private async handleIncoming(event: unknown): Promise<void> {
    const raw = extractMessageData(event);
    if (!raw) {
      return;
    }

    this.markActivity();
    const parsed = JSON.parse(raw) as JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

    if ("method" in parsed && "id" in parsed) {
      try {
        const result = await this.onServerRequest(parsed);
        this.send({
          jsonrpc: "2.0",
          id: parsed.id,
          result: result ?? null
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown server request error";
        this.send({
          jsonrpc: "2.0",
          id: parsed.id,
          error: {
            code: -32000,
            message
          }
        } as JsonRpcResponse);
      }
      return;
    }

    if ("method" in parsed) {
      this.onNotification(parsed);
      return;
    }

    if ("id" in parsed) {
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }

      this.pending.delete(parsed.id);
      if (parsed.error) {
        pending.reject(new Error(parsed.error.message ?? "App Server request failed."));
        return;
      }

      pending.resolve(parsed.result);
    }
  }

  private failAll(error: unknown): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function reservePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to reserve a local port for codex app-server."));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function openWebSocket(
  url: string,
  child: ChildProcess,
  timeoutMs = 10000
): Promise<SocketLike> {
  const WebSocketConstructor = (globalThis as { WebSocket?: new (url: string) => unknown })
    .WebSocket;
  if (!WebSocketConstructor) {
    throw new Error("WebSocket is not available in this Node runtime.");
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`codex app-server exited before it accepted ${url}.`);
    }

    const socket = new WebSocketConstructor(url) as SocketLike;
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out opening ${url}.`));
        }, 1000);

        socket.addEventListener("open", () => {
          clearTimeout(timeout);
          resolve();
        });
        socket.addEventListener("error", () => {
          clearTimeout(timeout);
          reject(new Error(`Failed to open ${url}.`));
        });
      });
      return socket;
    } catch {
      socket.close();
      await delay(100);
    }
  }

  throw new Error(`Timed out connecting to ${url}.`);
}

function extractMessageData(event: unknown): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const data = Reflect.get(event, "data");
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  return data == null ? null : String(data);
}
