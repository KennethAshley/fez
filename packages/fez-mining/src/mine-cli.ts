import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import * as path from "node:path";
import type { ConfigField } from "@fezchat/extension-api";

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
    const parsed = JSON.parse(statusJson);
    const list = Array.isArray(parsed) ? parsed : ((parsed?.miners as unknown[]) ?? []);
    return (list as Array<{ persona?: string }>).filter((m) => m.persona === persona);
  } catch {
    return [];
  }
}

export const mineArgs = {
  status: () => ["status", "--json"],
  metagraph: (persona: string, netuid: number) =>
    ["metagraph", "--netuid", String(netuid), "--persona", persona, "--json"],
  start: (persona: string, netuid: number, machine?: "local" | "lium" | "ssh") =>
    ["start", "--netuid", String(netuid), "--persona", persona,
      // ssh carries no host here: cmdStart preserves the recorded one.
      ...(machine === "lium" ? ["--machine", "lium"] : machine === "ssh" ? ["--machine", "ssh"] : [])],
  stop: (persona: string, netuid: number) =>
    ["stop", "--netuid", String(netuid), "--persona", persona],
  describe: (netuid: number) => ["describe", "--netuid", String(netuid), "--json"],
  configSet: (persona: string, netuid: number, key: string, value: string) =>
    ["config", "set", "--netuid", String(netuid), "--persona", persona, "--key", key, "--value", value],
};

/** Is `key` settable by a non-secret config path? Reads the subnet's declared
 *  ConfigField schema (from `fez-mine describe`). Secrets are refused so no key
 *  ever transits an LLM turn; unknown keys are refused so typos don't write junk. */
export function classifyConfigKey(schema: ConfigField[], key: string): "secret" | "unknown" | "ok" {
  const field = schema.find((f) => f.key === key);
  if (!field) return "unknown";
  if (field.type === "secret") return "secret";
  return "ok";
}
