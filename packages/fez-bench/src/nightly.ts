import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FezExtensionAPI, NostrEvent, ScheduledTaskContext } from "./api-types.js";
import { CASES, ROSTER } from "./cases.js";
import { formatFailures, summarize, type HistoryEntry } from "./core.js";
import { harvestedCases } from "./proposals.js";
import { runBench } from "./runner.js";

/**
 * The ambient half of the bench: it runs itself.
 *
 * Until now the loop was real but hand-cranked — someone had to remember
 * to run `fez bench`, notice the number moved, and go looking for why.
 * This puts it on the sentinel's scheduler: overnight the battery runs,
 * the score lands in history, and a REGRESSION is announced in a channel
 * with the failures that caused it.
 *
 * What it deliberately does NOT do: file a proposal itself. A bench can
 * prove the score dropped; it cannot know which line of a persona caused
 * it. So a regression @mentions the tuner agent, whose whole job is to
 * investigate and file a proposal — which then goes through the same
 * approve/deny ledger a human already uses. The machine reports, the
 * agent proposes, the owner decides. No step invents authority it
 * doesn't have.
 */

const HISTORY = path.join(os.homedir(), ".fez", "bench", "routing.jsonl");
/** A drop bigger than this is a regression worth waking someone for. */
const REGRESSION_DELTA = 0.02;
/** Below this, say so regardless of the delta — the fleet is misrouting. */
const FLOOR = Number(process.env.FEZ_BENCH_FLOOR ?? 0.75);

function lastEntry(): HistoryEntry | undefined {
  try {
    const lines = fs.readFileSync(HISTORY, "utf-8").trim().split("\n");
    return JSON.parse(lines[lines.length - 1]) as HistoryEntry;
  } catch {
    return undefined;
  }
}

function appendHistory(entry: HistoryEntry): void {
  fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
  fs.appendFileSync(HISTORY, JSON.stringify(entry) + "\n");
}

/** Resolve a channel by NAME so config stays human ("general", not a uuid). */
async function findChannel(
  nostr: ScheduledTaskContext["nostr"],
  wanted: string
): Promise<{ channelId: string; communityId: string } | undefined> {
  const events = (await nostr.query([{ kinds: [47101], limit: 300 }])) as NostrEvent[];
  const target = wanted.replace(/^#/, "").toLowerCase();
  for (const event of events) {
    const channelId = event.tags.find((t) => t[0] === "d")?.[1];
    const communityId = event.tags.find((t) => t[0] === "c")?.[1];
    if (!channelId || !communityId) continue;
    let name = channelId;
    try {
      name = (JSON.parse(event.content).name as string) ?? channelId;
    } catch { /* unnamed */ }
    if (name.toLowerCase() === target) return { channelId, communityId };
  }
  return undefined;
}

/** Is there an agent by this name we could hand the investigation to? */
async function findAgent(nostr: ScheduledTaskContext["nostr"], name: string): Promise<string | undefined> {
  const profiles = (await nostr.query([{ kinds: [47000], limit: 300 }])) as NostrEvent[];
  for (const profile of profiles.sort((a, b) => b.created_at - a.created_at)) {
    try {
      if ((JSON.parse(profile.content) as { name?: string }).name?.toLowerCase() === name) return profile.pubkey;
    } catch { /* not a profile */ }
  }
  return undefined;
}

export function registerNightlyBench(api: FezExtensionAPI): void {
  const base = (process.env.FEZ_ORCHESTRATOR_URL ?? "http://127.0.0.1:8080/v1").replace(/\/$/, "");
  const everyH = Math.max(1, Number(process.env.FEZ_BENCH_EVERY_H ?? 24));
  const channelName = process.env.FEZ_BENCH_CHANNEL ?? "general";
  const tunerName = (process.env.FEZ_BENCH_TUNER ?? "tuner").toLowerCase();

  api.registerScheduledTask("bench-nightly", everyH * 3_600_000, async ({ nostr }) => {
    const previous = lastEntry();
    // Don't re-run a battery that already ran this window (a sentinel
    // restart shouldn't mean a fresh 97-case run every boot).
    if (previous && Date.now() - previous.ts < everyH * 3_600_000 * 0.9) return;

    let output;
    try {
      output = await runBench(base, ROSTER, [...CASES, ...harvestedCases()]);
    } catch (err) {
      // Router down is the normal case on a laptop, not an incident.
      console.log(`📏 bench skipped: ${err instanceof Error ? err.message : err}`);
      return;
    }
    const summary = summarize(output.results);
    appendHistory({
      ts: Date.now(),
      hash: output.hash,
      model: output.model,
      accuracy: summary.accuracy,
      overRoutes: summary.overRoutes,
      p50RouterMs: summary.p50RouterMs,
    });

    const delta = previous ? summary.accuracy - previous.accuracy : 0;
    const regressed = (previous && delta <= -REGRESSION_DELTA) || summary.accuracy < FLOOR;
    const improved = previous && delta >= REGRESSION_DELTA;
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    console.log(`📏 bench: ${pct(summary.accuracy)}${previous ? ` (was ${pct(previous.accuracy)})` : ""}`);

    // Silence is the default. A nightly "still 77%" message every day
    // trains people to ignore the channel, which costs more than it says.
    if (!regressed && !improved) return;

    const where = await findChannel(nostr, channelName);
    if (!where) {
      console.log(`📏 nothing to report to — no channel named "${channelName}"`);
      return;
    }

    if (improved) {
      await nostr.publish({
        kind: 47103,
        tags: [["h", where.channelId], ["c", where.communityId], ["t", "bench-report"]],
        content:
          `📏 routing bench improved: ${pct(previous!.accuracy)} → ${pct(summary.accuracy)} ` +
          `(${summary.correct}/${summary.total}, p50 ${summary.p50RouterMs}ms). Whatever changed, it worked.`,
      });
      return;
    }

    const tunerPk = await findAgent(nostr, tunerName);
    const failures = formatFailures(output.results, 8);
    const headline = previous
      ? `📏 routing bench REGRESSED: ${pct(previous.accuracy)} → ${pct(summary.accuracy)}`
      : `📏 routing bench below floor: ${pct(summary.accuracy)} (floor ${pct(FLOOR)})`;
    await nostr.publish({
      kind: 47103,
      tags: [
        ["h", where.channelId],
        ["c", where.communityId],
        ["t", "bench-report"],
        ...(tunerPk ? [["p", tunerPk]] : []),
      ],
      content: [
        headline,
        `${summary.correct}/${summary.total} correct · ${summary.overRoutes} over-routes · p50 ${summary.p50RouterMs}ms · model ${output.model}`,
        "",
        failures,
        "",
        // Mention by NAME regardless of whether we know a pubkey: the
        // sentinel summons from the @name in the text, and an agent that
        // has never run has no profile to find. The p-tag is a bonus for
        // agents already awake, not the addressing mechanism.
        `@${tunerName} investigate these failures and file ONE proposal for the smallest change that would fix them: ` +
          `fez bench propose --agent <name> --description "<new description>" --why "<the evidence>". ` +
          `Do not apply anything — the owner approves or denies from the ledger.`,
      ].join("\n"),
    });
    console.log(`📏 regression reported to #${channelName}${tunerPk ? ` (@${tunerName} tagged)` : ""}`);
  });
}
