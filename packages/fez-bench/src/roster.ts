import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROSTER, type BenchCase, type RosterAgent } from "./cases.js";

/**
 * Where the bench's roster comes from — and why there are two answers.
 *
 * FROZEN (cases.ts): a pinned roster so a score means the same thing
 * across machines and across months. That's what makes "77% → 72%" a
 * sentence about the ROUTER rather than about whoever edited a persona
 * last week.
 *
 * LIVE (~/.fez/personas/*.md): the descriptions the runtime actually
 * routes on right now. This is what the self-improvement loop needs:
 * approving a description proposal rewrites a persona file, and if the
 * bench only ever measures the frozen literal, the loop can never see
 * its own fix land. (The tuner caught exactly this — approve changed
 * the runtime and the number never moved.)
 *
 * Both are legitimate; mixing them silently is not. Every run records
 * which mode it used, and comparisons only happen within a mode.
 */

export type RosterMode = "frozen" | "live";

const PERSONA_DIR = path.join(os.homedir(), ".fez", "personas");

/** Personas the bench can route to: name + description from frontmatter. */
export function loadLiveRoster(dir = PERSONA_DIR): RosterAgent[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const roster: RosterAgent[] = [];
  for (const file of files.sort()) {
    const name = path.basename(file, ".md").toLowerCase();
    let content: string;
    try {
      content = fs.readFileSync(path.join(dir, file), "utf-8");
    } catch {
      continue;
    }
    // routable:false agents are never delegated to by the router, so
    // including them in the bench roster would measure a choice the
    // runtime never actually offers.
    if (/^routable:\s*false\s*$/mi.test(content)) continue;
    const description = /^description:\s*(.+)$/m.exec(content)?.[1]?.trim();
    // A persona with no description can't be routed to on merit — the
    // router would only ever see a bare name. Skipping it is honest;
    // inventing a description for it would silently change the test.
    if (!description) continue;
    const skills = /^mcpServers:\s*\[([^\]]*)\]/m
      .exec(content)?.[1]
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    roster.push({ name, about: description, skills: skills ?? [] });
  }
  return roster;
}

export interface RosterDrift {
  /** In the frozen roster, absent (or description-changed) live. */
  changed: { name: string; frozen: string; live?: string }[];
  /** Live personas the frozen battery never exercises. */
  untested: string[];
}

/**
 * Where the pinned roster and reality disagree. This is the drift the
 * tuner reported: cases.ts is hand-mirrored from persona files, so the
 * two silently diverge and nobody finds out until a fix "doesn't work".
 */
export function rosterDrift(live: RosterAgent[] = loadLiveRoster(), frozen: RosterAgent[] = ROSTER): RosterDrift {
  const liveByName = new Map(live.map((agent) => [agent.name, agent]));
  const changed = frozen
    .filter((agent) => liveByName.get(agent.name)?.about !== agent.about)
    .map((agent) => ({ name: agent.name, frozen: agent.about, live: liveByName.get(agent.name)?.about }));
  const frozenNames = new Set(frozen.map((agent) => agent.name));
  return { changed, untested: live.filter((agent) => !frozenNames.has(agent.name)).map((agent) => agent.name) };
}

export function formatDrift(drift: RosterDrift): string {
  if (drift.changed.length === 0 && drift.untested.length === 0) return "";
  const lines = ["⚠ bench roster has drifted from your personas — a frozen-mode score won't reflect these:"];
  for (const entry of drift.changed) {
    lines.push(`  ${entry.name}: ${entry.live ? "live differs" : "NO persona file"}`);
    lines.push(`    frozen: ${entry.frozen}`);
    if (entry.live) lines.push(`    live:   ${entry.live}`);
  }
  if (drift.untested.length > 0) lines.push(`  never benched: ${drift.untested.join(", ")}`);
  lines.push("  run with --live to measure what the runtime actually routes on.");
  return lines.join("\n");
}

/**
 * Drop cases the roster CANNOT satisfy. A case expecting "deployer"
 * when no deployer exists isn't a routing failure — it's an
 * unanswerable question, and counting it as a miss makes a live score
 * look like a catastrophe (measured: 51% vs 77%, almost entirely from
 * cases naming agents that don't exist here). "none" cases always stay:
 * refusing to route is answerable by any roster.
 */
export function casesFor(roster: RosterAgent[], cases: BenchCase[]): { cases: BenchCase[]; skipped: number } {
  const names = new Set(roster.map((agent) => agent.name));
  const usable = cases.filter((bench) => bench.expect.some((name) => name === "none" || names.has(name)));
  return { cases: usable, skipped: cases.length - usable.length };
}

/** Resolve the roster for a run, falling back loudly rather than silently. */
export function rosterFor(mode: RosterMode): { roster: RosterAgent[]; mode: RosterMode; note?: string } {
  if (mode === "frozen") return { roster: ROSTER, mode };
  const live = loadLiveRoster();
  if (live.length === 0) {
    return { roster: ROSTER, mode: "frozen", note: "no personas with descriptions found — fell back to the frozen roster" };
  }
  return { roster: live, mode: "live" };
}
