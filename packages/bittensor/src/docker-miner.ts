import { execSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import type { MinerEntryPoint } from "./repo-inspector.js";

/**
 * Docker miner orchestrator.
 *
 * Given a cloned subnet repo and a detected miner entry point, this:
 *   1. Generates a Dockerfile tailored to the repo
 *   2. Builds the image
 *   3. Runs the container with wallet/netuid env vars
 *
 * Bittensor miners typically need:
 *   - WALLET_NAME, WALLET_HOTKEY, NETUID env vars
 *   - A registered hotkey on the subnet (handled by wallet.ts)
 *   - Sometimes GPU access (--gpus all)
 */

export interface MinerConfig {
  netuid: number;
  walletName: string;
  walletHotkey: string;
  axonPort?: number;
  useGpu?: boolean;
  extraEnv?: Record<string, string>;
}

export interface BuildResult {
  imageName: string;
  dockerfilePath: string;
  buildLog: string;
}

export interface RunResult {
  containerId: string;
  containerName: string;
  command: string;
  logStream: NodeJS.ReadableStream | null;
}

export class DockerMiner {
  private dockerAvailable: boolean;

  constructor() {
    this.dockerAvailable = this.checkDocker();
  }

  isAvailable(): boolean {
    return this.dockerAvailable;
  }

  /**
   * Generate a Dockerfile for the inspected repo.
   * If the repo already has a Dockerfile, we use that instead.
   */
  async buildImage(
    repoPath: string,
    miner: MinerEntryPoint,
    config: MinerConfig
  ): Promise<BuildResult> {
    if (!this.dockerAvailable) {
      throw new Error("Docker is not available. Install Docker Desktop or ensure the daemon is running.");
    }

    const imageName = `fez-miner-${config.netuid}-${Date.now()}`;
    let dockerfilePath: string;
    let buildLog = "";

    if (miner.hasDockerfile) {
      dockerfilePath = path.join(repoPath, "Dockerfile");
      buildLog = "Using existing Dockerfile from repo\n";
    } else {
      dockerfilePath = path.join(repoPath, "Dockerfile.fez");
      const dockerfile = this.generateDockerfile(miner, config);
      await fs.writeFile(dockerfilePath, dockerfile, "utf-8");
      buildLog = `Generated Dockerfile.fez\n`;
    }

    try {
      const output = execSync(`docker build -f ${dockerfilePath} -t ${imageName} .`, {
        cwd: repoPath,
        stdio: "pipe",
        timeout: 300_000, // 5 min build timeout
        encoding: "utf-8",
      });
      buildLog += output;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Docker build failed: ${msg}`, { cause: err });
    }

    return { imageName, dockerfilePath, buildLog };
  }

  /**
   * Start a miner container in detached mode.
   * The `docker run -d` command exits immediately after starting the container.
   */
  startMiner(imageName: string, config: MinerConfig): RunResult {
    if (!this.dockerAvailable) {
      throw new Error("Docker is not available");
    }

    const containerName = `fez-miner-${config.netuid}-${Date.now()}`;
    const envArgs: string[] = [];

    envArgs.push("-e", `WALLET_NAME=${config.walletName}`);
    envArgs.push("-e", `WALLET_HOTKEY=${config.walletHotkey}`);
    envArgs.push("-e", `NETUID=${config.netuid}`);
    envArgs.push("-e", `BT_NETWORK=finney`); // default to mainnet

    if (config.axonPort) {
      envArgs.push("-e", `AXON_PORT=${config.axonPort}`);
      envArgs.push("-p", `${config.axonPort}:${config.axonPort}`);
    }

    if (config.extraEnv) {
      for (const [k, v] of Object.entries(config.extraEnv)) {
        envArgs.push("-e", `${k}=${v}`);
      }
    }

    if (config.useGpu) {
      envArgs.push("--gpus", "all");
    }

    const args = ["run", "-d", "--name", containerName, ...envArgs, imageName];
    const cmd = `docker ${args.join(" ")}`;

    const containerId = execSync(cmd, {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 30_000,
    }).trim();

    return {
      containerId,
      containerName,
      command: cmd,
      logStream: null,
    };
  }

  /**
   * Stop a running miner container.
   */
  stopMiner(containerIdOrName: string): void {
    if (!this.dockerAvailable) return;
    try {
      execSync(`docker stop ${containerIdOrName}`, { stdio: "pipe" });
      execSync(`docker rm ${containerIdOrName}`, { stdio: "pipe" });
    } catch {
      // already stopped or doesn't exist
    }
  }

  /**
   * Get logs from a running container.
   */
  getLogs(containerIdOrName: string, lines = 100): string {
    if (!this.dockerAvailable) return "";
    try {
      return execSync(`docker logs --tail ${lines} ${containerIdOrName}`, {
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 10_000,
      });
    } catch {
      return "";
    }
  }

  /**
   * List running fez miner containers.
   */
  listRunningMiners(): Array<{ id: string; name: string; status: string; image: string }> {
    if (!this.dockerAvailable) return [];
    try {
      const output = execSync(
        `docker ps --filter "name=fez-miner-" --format "{{.ID}}|{{.Names}}|{{.Status}}|{{.Image}}"`,
        { stdio: "pipe", encoding: "utf-8", timeout: 10_000 }
      );
      return output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [id, name, status, image] = line.split("|");
          return { id, name, status, image };
        });
    } catch {
      return [];
    }
  }

  private generateDockerfile(miner: MinerEntryPoint, config: MinerConfig): string {
    const lines: string[] = [
      "FROM python:3.11-slim",
      "",
      "WORKDIR /app",
      "",
      "# System deps",
      "RUN apt-get update && apt-get install -y --no-install-recommends \\",
      "    build-essential \\",
      "    git \\",
      "    && rm -rf /var/lib/apt/lists/*",
      "",
      "# Copy repo",
      "COPY . /app",
      "",
    ];

    if (miner.hasRequirements) {
      lines.push(
        "# Install Python deps",
        "RUN pip install --no-cache-dir -r requirements.txt",
        ""
      );
    }

    // Always install bittensor
    lines.push(
      "# Bittensor SDK",
      "RUN pip install --no-cache-dir bittensor",
      ""
    );

    // GPU hint if requested
    if (config.useGpu) {
      lines.push(
        "# GPU support (uncomment if the subnet needs CUDA)",
        "# RUN pip install --no-cache-dir torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121",
        ""
      );
    }

    lines.push(
      "# Default command — overridden by docker run if needed",
      `CMD ["sh", "-c", "${miner.command} --wallet.name $WALLET_NAME --wallet.hotkey $WALLET_HOTKEY --netuid $NETUID"]`
    );

    return lines.join("\n");
  }

  private checkDocker(): boolean {
    try {
      execSync("docker info", { stdio: "pipe", timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
}
