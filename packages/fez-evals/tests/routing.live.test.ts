import { describe, expect, test } from "vitest";
import { agentTool, isSmallTalk } from "../../fez-orchestrator/src/route-logic";

/**
 * LIVE routing accuracy against the orchestrator's real endpoint
 * (needle by default) — the ad-hoc curl batteries from development,
 * pinned. Models the orchestrator's actual pipeline: small talk
 * short-circuits, everything else goes to the router with the same
 * tool shapes the runtime builds. Skips (loudly) when no endpoint is
 * up, so unit gates still run offline.
 *
 * Threshold, not exactness: a 26M router is probabilistic at the
 * margins. 80% floors the measured baseline (needle scored 100% on
 * this set with job-title names + verb descriptions); dipping below
 * means names, descriptions, or the model regressed.
 */
const BASE = (process.env.FEZ_ORCHESTRATOR_URL ?? "http://127.0.0.1:8080/v1").replace(/\/$/, "");

const ROSTER = [
  { name: "researcher", about: "search the web, find papers and specs, look up github repositories and facts", skills: ["web-search", "github"] },
  { name: "reviewer", about: "review code, critique pull requests, give feedback on changes", skills: ["obsidian"] },
  { name: "deployer", about: "deploy and ship releases with docker", skills: ["docker"] },
];

const CASES: { q: string; expect: string }[] = [
  { q: "yo", expect: "none" },
  { q: "how are you?", expect: "none" },
  { q: "dig up recent papers on gossip protocols", expect: "researcher" },
  { q: "find the most starred nostr relay repos on github", expect: "researcher" },
  { q: "what does the NIP-44 spec say about nonce reuse", expect: "researcher" },
  { q: "review my relay.ts changes please", expect: "reviewer" },
  { q: "give feedback on the error handling in my PR", expect: "reviewer" },
  { q: "ship v0.2.0 to production", expect: "deployer" },
  { q: "deploy the latest build with docker", expect: "deployer" },
];

const model: string | null = await (async () => {
  try {
    const res = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(2500) });
    const body = (await res.json()) as { data?: { id: string }[] };
    return body.data?.[0]?.id ?? null;
  } catch {
    return null;
  }
})();

async function route(q: string): Promise<string> {
  if (isSmallTalk(q)) return "none";
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: q }], tools: ROSTER.map(agentTool) }),
  });
  const body = (await res.json()) as { choices?: { message?: { tool_calls?: { function?: { name?: string } }[] } }[] };
  return body.choices?.[0]?.message?.tool_calls?.[0]?.function?.name ?? "none";
}

describe.skipIf(model === null)(`live routing via ${BASE} (${model ?? "endpoint down"})`, () => {
  test("accuracy over the pinned battery ≥ 80%", { timeout: 180_000 }, async () => {
    const rows: string[] = [];
    let correct = 0;
    for (const c of CASES) {
      const got = await route(c.q);
      const pass = got === c.expect;
      if (pass) correct++;
      rows.push(`${pass ? "✓" : "✗"} ${c.expect.padEnd(11)} got ${got.padEnd(11)} "${c.q}"`);
    }
    const accuracy = correct / CASES.length;
    console.log(`\nrouting accuracy: ${correct}/${CASES.length} (${Math.round(accuracy * 100)}%)\n${rows.join("\n")}`);
    expect(accuracy).toBeGreaterThanOrEqual(0.8);
  });
});

if (model === null) {
  console.warn(`⚠️  routing evals skipped — no router at ${BASE} (start: cactus serve ~/.cache/cactus/weights/needle-prebuilt --no-cloud-handoff --no-cloud-tele)`);
}
