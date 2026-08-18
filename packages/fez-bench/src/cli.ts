import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CASES, ROSTER } from "./cases.js";
import { formatFailures, formatScorecard, summarize, type HistoryEntry } from "./core.js";
import { runBench } from "./runner.js";

/**
 * `node dist/cli.js` (or `npm run bench`) — run the battery, print the
 * scorecard + failures, append to ~/.fez/bench/routing.jsonl so the
 * next run diffs against this one. Exit code 1 below the floor, so CI
 * can gate on it.
 */

const BASE = (process.env.FEZ_ORCHESTRATOR_URL ?? "http://127.0.0.1:8080/v1").replace(/\/$/, "");
const FLOOR = Number(process.env.FEZ_BENCH_FLOOR ?? 0.75);
const HISTORY = path.join(os.homedir(), ".fez", "bench", "routing.jsonl");

function lastEntry(): HistoryEntry | undefined {
  try {
    const lines = fs.readFileSync(HISTORY, "utf-8").trim().split("\n");
    return JSON.parse(lines[lines.length - 1]) as HistoryEntry;
  } catch {
    return undefined;
  }
}

const started = Date.now();
process.stdout.write(`routing bench: ${CASES.length} cases → ${BASE}\n`);
const { results, model, hash } = await runBench(BASE, ROSTER, CASES, (done, total) => {
  if (done % 20 === 0) process.stdout.write(`  …${done}/${total}\n`);
});
const summary = summarize(results);
const prev = lastEntry();

console.log("\n" + formatScorecard(summary, model, hash, prev));
console.log("\n" + formatFailures(results));
console.log(`\n(${((Date.now() - started) / 1000).toFixed(1)}s total)`);

fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
const entry: HistoryEntry = {
  ts: Date.now(),
  hash,
  model,
  accuracy: summary.accuracy,
  overRoutes: summary.overRoutes,
  p50RouterMs: summary.p50RouterMs,
};
fs.appendFileSync(HISTORY, JSON.stringify(entry) + "\n");

if (summary.accuracy < FLOOR) {
  console.error(`\n✗ below floor (${Math.round(FLOOR * 100)}%)`);
  process.exit(1);
}
