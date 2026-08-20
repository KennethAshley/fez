import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CASES } from "./cases.js";
import { formatFailures, formatScorecard, summarize, type HistoryEntry } from "./core.js";
import { harvest } from "./harvest.js";
import { approve, deny, formatLedger, harvestedCases, ledger, propose } from "./proposals.js";
import { casesFor, formatDrift, rosterDrift, rosterFor } from "./roster.js";
import { runBench } from "./runner.js";

/**
 * `node dist/cli.js` (or `npm run bench`) — run the battery, print the
 * scorecard + failures, append to ~/.fez/bench/routing.jsonl so the
 * next run diffs against this one. Exit code 1 below the floor, so CI
 * can gate on it.
 */

const BASE = (process.env.FEZ_ORCHESTRATOR_URL ?? "http://127.0.0.1:8080/v1").replace(/\/$/, "");
const RELAY = process.env.FEZ_RELAY ?? "ws://localhost:7777";

// ── subcommands: proposals | approve <id> | deny <id> | propose … | harvest
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "proposals") {
  console.log(formatLedger(ledger()));
  process.exit(0);
}
if (cmd === "approve" || cmd === "deny") {
  const id = rest[0];
  if (!id) {
    console.error(`usage: ${cmd} <id>`);
    process.exit(1);
  }
  try {
    console.log(cmd === "approve" ? `✓ ${approve(id)}` : (deny(id), `✗ ${id} denied (recorded)`));
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
  process.exit(0);
}
if (cmd === "propose") {
  const flag = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const agent = flag("agent");
  const rationale = flag("rationale") ?? "(no rationale given)";
  if (agent && flag("description")) {
    const personaPath = path.join(os.homedir(), ".fez", "personas", `${agent}.md`);
    const current = fs.existsSync(personaPath)
      ? /^description:\s*(.*)$/m.exec(fs.readFileSync(personaPath, "utf-8"))?.[1] ?? ""
      : "";
    const id = propose({ kind: "description", agent, from: current, to: flag("description")!, rationale });
    console.log(`⏳ proposal ${id} recorded — owner reviews with: proposals / approve ${id} / deny ${id}`);
  } else if (flag("case-q") && flag("case-expect")) {
    const id = propose({
      kind: "case",
      q: flag("case-q")!,
      expect: flag("case-expect")!.split(",").map((s) => s.trim()),
      rationale,
    });
    console.log(`⏳ case proposal ${id} recorded`);
  } else {
    console.error("usage: propose --agent <name> --description <text> --rationale <why>");
    console.error("       propose --case-q <text> --case-expect <name|none[,name]> --rationale <why>");
    process.exit(1);
  }
  process.exit(0);
}
if (cmd === "harvest") {
  const candidates = await harvest(RELAY);
  if (candidates.length === 0) {
    console.log("no route-then-punt traces found in the last 7 days");
    process.exit(0);
  }
  for (const candidate of candidates) {
    const id = propose({
      kind: "case",
      q: candidate.q,
      expect: [candidate.puntedTo],
      rationale: `harvested: routed to ${candidate.routedTo}, punted to ${candidate.puntedTo} (${new Date(candidate.ts).toLocaleString()})`,
    });
    console.log(`⏳ ${id} "${candidate.q.slice(0, 70)}" → ${candidate.puntedTo} (was routed to ${candidate.routedTo})`);
  }
  console.log(`\n${candidates.length} candidate(s) — review with: proposals / approve <id> / deny <id>`);
  process.exit(0);
}
const FLOOR = Number(process.env.FEZ_BENCH_FLOOR ?? 0.75);
const HISTORY = path.join(os.homedir(), ".fez", "bench", "routing.jsonl");

/**
 * The most recent run OF THE SAME ROSTER MODE. Comparing a live score
 * against a frozen one would report a "regression" that is really just
 * a different question being asked.
 */
function lastEntry(mode: "frozen" | "live"): HistoryEntry | undefined {
  try {
    const lines = fs.readFileSync(HISTORY, "utf-8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]) as HistoryEntry;
      if ((entry.roster ?? "frozen") === mode) return entry;
    }
  } catch { /* no history yet */ }
  return undefined;
}

const started = Date.now();
const allCases = [...CASES, ...harvestedCases()];
// --live measures the personas the runtime ACTUALLY routes on; the
// default frozen roster keeps scores comparable across machines.
const wantLive = process.argv.includes("--live") || process.env.FEZ_BENCH_ROSTER === "live";
const { roster, mode, note } = rosterFor(wantLive ? "live" : "frozen");
if (note) process.stdout.write(`  ${note}\n`);
if (mode === "frozen") {
  const drift = formatDrift(rosterDrift());
  if (drift) process.stdout.write(drift + "\n\n");
}
const { cases: runnableCases, skipped } = casesFor(roster, allCases);
process.stdout.write(
  `routing bench: ${runnableCases.length} cases (${allCases.length - CASES.length} harvested` +
    `${skipped > 0 ? `, ${skipped} skipped — expect agents this roster doesn't have` : ""}) · ` +
    `${mode} roster (${roster.length} agents) → ${BASE}\n`
);
const { results, model, hash } = await runBench(BASE, roster, runnableCases, (done, total) => {
  if (done % 20 === 0) process.stdout.write(`  …${done}/${total}\n`);
});
const summary = summarize(results);
const prev = lastEntry(mode);

console.log("\n" + formatScorecard(summary, model, hash, prev));
console.log("\n" + formatFailures(results));
console.log(`\n(${((Date.now() - started) / 1000).toFixed(1)}s total)`);

fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
const entry: HistoryEntry = {
  ts: Date.now(),
  roster: mode,
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
