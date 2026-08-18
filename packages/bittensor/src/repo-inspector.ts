import { execSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";

/**
 * Repo inspector: clones a Bittensor subnet repo and finds miner entry points.
 *
 * Bittensor subnets follow loose conventions but the common patterns are:
 *   - neurons/miner.py      (most common)
 *   - miner/miner.py
 *   - miner.py at repo root
 *   - src/miner.py
 *
 * We also extract README content and requirements for Docker image building.
 */

export interface MinerEntryPoint {
  /** Relative path from repo root to the miner script */
  scriptPath: string;
  /** Python entry command, e.g. "python neurons/miner.py" */
  command: string;
  /** Whether a requirements.txt or setup.py was found */
  hasRequirements: boolean;
  /** Whether the repo has a Dockerfile already */
  hasDockerfile: boolean;
  /** README.md content (first 2000 chars) */
  readmeSnippet: string;
  /** Detected Python version hint from README or setup.py */
  pythonVersion?: string;
}

export interface InspectResult {
  repoUrl: string;
  localPath: string;
  miner: MinerEntryPoint | null;
  allCandidates: MinerEntryPoint[];
  error?: string;
}

const CANDIDATE_PATTERNS = [
  { path: "neurons/miner.py", cmd: "python neurons/miner.py" },
  { path: "miner/miner.py", cmd: "python miner/miner.py" },
  { path: "miner.py", cmd: "python miner.py" },
  { path: "src/miner.py", cmd: "python src/miner.py" },
  { path: "miners/miner.py", cmd: "python miners/miner.py" },
  { path: "bittensor_subnet/miner.py", cmd: "python bittensor_subnet/miner.py" },
];

export class RepoInspector {
  private workDir: string;

  constructor(workDir?: string) {
    this.workDir = workDir || path.join(os.tmpdir(), "fez-bittensor-repos");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.workDir, { recursive: true });
  }

  /**
   * Clone a repo (shallow) and inspect it for miner entry points.
   */
  async inspect(repoUrl: string): Promise<InspectResult> {
    await this.init();

    const repoName = this.sanitizeRepoName(repoUrl);
    const localPath = path.join(this.workDir, repoName);

    // Clean up previous clone
    await fs.rm(localPath, { recursive: true, force: true }).catch(() => {});

    try {
      execSync(`git clone --depth 1 ${repoUrl} ${localPath}`, {
        stdio: "pipe",
        timeout: 60_000,
      });
    } catch (err) {
      return {
        repoUrl,
        localPath,
        miner: null,
        allCandidates: [],
        error: `git clone failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return this.analyzeRepo(repoUrl, localPath);
  }

  private async analyzeRepo(repoUrl: string, localPath: string): Promise<InspectResult> {
    const candidates: MinerEntryPoint[] = [];
    let hasRequirements = false;
    let hasDockerfile = false;
    let readmeSnippet = "";

    try {
      hasRequirements = await this.fileExists(path.join(localPath, "requirements.txt"));
      hasDockerfile = await this.fileExists(path.join(localPath, "Dockerfile"));

      // Read README for context
      const readmePaths = ["README.md", "README.txt", "README.rst", "readme.md"];
      for (const rp of readmePaths) {
        const full = path.join(localPath, rp);
        if (await this.fileExists(full)) {
          const content = await fs.readFile(full, "utf-8");
          readmeSnippet = content.slice(0, 2000);
          break;
        }
      }

      // Check known patterns
      for (const pattern of CANDIDATE_PATTERNS) {
        const fullPath = path.join(localPath, pattern.path);
        if (await this.fileExists(fullPath)) {
          candidates.push({
            scriptPath: pattern.path,
            command: pattern.cmd,
            hasRequirements,
            hasDockerfile,
            readmeSnippet,
          });
        }
      }

      // Fallback: look for any *miner*.py in the repo
      if (candidates.length === 0) {
        const found = await this.findFiles(localPath, /miner.*\.py$/i);
        for (const relPath of found) {
          candidates.push({
            scriptPath: relPath,
            command: `python ${relPath}`,
            hasRequirements,
            hasDockerfile,
            readmeSnippet,
          });
        }
      }
    } catch (err) {
      return {
        repoUrl,
        localPath,
        miner: null,
        allCandidates: [],
        error: `analysis failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return {
      repoUrl,
      localPath,
      miner: candidates[0] || null,
      allCandidates: candidates,
    };
  }

  /**
   * Extract mining instructions from README text.
   * Looks for common Bittensor patterns: btcli commands, python miner, etc.
   */
  extractMiningInstructions(readme: string): string[] {
    const lines = readme.split("\n");
    const instructions: string[] = [];
    let inCodeBlock = false;
    let codeBlockLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith("```")) {
        if (inCodeBlock && codeBlockLines.length > 0) {
          const block = codeBlockLines.join("\n");
          if (this.looksLikeMiningCommand(block)) {
            instructions.push(block);
          }
        }
        inCodeBlock = !inCodeBlock;
        codeBlockLines = [];
        continue;
      }

      if (inCodeBlock) {
        codeBlockLines.push(line);
        continue;
      }

      // Single-line heuristics
      if (this.looksLikeMiningCommand(trimmed) && trimmed.length > 10) {
        instructions.push(trimmed);
      }
    }

    // Deduplicate
    return [...new Set(instructions)];
  }

  private looksLikeMiningCommand(text: string): boolean {
    const lower = text.toLowerCase();
    return (
      lower.includes("miner.py") ||
      lower.includes("python miner") ||
      lower.includes("python3 miner") ||
      lower.includes("btcli subnet register") ||
      lower.includes("btcli stake") ||
      lower.includes("--netuid") ||
      lower.includes("pip install -r requirements") ||
      lower.includes("pip install bittensor")
    );
  }

  private async fileExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async findFiles(dir: string, pattern: RegExp, depth = 0, maxDepth = 4): Promise<string[]> {
    if (depth > maxDepth) return [];
    const results: string[] = [];

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return results;
    }

    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const fullPath = path.join(dir, entry);
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat) continue;

      if (stat.isDirectory()) {
        const sub = await this.findFiles(fullPath, pattern, depth + 1, maxDepth);
        results.push(...sub.map((s) => path.join(entry, s)));
      } else if (pattern.test(entry)) {
        results.push(entry);
      }
    }

    return results;
  }

  private sanitizeRepoName(url: string): string {
    return url
      .replace(/^https?:\/\//, "")
      .replace(/\.git$/, "")
      .replace(/[^a-zA-Z0-9_-]/g, "_");
  }
}
