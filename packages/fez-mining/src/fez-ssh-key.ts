import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fezHome } from "./state.js";

/**
 * fez's own machine identity: one ed25519 pair in ~/.fez/ssh, its public
 * half injected into every fez-provisioned machine via cloud-init. The
 * user's cloud-account keys are never touched.
 */
export async function ensureFezSshKey(home = fezHome()): Promise<{ keyPath: string; publicKey: string }> {
  const dir = path.join(home, "ssh");
  const keyPath = path.join(dir, "fez_ed25519");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.access(keyPath);
  } catch {
    await new Promise<void>((resolve, reject) =>
      execFile("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "fez", "-f", keyPath], (e) =>
        e ? reject(e) : resolve()
      )
    );
  }
  await fs.chmod(keyPath, 0o600);
  const publicKey = (await fs.readFile(`${keyPath}.pub`, "utf8")).trim();
  return { keyPath, publicKey };
}
