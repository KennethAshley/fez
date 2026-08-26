import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The real fez-relay binary, spawned for one spec run — mirrors
 * packages/fez-evals/tests/cold-start-bootstrap.test.ts's spawnRelay
 * (same store-dir-per-run, same NIP-11 ready-wait), except this one is
 * built for a browser test: async (resolves once the relay actually
 * answers), and takes an optional `--owner` so the relay arrives
 * CLAIMED — the app's real NIP-11 fetch during client.start() is what
 * makes `client.state.isOwner(pubkey)` true, not a mock.
 */
const CLI = path.resolve(__dirname, "../../../../fez-relay/dist/cli.js");
const REPO_ROOT = path.resolve(__dirname, "../../../../..");

function ensureBuilt(): void {
  if (fs.existsSync(CLI)) return;
  const result = spawnSync("npm", ["run", "build", "--prefix", "packages/fez-relay"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("fez-relay build failed — run `npm run build --prefix packages/fez-relay` manually");
  }
}

async function waitForNip11(port: number): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const ok = await fetch(`http://127.0.0.1:${port}`, { headers: { Accept: "application/nostr+json" } })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`relay never came up on port ${port}`);
}

export interface SpawnedRelay {
  url: string;
  kill: () => void;
}

export async function spawnRelay(port: number, opts: { owner?: string; name?: string } = {}): Promise<SpawnedRelay> {
  ensureBuilt();
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fez-e2e-relay-")), "events.jsonl");
  const args = [CLI, "--port", String(port), "--store", store, "--name", opts.name ?? "e2e workspace"];
  if (opts.owner) args.push("--owner", opts.owner);
  const child: ChildProcess = spawn("node", args, { stdio: "ignore" });
  await waitForNip11(port);
  return {
    url: `ws://127.0.0.1:${port}`,
    kill: () => child.kill(),
  };
}
