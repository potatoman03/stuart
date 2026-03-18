import Dockerode from "dockerode";

export const SANDBOX_IMAGE = "stuart-sandbox:latest";

export class DockerClient {
  private docker: Dockerode;

  constructor() {
    this.docker = new Dockerode();
  }

  /** Check if Docker daemon is reachable */
  async isAvailable(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  /** Check if the sandbox image exists locally */
  async hasImage(): Promise<boolean> {
    try {
      const image = this.docker.getImage(SANDBOX_IMAGE);
      await image.inspect();
      return true;
    } catch {
      return false;
    }
  }

  /** Build the sandbox image from the Dockerfile in this package */
  async buildImage(dockerfilePath: string): Promise<void> {
    // Use dockerode to build from the directory containing the Dockerfile
    const stream = await this.docker.buildImage(
      { context: dockerfilePath, src: ["Dockerfile"] },
      { t: SANDBOX_IMAGE }
    );
    // Wait for build to complete
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Run a script inside a container, returning exit code and stderr */
  async runScript(opts: {
    language: "python" | "javascript";
    script: string;
    outputDir: string;
    sourcesDir?: string;
    timeoutMs: number;
    memoryMb: number;
    cpus: number;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const binds = [
      `${opts.outputDir}:/workspace/output:rw`,
    ];
    if (opts.sourcesDir) {
      binds.push(`${opts.sourcesDir}:/workspace/sources:ro`);
    }

    const cmd = opts.language === "python"
      ? ["python3", "-c", opts.script]
      : ["node", "--input-type=module", "-e", opts.script];

    const container = await this.docker.createContainer({
      Image: SANDBOX_IMAGE,
      Cmd: cmd,
      HostConfig: {
        Binds: binds,
        NetworkMode: "none",
        Memory: opts.memoryMb * 1024 * 1024,
        NanoCpus: opts.cpus * 1e9,
        AutoRemove: false,
      },
      User: "sandbox",
      WorkingDir: "/workspace",
      // Set a stop timeout so we can kill it
      StopTimeout: Math.ceil(opts.timeoutMs / 1000),
    });

    try {
      await container.start();

      // Wait for completion with timeout
      const waitPromise = container.wait();
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          container.kill().catch(() => {});
          reject(new Error(`Script execution timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      });

      const result = await Promise.race([waitPromise, timeoutPromise]);

      // Collect logs — Docker multiplexes stdout/stderr with 8-byte frame headers
      const logBuffer = await container.logs({ stdout: true, stderr: true, follow: false });
      const raw = Buffer.isBuffer(logBuffer) ? logBuffer : Buffer.from(String(logBuffer), "utf-8");
      let stdout = "";
      let stderr = "";
      let offset = 0;
      while (offset + 8 <= raw.length) {
        const streamType = raw[offset]!; // 1 = stdout, 2 = stderr
        const frameSize = raw.readUInt32BE(offset + 4);
        const frameData = raw.subarray(offset + 8, offset + 8 + frameSize).toString("utf-8");
        if (streamType === 2) {
          stderr += frameData;
        } else {
          stdout += frameData;
        }
        offset += 8 + frameSize;
      }

      return {
        exitCode: result.StatusCode,
        stdout,
        stderr,
      };
    } finally {
      try {
        await container.remove({ force: true });
      } catch {
        // Container may already be removed
      }
    }
  }

  /** Cleanup — no persistent state to clean in this implementation */
  async close(): Promise<void> {
    // Nothing to clean up — containers are removed after each run
  }
}
