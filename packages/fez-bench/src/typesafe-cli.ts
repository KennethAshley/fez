import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { CASES, ROSTER } from "./cases.js";
import { formatFailures, formatScorecard, summarize } from "./core.js";
import { runBench, type RunOutput } from "./runner.js";
import { runTypeSafeBench } from "./typesafe.js";

const { values } = parseArgs({ options: {
  baseline: { type: "string" },
  output: { type: "string" },
  help: { type: "boolean" },
} });

if (values.help) {
  console.log("Usage: node --env-file=$HOME/.fez/typesafe.env packages/fez-bench/dist/typesafe-cli.js [--baseline URL] [--output report.json]");
  console.log("Runs public frozen fixtures only. TYPESAFE_API_KEY required; optional TYPESAFE_MODEL (pinned ID), TYPESAFE_TIMEOUT_MS (default 5000). No retries.");
  process.exit(0);
}

function score(output: RunOutput) {
  const summary = summarize(output.results);
  const times = output.results.filter((r) => r.layer === "router").map((r) => r.ms).sort((a, b) => a - b);
  const p95RouterMs = times.length ? times[Math.ceil(times.length * 0.95) - 1] : 0;
  console.log(formatScorecard(summary, output.model, output.hash));
  console.log(`router p95 ${p95RouterMs}ms · ${times.length} model calls`);
  console.log(formatFailures(output.results));
  return { ...summary, p95RouterMs };
}

try {
  const apiKey = process.env.TYPESAFE_API_KEY ?? "";
  if (!apiKey.trim()) throw new Error("Set TYPESAFE_API_KEY before running the live benchmark");
  console.log(`TypeSafe: ${CASES.length} public cases, frozen ${ROSTER.length}-agent roster; production routing unchanged.`);
  const candidate = await runTypeSafeBench(apiKey, ROSTER, CASES, {
    model: process.env.TYPESAFE_MODEL,
    timeoutMs: process.env.TYPESAFE_TIMEOUT_MS ? Number(process.env.TYPESAFE_TIMEOUT_MS) : undefined,
    onProgress: (done, total) => { if (done % 20 === 0) console.log(`TypeSafe ${done}/${total}`); },
  });
  const candidateSummary = score(candidate);
  const inputTokens = candidate.decisions.reduce((sum, d) => sum + d.inputTokens, 0);
  const outputTokens = candidate.decisions.reduce((sum, d) => sum + d.outputTokens, 0);
  const estimatedUsd = candidate.model === "jev-1.13.0" ? inputTokens * 0.042 / 1_000_000 : null;
  console.log(`usage: ${inputTokens} input / ${outputTokens} output tokens` +
    (estimatedUsd === null ? "" : ` · estimated $${estimatedUsd.toFixed(6)} at Sep 18 pricing`));
  // Persist the candidate before a potentially unavailable baseline is contacted.
  const report = { createdAt: new Date().toISOString(), roster: ROSTER,
    candidate: { ...candidate, summary: candidateSummary, inputTokens, outputTokens, estimatedUsd } };
  if (values.output) await writeFile(values.output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });

  if (values.baseline) {
    console.log("Running the same cases against the baseline router.");
    const baseline = await runBench(values.baseline.replace(/\/$/, ""), ROSTER, CASES,
      (done, total) => { if (done % 20 === 0) console.log(`baseline ${done}/${total}`); });
    const baselineSummary = score(baseline);
    console.log(`TypeSafe minus baseline: ${candidateSummary.correct - baselineSummary.correct} correct decisions; ` +
      `${candidateSummary.overRoutes - baselineSummary.overRoutes} unnecessary summons.`);
    if (values.output) await writeFile(values.output, JSON.stringify({ ...report,
      baseline: { ...baseline, summary: baselineSummary },
    }, null, 2) + "\n", { mode: 0o600 });
  }
  if (values.output) console.log(`Report: ${values.output}`);
} catch (error) {
  // Never print request headers, credentials, or provider response bodies.
  console.error(error instanceof Error ? error.message : "Routing comparison failed");
  process.exitCode = 1;
}
