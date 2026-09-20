import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Why did pi return nothing? A bodiless provider refusal (seen live: Chutes
 * 402 with no body) never reaches stderr — pi records it in its own session
 * log and the bridge hands the agent an empty reply. The agent then retried
 * a billing failure three times as "provider down" while the owner waited.
 * This reads the newest session log for that agent's working directory and
 * returns the last provider error written in the last few minutes, so the
 * failure classifies as what it is and the escalation can name the fix.
 */
const RECENT_MS = 10 * 60_000;

/** pi names a session directory after the cwd: "/a/b" → "--a-b--". */
export function piSessionDir(workDir: string, home = os.homedir()): string {
  return path.join(home, ".pi", "agent", "sessions", `-${workDir.replace(/\//g, "-")}--`);
}

export function piSessionError(workDir: string, now = Date.now(), home = os.homedir()): string | undefined {
  try {
    const dir = piSessionDir(workDir, home);
    const newest = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .filter((x) => x.mtime <= now + 1_000) // "newest as of now" — lets a replay at a past instant see what the agent saw then
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (!newest || now - newest.mtime > RECENT_MS) return undefined;
    const lines = fs.readFileSync(path.join(dir, newest.f), "utf8").trim().split("\n").slice(-40);
    for (const line of lines.reverse()) {
      const hit = line.match(/"errorMessage":"((?:[^"\\]|\\.)*)"/);
      if (hit) return JSON.parse(`"${hit[1]}"`).slice(0, 300);
    }
    return undefined;
  } catch {
    return undefined;
  }
}
