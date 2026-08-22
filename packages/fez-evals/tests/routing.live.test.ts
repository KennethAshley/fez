import { describe, expect, test } from "vitest";
import { agentTool, isSmallTalk, routerBody, detectProfile } from "../../fez-orchestrator/src/route-logic.js";

/**
 * LIVE routing accuracy against the orchestrator's real endpoint — the
 * ad-hoc curl batteries from development, pinned. Models the
 * orchestrator's ACTUAL pipeline: small talk short-circuits, and
 * everything else goes through routerBody(), the same request the
 * runtime sends. Skips (loudly) when no endpoint is up, so unit gates
 * still run offline.
 *
 * The endpoint decides its own shape: detectProfile() picks `needle`
 * for a needle model and `tools` for everything else, so this file does
 * not need to know which router is running. That matters — it did know,
 * once, and was wrong for as long as it took somebody to look.
 *
 * Threshold, not exactness: a small router is probabilistic at the
 * margins. 80% floors the measured baseline (needle 100% and Qwen3-0.6B
 * 100% on this set, both with job-title names + verb descriptions);
 * dipping below means names, descriptions, or the model regressed.
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
  // routerBody(), NOT a hand-rolled body.
  //
  // This test used to build the request itself, and that request was the
  // NEEDLE shape — bare messages + tools. When the orchestrator moved to
  // Qwen the runtime started sending the `tools` profile instead: a
  // system prompt, pinned temperature, a token cap, and above all
  // `tool_choice: "required"`. The test kept sending the old shape, so a
  // general chat model answered in prose ("Sure! I can review your
  // relay.ts changes...") and every prose answer scored as `none`.
  //
  // Measured on the same battery, same endpoint: hand-rolled 5-6/9 and
  // varied run to run because nothing pinned temperature; through
  // routerBody, 9/9. The test was failing the router, not the reverse.
  //
  // So it calls what the runtime calls. A profile or sampling change now
  // moves this test with it instead of silently invalidating it.
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(routerBody(detectProfile(model!), model!, q, ROSTER.map(agentTool))),
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
