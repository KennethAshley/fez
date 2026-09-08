import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import * as path from "node:path";

/** Absolute path to the installed fez-mine — never trust PATH (mirrors
 *  WALLET_BIN/resolveBin in cli.ts; the MCP server is spawned by the
 *  harness with an env we don't control). */
const MINE_BIN = process.env.FEZ_MINE_BIN || path.join(homedir(), ".fez", "bin", "fez-mine");

export function runMine(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(MINE_BIN, args, { encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(err) };
  }
}

/** Filter `fez-mine status --json` down to one persona's miners; tolerant
 *  of malformed output (returns []). */
export function minersForPersona(statusJson: string, persona: string): unknown[] {
  try {
    const parsed = JSON.parse(statusJson) as { miners?: Array<{ persona?: string }> };
    return (parsed.miners ?? []).filter((m) => m.persona === persona);
  } catch {
    return [];
  }
}

export const mineArgs = {
  status: () => ["status", "--json"],
  metagraph: (persona: string, netuid: number) =>
    ["metagraph", "--netuid", String(netuid), "--persona", persona, "--json"],
  start: (persona: string, netuid: number, machine?: "local" | "lium") =>
    ["start", "--netuid", String(netuid), "--persona", persona,
      ...(machine === "lium" ? ["--machine", "lium"] : [])],
  stop: (persona: string, netuid: number) =>
    ["stop", "--netuid", String(netuid), "--persona", persona],
};
