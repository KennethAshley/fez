import { exec as cpExec } from "node:child_process";
import fs from "node:fs/promises";
import type { MinerMachine } from "@fezchat/extension-api";

/** The Mac itself, behind the seam: exec is a shell, copy is cp, no ports. */
export function localMachine(): MinerMachine {
  return {
    kind: "local",
    ports: [],
    exec(cmd, opts = {}) {
      return new Promise((resolve) => {
        cpExec(cmd, { env: { ...process.env, ...opts.env }, cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024 },
          (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
      });
    },
    async copy(localPath, remotePath) {
      await fs.cp(localPath, remotePath, { recursive: true });
    },
  };
}
