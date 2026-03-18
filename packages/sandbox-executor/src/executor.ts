import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DockerClient, SANDBOX_IMAGE } from "./docker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ExecuteScriptInput {
  language: "python" | "javascript";
  script: string;
  outputFilename: string;
  taskId: string;
  timeoutMs?: number;
  sourcesDir?: string;
  /** Explicit output directory. If set, overrides the default (outputRoot/taskId). */
  outputDir?: string;
}

export interface ExecuteScriptResult {
  success: boolean;
  outputPath?: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export class SandboxExecutor {
  private readonly client: DockerClient;
  private readonly outputRoot: string;
  private imageReady = false;
  private available: boolean | null = null;

  constructor(opts: { outputRoot: string }) {
    this.client = new DockerClient();
    this.outputRoot = opts.outputRoot;
  }

  /** Check if Docker daemon is reachable (cached after first check) */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    this.available = await this.client.isAvailable();
    return this.available;
  }

  /** Ensure the sandbox Docker image is built and ready */
  async ensureImageReady(): Promise<void> {
    if (this.imageReady) return;
    if (!(await this.isAvailable())) {
      throw new Error("Docker is not available");
    }

    const hasImage = await this.client.hasImage();
    if (!hasImage) {
      // Build from the Dockerfile in this package
      const dockerfileDir = join(__dirname, "..");
      // In dist, go up one more level to reach the package root
      const packageRoot = join(__dirname, "..", "..");
      const candidates = [dockerfileDir, packageRoot];

      let built = false;
      for (const dir of candidates) {
        try {
          await this.client.buildImage(dir);
          built = true;
          break;
        } catch {
          continue;
        }
      }
      if (!built) {
        throw new Error(`Failed to build sandbox image. Ensure Dockerfile exists in the sandbox-executor package.`);
      }
    }
    this.imageReady = true;
  }

  /** Execute a script in a sandboxed Docker container */
  async executeScript(input: ExecuteScriptInput): Promise<ExecuteScriptResult> {
    const {
      language,
      script,
      outputFilename,
      taskId,
      timeoutMs = 60_000,
      sourcesDir,
      outputDir: explicitOutputDir,
    } = input;

    const outputDir = explicitOutputDir ?? join(this.outputRoot, taskId);
    await mkdir(outputDir, { recursive: true });

    const start = Date.now();
    try {
      const result = await this.client.runScript({
        language,
        script,
        outputDir,
        sourcesDir,
        timeoutMs,
        memoryMb: 512,
        cpus: 1,
      });

      const durationMs = Date.now() - start;
      const outputPath = join(outputDir, outputFilename);

      // Check if the output file was created
      const { existsSync } = await import("node:fs");
      const success = result.exitCode === 0 && existsSync(outputPath);

      return {
        success,
        outputPath: success ? outputPath : undefined,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs,
      };
    } catch (err) {
      return {
        success: false,
        stdout: "",
        stderr: String(err),
        exitCode: -1,
        durationMs: Date.now() - start,
      };
    }
  }

  /** Cleanup resources */
  async close(): Promise<void> {
    await this.client.close();
  }
}
