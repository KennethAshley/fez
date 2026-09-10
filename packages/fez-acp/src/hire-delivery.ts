import fs from "node:fs";
import { execFileSync } from "node:child_process";

/** Deliver the completed checkout separately from running its coding engine. */
export function deliverHire(opts: {
  dir: string;
  branch: string;
  personaId: string;
  message: string;
  authHeader: () => string;
}): void {
  const git = (args: string[]) => execFileSync("git", args, {
    cwd: opts.dir, stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 120_000,
  });
  let step = "stage";
  try {
    git(["add", "-A"]);
    step = "commit";
    // Temporary agent commits never borrow the operator's interactive signing
    // identity. The push authenticates with the agent's own Nostr credential.
    git(["-c", "commit.gpgsign=false", "-c", `user.name=${opts.personaId}`, "-c", `user.email=${opts.personaId}@fez`, "commit", "-m", opts.message]);
    step = "push";
    git(["-c", "push.gpgsign=false", "-c", `http.extraHeader=${opts.authHeader()}`, "push", "origin", opts.branch]);
  } catch {
    // execFile errors include command arguments, including the auth header.
    throw new Error(`Git ${step} failed. Work preserved on worker at ${opts.dir} (branch ${opts.branch}). Retry delivery from this checkout; do not rerun the engine.`);
  }
  try { fs.rmSync(opts.dir, { recursive: true, force: true }); }
  catch { console.warn(`Branch delivered; local cleanup needed at ${opts.dir}`); }
}
