import { afterEach, describe, expect, it, vi } from "vitest";
import { FezClient, K, setStatePersistence, type Wire, type WireEvent, type WireFilter } from "../../fez-client/src/index.js";
import { inputForm, validateInputResponse, requestInput } from "../../fez-client/src/agent-input.js";

const OWNER = "a".repeat(64), AGENT = "b".repeat(64), STRANGER = "c".repeat(64);
const request = {
  mode: "form", message: "Choose how to build it", requestedSchema: {
    type: "object", properties: {
      layout: { type: "string", title: "Layout", oneOf: [{ const: "list", title: "List" }, { const: "grid", title: "Grid" }] },
      features: { type: "array", title: "Features", items: { anyOf: [{ const: "search", title: "Search" }, { const: "filters", title: "Filters" }] } },
      custom: { type: "string", title: "Other" },
    }, required: ["layout"],
  },
};

function network() {
  const events: WireEvent[] = [];
  const subs = new Set<{ filters: WireFilter[]; receive: (e: WireEvent) => void }>();
  const matches = (e: WireEvent, fs: WireFilter[]) => fs.some(f =>
    (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)) &&
    (!f.since || e.created_at >= f.since) && Object.entries(f).every(([k, values]) =>
      !k.startsWith("#") || e.tags.some(t => t[0] === k.slice(1) && (values as string[]).includes(t[1]))));
  function wire(pubkey: string): Wire {
    return {
      pubkey, relays: ["wss://input.test"],
      relayInfo: async () => ({ pubkey: OWNER }),
      publish: async t => {
        const e = { ...t, pubkey, id: String(events.length + 1).padStart(64, "0"), created_at: Math.floor(Date.now() / 1000), sig: "" };
        events.push(e);
        for (const s of subs) if (matches(e, s.filters)) s.receive(e);
        return e;
      },
      subscribe: (filters, receive) => { const s = { filters, receive }; subs.add(s); return () => { subs.delete(s); }; },
      query: async filters => events.filter(e => matches(e, filters)),
      encrypt: (peer, text) => JSON.stringify({ peers: [pubkey, peer].sort(), text }),
      decrypt: (peer, text) => {
        const encrypted = JSON.parse(text);
        if (JSON.stringify(encrypted.peers) !== JSON.stringify([pubkey, peer].sort())) throw Error("wrong peer");
        return encrypted.text;
      },
      sendDm: async () => "", unwrapDm: () => undefined,
    };
  }
  return { wire, events, subs };
}

afterEach(() => vi.useRealTimers());

