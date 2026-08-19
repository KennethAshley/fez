import { createHash } from "node:crypto";
import type { BenchCase } from "./cases.js";

/**
 * Pure scoring + scorecard — no I/O, no router. The DittoBench lessons,
 * fez-shaped: selection accuracy with an explicit over-route count
 * (summoning an agent when "none" was right is routing's cardinal sin),
 * p50 latency over ROUTER-hit cases only (deterministic layers are
 * ~free and would flatter the number), and an input hash so a score
 * change always has an attributable cause: same hash = the model
 * drifted or luck; different hash = the inputs changed.
 */

export interface CaseResult {
  bench: BenchCase;
  got: string;
  pass: boolean;
  layer: "smalltalk" | "fleet" | "actor" | "router";
  ms: number;
}

export interface Summary {
  total: number;
  correct: number;
  accuracy: number;
  overRoutes: number; // expected none, router summoned someone
  underRoutes: number; // expected an agent, got none
  misRoutes: number; // wrong agent
  p50RouterMs: number;
  byCategory: Record<string, { correct: number; total: number }>;
}

export function summarize(results: CaseResult[]): Summary {
  const byCategory: Record<string, { correct: number; total: number }> = {};
  let correct = 0, overRoutes = 0, underRoutes = 0, misRoutes = 0;
  const routerTimes: number[] = [];
  for (const r of results) {
    const bucket = (byCategory[r.bench.category] ??= { correct: 0, total: 0 });
    bucket.total++;
    if (r.pass) {
      correct++;
      bucket.correct++;
    } else if (r.bench.expect.includes("none")) overRoutes++;
    else if (r.got === "none") underRoutes++;
    else misRoutes++;
    if (r.layer === "router") routerTimes.push(r.ms);
  }
  routerTimes.sort((a, b) => a - b);
  return {
    total: results.length,
    correct,
    accuracy: results.length ? correct / results.length : 0,
    overRoutes,
    underRoutes,
    misRoutes,
    p50RouterMs: routerTimes.length ? routerTimes[Math.floor(routerTimes.length / 2)] : 0,
    byCategory,
  };
}

/** SHA-256 over everything the router sees — tools + model id. */
export function hashInputs(tools: object[], model: string): string {
  return createHash("sha256").update(JSON.stringify({ tools, model })).digest("hex").slice(0, 12);
}

export interface HistoryEntry {
  /** Which roster produced this score — frozen and live are NOT comparable. */
  roster?: "frozen" | "live";
  ts: number;
  hash: string;
  model: string;
  accuracy: number;
  overRoutes: number;
  p50RouterMs: number;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function formatScorecard(s: Summary, model: string, hash: string, prev?: HistoryEntry): string {
  const lines: string[] = [];
  lines.push(`routing bench — ${model} · inputs ${hash}`);
  lines.push(`score ${s.correct}/${s.total} (${pct(s.accuracy)}) · over-routes ${s.overRoutes} · under-routes ${s.underRoutes} · mis-routes ${s.misRoutes} · router p50 ${s.p50RouterMs}ms`);
  if (prev) {
    const delta = s.accuracy - prev.accuracy;
    const arrow = delta > 0.001 ? "▲" : delta < -0.001 ? "▼" : "=";
    const drift = prev.hash === hash ? "same inputs" : `inputs CHANGED (was ${prev.hash})`;
    lines.push(`vs last run: ${arrow} ${pct(Math.abs(delta))} (${pct(prev.accuracy)} → ${pct(s.accuracy)}) · ${drift} · p50 ${prev.p50RouterMs}ms → ${s.p50RouterMs}ms`);
  }
  lines.push("");
  const width = Math.max(...Object.keys(s.byCategory).map((k) => k.length));
  for (const [category, b] of Object.entries(s.byCategory)) {
    const bar = "█".repeat(Math.round((b.correct / b.total) * 20)).padEnd(20, "·");
    lines.push(`${category.padEnd(width)}  ${bar}  ${b.correct}/${b.total}`);
  }
  return lines.join("\n");
}

export function formatFailures(results: CaseResult[], limit = 20): string {
  const failures = results.filter((r) => !r.pass);
  if (failures.length === 0) return "no failures 🎉";
  return failures
    .slice(0, limit)
    .map((r) => `✗ [${r.bench.category}] expected ${r.bench.expect.join("|")} got ${r.got} — "${r.bench.q}"`)
    .join("\n") + (failures.length > limit ? `\n… and ${failures.length - limit} more` : "");
}
