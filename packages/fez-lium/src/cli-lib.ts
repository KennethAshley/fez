import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * fez-lium CLI wrapper, as a library — the thin layer over the `lium`
 * binary (spawn, parse, ledger) with no MCP surface attached, so other
 * fez code (e.g. a machine-shaped extension) can drive Lium the same
 * way the skill does.
 */

export const EXEC_CAP = 20_000;

const pexecFile = promisify(execFile);

export const INSTALL =
  "the `lium` CLI isn't installed on this machine. With the human's OK, call lium_setup — " +
  "it downloads the official binary from Lium's GitHub releases (no shell scripts, no sudo).";

export const NO_KEY =
  "no valid Lium API key — the human adds one in SKILLS & SECRETS as LIUM_API_KEY " +
  "(from their lium.io dashboard). Agents don't create accounts.";

// The release tarball is a PyInstaller onedir: lium/lium beside lium/_internal.
export const FEZ_BIN = join(homedir(), ".fez", "lium", "bin", "lium", "lium");
export const exists = (p: string) => access(p).then(() => true, () => false);

/** The binary: the official installer's home, then ours, then PATH. */
export async function liumBin(): Promise<string> {
  if (await exists(join(homedir(), ".lium", "bin", "lium"))) return join(homedir(), ".lium", "bin", "lium");
  if (await exists(FEZ_BIN)) return FEZ_BIN;
  return "lium"; // PATH; ENOENT becomes the INSTALL message
}

/** Run `lium <args>`; returns stdout, or a human-shaped failure string. */
export async function lium(args: string[], timeoutMs = 60_000): Promise<{ ok: true; out: string } | { ok: false; err: string }> {
  try {
    const { stdout } = await pexecFile(await liumBin(), args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env },
    });
    return { ok: true, out: stdout };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    if (err.code === "ENOENT") return { ok: false, err: INSTALL };
    if (err.killed) return { ok: false, err: `lium ${args[0]} timed out after ${timeoutMs / 1000}s.` };
    // A refusal (e.g. `up` with no NODE_ID/filters) prints to STDOUT with a
    // non-zero exit — execFile still rejects, but err.stderr alone missed
    // it, swallowing the actual reason. Check stdout too.
    const detail = String(err.stderr || err.stdout || err.message).slice(0, 400);
    if (/unauthoriz|401|api.?key/i.test(detail)) return { ok: false, err: NO_KEY };
    return { ok: false, err: `lium ${args[0]} failed: ${detail}` };
  }
}

export function parseJson<T>(out: string): T | null {
  try { return JSON.parse(out) as T; } catch { return null; }
}

/** Node row shape per lium-cli ls/display.py compact_executor(). */
export function priceOf(row: Record<string, unknown>): number | null {
  const n = Number(row.price_per_hour);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function matchesNode(row: Record<string, unknown>, node: string): boolean {
  return ["index", "id", "huid"].some((k) => String(row[k] ?? "") === node);
}

// --- honest job rows: every up/rm/refusal, so "what did compute cost" has an answer ---
export const ROWS = join(homedir(), ".fez", "lium-pods.json");
export type Row = { id: string; at: string; action: "up" | "rm" | "refused"; node?: string; pod?: string; usdHour?: number; ttl?: string; detail?: string };
export async function record(row: Omit<Row, "id" | "at">): Promise<void> {
  try {
    await mkdir(join(homedir(), ".fez"), { recursive: true });
    const rows = parseJson<Row[]>(await readFile(ROWS, "utf8").catch(() => "[]")) ?? [];
    rows.push({ id: randomUUID(), at: new Date().toISOString(), ...row });
    await writeFile(ROWS, JSON.stringify(rows, null, 2));
  } catch { /* the ledger must never block the work */ }
}

export { parseTtl, checkUp, DEFAULT_MAX_USD_HOUR, DEFAULT_TTL, DEFAULT_MAX_TTL_HOURS } from "./guards.js";