describe("agent input", () => {
  it("preserves multiple questions, option descriptions and custom text", () => {
    const form = inputForm(request);
    expect(form.fields.map(f => [f.id, f.type])).toEqual([["layout", "string"], ["features", "array"], ["custom", "string"]]);
    expect(validateInputResponse(form, { action: "accept", content: { layout: "grid", features: ["search", "filters"], custom: "compact" } }))
      .toEqual({ action: "accept", content: { layout: "grid", features: ["search", "filters"], custom: "compact" } });
    expect(() => validateInputResponse(form, { action: "accept", content: {} })).toThrow(/Layout/);
    expect(() => validateInputResponse(form, { action: "accept", content: { layout: "invented" } })).toThrow();
    expect(() => validateInputResponse(form, { action: "accept", content: { layout: "grid", features: ["unknown"] } })).toThrow();
    expect(() => inputForm({ ...request, mode: "url" })).toThrow();
    expect(() => inputForm({ ...request, requestedSchema: { properties: { nested: { type: "object" } } } })).toThrow();
  });

  it("delivers a private form to the owner and returns every answer to the waiting agent", async () => {
    vi.useFakeTimers();
    setStatePersistence({ load: () => undefined, save: () => {} });
    const net = network(), agent = net.wire(AGENT), owner = net.wire(OWNER);
    await owner.publish({ kind: K.MEMBERSHIP, tags: [["d", "roster"], ["p", OWNER], ["p", AGENT]], content: "" });
    const client = new FezClient(owner);
    await client.start();
    const pending = requestInput(agent, OWNER, inputForm(request), { timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    const [question] = client.pendingInputs();
    expect(question.form.fields).toHaveLength(3);
    const req = net.events.find(e => e.kind === K.INPUT_REQUEST)!;
    expect(req.content).not.toBe(JSON.stringify(question.form));
    const content = { layout: "grid", features: ["search", "filters"], custom: "compact" };
    await client.answerInput(question.id, { action: "accept", content });
    await expect(pending).resolves.toEqual({ action: "accept", content });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.pendingInputs()).toEqual([]);
    expect(client.inputHistory()).toMatchObject([{ status: "received", response: { action: "accept", content } }]);
    // A second device/backfill must not resurrect a closed request.
    const second = new FezClient(owner);
    await second.start();
    expect(second.pendingInputs()).toEqual([]);
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    const later = new FezClient(owner);
    await later.start();
    await later.loadInputHistory();
    expect(later.inputHistory()).toMatchObject([{ status: "received", response: { action: "accept", content }, form: { message: request.message } }]);
  });

  it("keeps sent answers unconfirmed until a receipt names that exact signed response", async () => {
    vi.useFakeTimers();
    setStatePersistence({ load: () => undefined, save: () => {} });
    const net = network(), agent = net.wire(AGENT), owner = net.wire(OWNER);
    await owner.publish({ kind: K.MEMBERSHIP, tags: [["d", "roster"], ["p", OWNER], ["p", AGENT]], content: "" });
    const expiresAt = Date.now() + 60_000;
    const form = inputForm(request);
    const tags = [["p", OWNER], ["d", "delivery"]];
    await agent.publish({ kind: K.INPUT_REQUEST, tags, content: await agent.encrypt(OWNER, JSON.stringify({ status: "pending", expiresAt, form })) });
    const client = new FezClient(owner); await client.start();
    await client.answerInput(client.pendingInputs()[0].id, { action: "accept", content: { layout: "grid" } });
    expect(client.inputHistory()).toMatchObject([{ status: "sent", response: { content: { layout: "grid" } } }]);
    await agent.publish({ kind: K.INPUT_REQUEST, tags, content: await agent.encrypt(OWNER, JSON.stringify({ status: "closed", expiresAt, form, responseId: "wrong" })) });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.inputHistory()[0].status).toBe("closed");
    // A closed form is not proof that our answer arrived.
    expect(client.pendingInputs()).toEqual([]);
  });

  it("restores legacy closed questions when the relay sends closure before the form", async () => {
    vi.useFakeTimers();
    setStatePersistence({ load: () => undefined, save: () => {} });
    const net = network(), agent = net.wire(AGENT), owner = net.wire(OWNER);
    await owner.publish({ kind: K.MEMBERSHIP, tags: [["d", "roster"], ["p", OWNER], ["p", AGENT]], content: "" });
    const expiresAt = Date.now() + 60_000, tags = [["p", OWNER], ["d", "legacy"]];
    await agent.publish({ kind: K.INPUT_REQUEST, tags, content: await agent.encrypt(OWNER, JSON.stringify({ status: "closed", expiresAt })) });
    await agent.publish({ kind: K.INPUT_REQUEST, tags, content: await agent.encrypt(OWNER, JSON.stringify({ status: "pending", expiresAt, form: inputForm(request) })) });
    const client = new FezClient(owner); await client.start();
    expect(client.pendingInputs()).toEqual([]);
    expect(client.inputHistory()).toMatchObject([{ status: "closed", response: undefined }]);
  });

  it("ignores other signers, wrong request ids and invalid answers; abort clears the wait", async () => {
    vi.useFakeTimers();
    const net = network(), agent = net.wire(AGENT), owner = net.wire(OWNER), stranger = net.wire(STRANGER);
    const abort = new AbortController();
    const pending = requestInput(agent, OWNER, inputForm(request), { signal: abort.signal, timeoutMs: 60_000 });
    const completed = vi.fn(); pending.then(completed);
    await vi.advanceTimersByTimeAsync(0);
    const req = net.events.find(e => e.kind === K.INPUT_REQUEST)!;
    const id = req.tags.find(t => t[0] === "d")![1];
    for (const [w, requestId, content] of [[stranger, id, { layout: "grid" }], [owner, "wrong", { layout: "grid" }], [owner, id, { layout: "wrong" }]] as const) {
      await w.publish({ kind: K.INPUT_RESPONSE, tags: [["p", AGENT], ["d", requestId]], content: await w.encrypt(AGENT, JSON.stringify({ action: "accept", content })) });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).not.toHaveBeenCalled();
    abort.abort();
    await expect(pending).resolves.toEqual({ action: "cancel" });
    expect(net.subs.size).toBe(0);
    expect(JSON.parse(await owner.decrypt(AGENT, net.events.at(-1)!.content)).status).toBe("closed");
  });

  it("expires unattended requests and never invents an answer", async () => {
    vi.useFakeTimers();
    const net = network();
    const owner = net.wire(OWNER);
    await owner.publish({ kind: K.MEMBERSHIP, tags: [["d", "roster"], ["p", OWNER], ["p", AGENT]], content: "" });
    const client = new FezClient(owner); await client.start();
    const pending = requestInput(net.wire(AGENT), OWNER, inputForm(request), { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(101);
    await expect(pending).resolves.toEqual({ action: "cancel" });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.inputHistory()).toMatchObject([{ status: "expired", response: undefined }]);
  });

  it("expiry releases the tool even when the relay never acknowledges publish", async () => {
    vi.useFakeTimers();
    const net = network(), wire = net.wire(AGENT);
    wire.publish = () => new Promise(() => {});
    const pending = requestInput(wire, OWNER, inputForm(request), { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(101);
    await expect(pending).resolves.toEqual({ action: "cancel" });
    expect(net.subs.size).toBe(0);
  });
});
