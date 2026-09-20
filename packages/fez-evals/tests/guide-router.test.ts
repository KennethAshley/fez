import { describe, expect, test } from "vitest";
import { ROUTE_AT, buildRoster, cleanRequest, decideRoute, routable, type RosterAgent } from "../../fez-acp/src/guide-router.js";

const ann = (pubkey: string, meta: Record<string, unknown>, created_at = 1) => ({ pubkey, kind: 47000, created_at, content: JSON.stringify(meta) });
const roster: RosterAgent[] = buildRoster([
  ann("d".repeat(64), { name: "drift", about: "search the web, find papers and specs" }),
  ann("q".repeat(64), { name: "quill", about: "write and edit — drafts, summaries" }),
  ann("r".repeat(64), { name: "router", about: "infrastructure", routable: false }),
  ann("m".repeat(64), { name: "miner", about: "mines", supported_tasks: ["mining"] }),
  ann("s".repeat(64), { name: "self", about: "the guide" }),
], "s".repeat(64));

describe("roster", () => {
  test("excludes the guide itself and keeps the newest announcement per key", () => {
    expect(roster.map((a) => a.name).sort()).toEqual(["drift", "miner", "quill", "router"]);
    const updated = buildRoster([ann("d".repeat(64), { name: "drift", about: "old" }, 1), ann("d".repeat(64), { name: "drift", about: "new" }, 2)], "x");
    expect(updated[0].about).toBe("new");
  });
  test("routable drops infrastructure and non-chat services", () => {
    expect(routable(roster).map((a) => a.name).sort()).toEqual(["drift", "quill"]);
  });
});

describe("decideRoute", () => {
  const base = { guideNames: ["fez", "orchestrator"], asker: "Ken", roster, model: "fez-router" };

  test("an explicitly named actor routes without calling the router", async () => {
    let called = false;
    const d = await decideRoute({ ...base, text: "@fez have drift find the NIP-17 changelog", call: async () => { called = true; return {}; } });
    expect(called).toBe(false);
    expect(d).toMatchObject({ reason: "explicit", agent: { name: "drift" }, reply: "@drift (from Ken) have drift find the NIP-17 changelog" });
  });

  test("a confident router pick routes with the user's own words", async () => {
    let sent: { messages: { content: string }[] } | undefined;
    const d = await decideRoute({ ...base, text: "@fez what changed in NIP-17 this month?", call: async (body) => { sent = body as never; return { choice: "drift", confidence: 0.93 }; } });
    expect(d).toMatchObject({ reason: "router", confidence: 0.93, reply: "@drift (from Ken) what changed in NIP-17 this month?" });
    expect(sent!.messages.at(-1)!.content).toBe("what changed in NIP-17 this month?");
  });

  test("roster names inside the task are scrubbed before routing", async () => {
    let sent: { messages: { content: string }[] } | undefined;
    await decideRoute({ ...base, text: "@fez quill mentioned a paper, find it", call: async (body) => { sent = body as never; return { choice: "drift", confidence: 0.9 }; } });
    expect(sent!.messages.at(-1)!.content).toBe("a teammate mentioned a paper, find it");
  });

  test.each([
    ["below the bar", { choice: "drift", confidence: ROUTE_AT - 0.01 }],
    ["no confidence reported (local fallback)", { choice: "drift" }],
    ["nobody", { choice: "nobody", confidence: 0.99 }],
    ["an unknown name", { choice: "ghost", confidence: 0.99 }],
  ])("falls back to the model on %s", async (_label, answer) => {
    expect(await decideRoute({ ...base, text: "@fez summarize the release notes", call: async () => answer })).toBeUndefined();
  });

  test("small talk, fleet questions, router errors and empty rosters run the model", async () => {
    const boom = async () => { throw new Error("router HTTP 502"); };
    expect(await decideRoute({ ...base, text: "@fez hey there!", call: boom })).toBeUndefined();
    expect(await decideRoute({ ...base, text: "@fez what can drift do?", call: boom })).toBeUndefined();
    expect(await decideRoute({ ...base, text: "@fez deploy the site", call: boom })).toBeUndefined();
    expect(await decideRoute({ ...base, roster: [], text: "@fez deploy the site", call: async () => ({ choice: "drift", confidence: 1 }) })).toBeUndefined();
  });

  test("cleanRequest strips only the guide's names", () => {
    expect(cleanRequest("@fez ask @drift about @quill", ["fez"])).toBe("ask @drift about @quill");
    expect(cleanRequest("hey @orchestrator, ship it", ["fez", "orchestrator"])).toBe("hey , ship it");
  });
});
