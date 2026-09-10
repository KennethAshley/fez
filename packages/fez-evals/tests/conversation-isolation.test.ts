import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { matchFilter, type Event, type Filter } from "nostr-tools";
import type { HarnessAdapter, HarnessSession, Persona } from "@fezchat/protocol";

// Exercise agent.ts itself. Only machine/provider IO is replaced; admission,
// queuing, session selection, prompt construction and signed replies are real.
const fixture = vi.hoisted(() => ({ dir: "", harness: undefined as HarnessAdapter | undefined }));
const agentKey = new Uint8Array(32).fill(1);
const ownerKey = new Uint8Array(32).fill(2);
const agentPk = getPublicKey(agentKey), ownerPk = getPublicKey(ownerKey);
const channelA = "00000000-0000-0000-0000-000000000001";
const channelB = "00000000-0000-0000-0000-000000000002";
let wire: Transport;

class Transport {
  events: Event[] = [];
  subscriptions: { filters: Filter[]; receive: (e: Event) => void }[] = [];
  beforePublish?: (e: Event) => Promise<void>;
  async connect() {}
  disconnect() {}
  async query(filters: Filter[]) { return this.events.filter(e => filters.some(f => matchFilter(f, e))); }
  subscribe(filters: Filter[], receive: (e: Event) => void) {
    const sub = { filters, receive };
    this.subscriptions.push(sub);
    return () => { this.subscriptions = this.subscriptions.filter(s => s !== sub); };
  }
  async publish(event: Event) {
    await this.beforePublish?.(event);
    this.events.push(event);
    for (const sub of this.subscriptions) {
      if (sub.filters.some(f => matchFilter(f, event))) sub.receive(event);
    }
  }
}

vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => fixture.dir } };
});
vi.mock("@fezchat/protocol", async importOriginal => {
  const actual = await importOriginal<typeof import("@fezchat/protocol")>();
  return {
    ...actual,
    RelayConnection: class { constructor() { return wire; } },
    fetchRelayInfo: async () => ({ pubkey: ownerPk }),
    registerBuiltinHarnesses: () => {},
    findHarness: () => fixture.harness,
    findPersona: async (): Promise<Persona> => ({
      id: "isolation-test", harness: "controlled", aliases: [], mcpServers: [],
      mcpSources: {}, skills: [], skillSources: {}, skillSettings: {}, extra: {}, createdAt: "2026-09-10",
    }),
    loadOrCreateKey: () => Buffer.from(agentKey).toString("hex"),
    loadSettings: () => ({}),
    skillsInstalled: () => [],
    resolveRelays: () => ["ws://controlled.invalid"],
  };
});

type Turn = { session: HarnessSession; text: string; aborted: boolean; finish(text?: string): void; fail(): void };
let turns: Turn[];
let sessions: HarnessSession[];
let priorExit: NodeJS.ExitListener[], priorSigint: NodeJS.SignalsListener[];

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-conversation-"));
  priorExit = process.listeners("exit");
  priorSigint = process.listeners("SIGINT");
  vi.stubEnv("FEZ_AGENT_PERSONA", "isolation-test");
  vi.stubEnv("FEZ_AGENT_CHANNELS", `${channelA},${channelB}`);
  vi.stubEnv("FEZ_AGENT_OWNER", ownerPk);
  vi.stubEnv("FEZ_AGENT_RESPOND_TO", "owner");
  vi.stubEnv("FEZ_AGENT_ON_BUSY", "steer");
  vi.stubEnv("FEZ_AGENT_MAX_TURNS_PER_HOUR", "100");
  vi.stubEnv("FEZ_SESSION_TURN_CAP", "2");
  vi.stubEnv("FEZ_AGENT_REPO", "");
  vi.stubEnv("FEZ_HIRE_TASK", "");
  vi.spyOn(process, "exit").mockImplementation(code => { throw new Error(`Unexpected exit: ${code}`); });
  wire = new Transport();
  wire.events.push(finalizeEvent({
    kind: 47102, tags: [["d", "roster"], ["p", ownerPk], ["p", agentPk]],
    content: "", created_at: Math.floor(Date.now() / 1000),
  }, ownerKey));
  turns = []; sessions = [];
  fixture.harness = {
    id: "controlled", aliases: [], command: "controlled", detect: async () => true,
    invoke: async () => { throw new Error("persistent session expected"); },
    openSession: async () => {
      let alive = true;
      const session: HarnessSession = {
        get alive() { return alive; },
        close: async () => { alive = false; },
        prompt: (input, _progress, _update, signal) => {
          const text = typeof input === "string" ? input : input.text;
          return new Promise((resolve, reject) => {
            const turn: Turn = { session, text, aborted: false,
              finish: (reply = "Completed.") => { signal?.removeEventListener("abort", abort); resolve(reply); },
              fail: () => { signal?.removeEventListener("abort", abort); reject(new Error("network unavailable")); },
            };
            const abort = () => {
              turn.aborted = true;
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            };
            signal?.addEventListener("abort", abort, { once: true });
            turns.push(turn);
            if (signal?.aborted) abort();
          });
        },
      };
      sessions.push(session);
      return session;
    },
  };
  await import("../../fez-acp/src/agent.js");
  await vi.advanceTimersByTimeAsync(5_100);
  expect(wire.subscriptions.some(s => s.filters.some(f => f.kinds?.includes(47103)))).toBe(true);
});

afterEach(async () => {
  for (const turn of turns ?? []) turn.finish();
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers();
  for (const listener of process.listeners("exit")) if (!priorExit.includes(listener)) process.removeListener("exit", listener);
  for (const listener of process.listeners("SIGINT")) if (!priorSigint.includes(listener)) process.removeListener("SIGINT", listener);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

async function send(content: string, channel = channelA, root?: string, doc?: { page: string; anchor: string }) {
  const event = finalizeEvent({ kind: doc ? 40101 : 47103, created_at: Math.floor(Date.now() / 1000), content,
    tags: [["h", channel], ["p", agentPk],
      ...(root ? (doc ? [["e", root]] : [["e", root, "", "reply"]]) : []),
      ...(doc ? [["d", doc.page], ["anchor", doc.anchor]] : []),
    ],
  }, ownerKey);
  await wire.publish(event);
  await vi.advanceTimersByTimeAsync(0);
  return event;
}
function replies() { return wire.events.filter(e => e.pubkey === agentPk && [47103, 40101].includes(e.kind)); }
async function finish(turn: Turn, reply = "Completed.") {
  turn.finish(reply);
  await vi.advanceTimersByTimeAsync(1_000);
}

describe("standing-agent conversation isolation", () => {
  it.each([channelA, channelB])("queues unrelated work in %s without steering the active request", async channel => {
    const a = await send("TASK_ALPHA");
    const first = turns[0];
    const b = await send("TASK_BETA", channel);
    expect(first.aborted).toBe(false);
    expect(turns).toHaveLength(1);
    await finish(first, "ALPHA_DONE");
    expect(turns).toHaveLength(2);
    expect(turns[1].session).not.toBe(first.session);
    expect(turns[1].text).toContain("TASK_BETA");
    expect(turns[1].text).not.toContain("TASK_ALPHA");
    await finish(turns[1], "BETA_DONE");
    expect(replies().map(e => [e.content, e.tags.find(t => t[0] === "h")?.[1], e.tags.find(t => t[3] === "reply")?.[1]]))
      .toEqual([["ALPHA_DONE", channelA, a.id], ["BETA_DONE", channel, b.id]]);
  });

  it("reuses only the same thread's session and history", async () => {
    const a = await send("THREAD_ALPHA");
    await finish(turns[0]);
    const b = await send("THREAD_BETA");
    expect(turns[1].session).not.toBe(turns[0].session);
    expect(turns[1].text).not.toContain("THREAD_ALPHA");
    await finish(turns[1]);
    await send("ALPHA_FOLLOWUP", channelA, a.id);
    expect(turns[2].session).toBe(turns[0].session);
    expect(turns[2].text).not.toContain("THREAD_BETA");
    await finish(turns[2]);
    await send("BETA_FOLLOWUP", channelA, b.id);
    expect(turns[3].session).toBe(turns[1].session);
  });

  it("preserves a deferred document comment's page, anchor, root and reply kind", async () => {
    await send("CHAT_WORK");
    const comment = await send("DOC_WORK", channelA, undefined, { page: "spec", anchor: "line seven" });
    expect(turns[0].aborted).toBe(false);
    await finish(turns[0], "CHAT_DONE");
    expect(turns[1].text).toContain("line seven");
    expect(turns[1].text).toContain("spec");
    expect(turns[1].text).not.toContain("CHAT_WORK");
    await finish(turns[1], "DOC_DONE");
    const reply = replies().find(e => e.content === "DOC_DONE")!;
    expect(reply.kind).toBe(40101);
    expect(reply.tags).toContainEqual(["e", comment.id]);
    expect(reply.tags).toContainEqual(["d", "spec"]);
  });

  it("retains every follow-up through repeated same-thread steering", async () => {
    const root = await send("ORIGINAL_WORK");
    await send("FIRST_CORRECTION", channelA, root.id);
    expect(turns[0].aborted).toBe(true);
    expect(turns[1].text).toContain("FIRST_CORRECTION");
    await send("SECOND_CORRECTION", channelA, root.id);
    expect(turns[1].aborted).toBe(true);
    expect(turns[2].text).toContain("ORIGINAL_WORK");
    expect(turns[2].text).toContain("FIRST_CORRECTION");
    expect(turns[2].text).toContain("SECOND_CORRECTION");
    await finish(turns[2], "CORRECTED");
    expect(replies().map(e => e.content)).toEqual(["CORRECTED"]);
  });

  it("keeps a queued doc batch's original anchor when its last reply has no anchor", async () => {
    await send("CHAT_BUSY");
    const root = await send("DOC_ORIGINAL", channelA, undefined, { page: "spec", anchor: "original anchor" });
    await send("DOC_FOLLOWUP", channelA, root.id, { page: "spec", anchor: "" });
    await finish(turns[0]);
    expect(turns).toHaveLength(2);
    expect(turns[1].text).toContain("DOC_ORIGINAL");
    expect(turns[1].text).toContain("DOC_FOLLOWUP");
    expect(turns[1].text).toContain("original anchor");
    await finish(turns[1], "DOC_BATCH_DONE");
    const reply = replies().find(e => e.content === "DOC_BATCH_DONE")!;
    expect(reply.kind).toBe(40101);
    expect(reply.tags).toContainEqual(["e", root.id]);
  });

  it("queues a follow-up arriving during publication without repeating the original answer", async () => {
    const root = await send("ORIGINAL_TO_PUBLISH");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    wire.beforePublish = e => e.content === "FIRST_ANSWER" ? gate : Promise.resolve();
    turns[0].finish("FIRST_ANSWER");
    await vi.advanceTimersByTimeAsync(0);
    await send("FOLLOWUP_DURING_PUBLISH", channelA, root.id);
    expect(turns[0].aborted).toBe(false);
    expect(turns).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(turns[1].session).toBe(turns[0].session);
    expect(turns[1].text).toContain("FOLLOWUP_DURING_PUBLISH");
    expect(turns[1].text).not.toContain("ORIGINAL_TO_PUBLISH");
    await finish(turns[1], "FOLLOWUP_ANSWER");
    expect(replies().map(e => e.content)).toEqual(["FIRST_ANSWER", "FOLLOWUP_ANSWER"]);
  });

  it("preserves doc metadata and thread history through delayed retries", async () => {
    const root = await send("RETRY_DOC", channelA, undefined, { page: "spec", anchor: "retry anchor" });
    turns[0].fail();
    await vi.advanceTimersByTimeAsync(0);
    turns[1].fail();
    await vi.advanceTimersByTimeAsync(0);
    await send("UNRELATED_DURING_BACKOFF");
    expect(turns[2].text).not.toContain("RETRY_DOC");
    await finish(turns[2]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(turns[3].text).toContain("RETRY_DOC");
    expect(turns[3].text).toContain("retry anchor");
    expect(turns[3].text).not.toContain("UNRELATED_DURING_BACKOFF");
    await finish(turns[3], "RETRY_DONE");
    const reply = replies().find(e => e.content === "RETRY_DONE")!;
    expect(reply.kind).toBe(40101);
    expect(reply.tags).toContainEqual(["e", root.id]);
  });

  it("bounds live sessions and restores only the evicted thread's context", async () => {
    const roots: Event[] = [];
    for (let i = 0; i < 5; i++) {
      roots.push(await send(`THREAD_${i}`));
      await finish(turns.at(-1)!);
      expect(sessions.filter(s => s.alive).length).toBeLessThanOrEqual(4);
    }
    expect(sessions[0].alive).toBe(false);
    await send("REVISIT_ZERO", channelA, roots[0].id);
    expect(turns.at(-1)!.text).toContain("THREAD_0");
    for (let i = 1; i < 5; i++) expect(turns.at(-1)!.text).not.toContain(`THREAD_${i}`);
  });

  it("recycles only the capped thread and gives its replacement its own handoff", async () => {
    const root = await send("HANDOFF_ALPHA");
    await finish(turns[0]);
    await send("HANDOFF_BETA");
    await finish(turns[1]);
    await send("ALPHA_SECOND", channelA, root.id);
    await finish(turns[2]);
    await send("ALPHA_THIRD", channelA, root.id);
    expect(turns[3].session).toBe(turns[0].session);
    expect(turns[3].text).toContain("handoff");
    await finish(turns[3], "ALPHA_SUCCESSION_NOTE");
    expect(turns[4].session).not.toBe(turns[0].session);
    expect(turns[4].text).toContain("ALPHA_SUCCESSION_NOTE");
    expect(turns[4].text).not.toContain("HANDOFF_BETA");
    expect(turns[1].session.alive).toBe(true);
  });

  it("keeps DMs conversation-scoped while chat work queues independently", async () => {
    await vi.advanceTimersByTimeAsync(2_500); // Finish the runtime's startup DM replay window.
    const { CapabilityClient } = await import("@fezchat/protocol");
    const owner = new CapabilityClient({ relay: "ws://controlled.invalid", privateKey: Buffer.from(ownerKey).toString("hex") });
    await send("CHANNEL_BEFORE_DM");
    await wire.publish(owner.wrapDm(agentPk, "PRIVATE_FIRST").toPeer);
    await vi.advanceTimersByTimeAsync(0);
    expect(turns[0].aborted).toBe(false);
    await finish(turns[0]);
    expect(turns[1].text).toContain("PRIVATE_FIRST");
    expect(turns[1].text).not.toContain("CHANNEL_BEFORE_DM");
    await finish(turns[1]);
    await wire.publish(owner.wrapDm(agentPk, "PRIVATE_SECOND").toPeer);
    await vi.advanceTimersByTimeAsync(0);
    expect(turns[2].session).toBe(turns[1].session);
    await send("CHANNEL_AFTER_DM");
    expect(turns[2].aborted).toBe(false);
    await finish(turns[2]);
    expect(turns[3].text).not.toContain("PRIVATE_FIRST");
    expect(turns[3].text).not.toContain("PRIVATE_SECOND");
  });

  it("ignores malformed thread IDs and reuses canonical root IDs", async () => {
    const first = await send("MALFORMED_ONE", channelA, "not-an-event-id");
    await finish(turns[0]);
    await send("MALFORMED_TWO", channelA, "not-an-event-id");
    expect(turns[1].session).not.toBe(turns[0].session);
    expect(turns[1].text).not.toContain("MALFORMED_ONE");
    await finish(turns[1]);
    await send("CANONICAL_FOLLOWUP", channelA, first.id.toUpperCase());
    expect(turns[2].session).toBe(turns[0].session);
  });

  it("keeps activity metrics navigable by channel", async () => {
    const { CapabilityClient } = await import("@fezchat/protocol");
    const owner = new CapabilityClient({ relay: "ws://controlled.invalid", privateKey: Buffer.from(ownerKey).toString("hex") });
    const root = await send("METRIC_WORK");
    await finish(turns[0]);
    const metric = wire.events.find(e => e.kind === 47030)!;
    expect(JSON.parse(owner.decryptFrom(agentPk, metric.content))).toMatchObject({ scope: `ch:${channelA}`, trigger: root.id });
  });

  it("keeps wiki comment sessions when a page moves to another channel", async () => {
    const root = await send("WIKI_ORIGINAL", channelA, undefined, { page: "spec", anchor: "" });
    await finish(turns[0]);
    await wire.publish(finalizeEvent({ kind: 40101, created_at: Math.floor(Date.now() / 1000),
      tags: [["h", channelB], ["p", agentPk], ["e", root.id]], content: "WIKI_FOLLOWUP",
    }, ownerKey));
    await vi.advanceTimersByTimeAsync(0);
    expect(turns[1].session).toBe(turns[0].session);
    expect(turns[1].text).toContain('page "spec"');
  });

  it("retains a queued request after unrelated traffic evicts its cached history", async () => {
    await send("BLOCKING_TURN");
    await send("QUEUED_REQUEST_TO_PRESERVE");
    for (let i = 0; i < 201; i++) {
      await wire.publish(finalizeEvent({ kind: 47103, created_at: Math.floor(Date.now() / 1000),
        tags: [["h", channelA]], content: `Unaddressed chatter ${i}`,
      }, ownerKey));
    }
    await finish(turns[0]);
    expect(turns[1].text).toContain("QUEUED_REQUEST_TO_PRESERVE");
    expect(turns[1].text).not.toContain("Unaddressed chatter");
  });

  it("preserves steering when opening the cancelled session fails", async () => {
    let failOpen!: (error: Error) => void;
    vi.spyOn(fixture.harness!, "openSession").mockImplementationOnce(() => new Promise((_resolve, reject) => { failOpen = reject; }));
    const root = await send("ORIGINAL_DURING_OPEN");
    for (let i = 0; i < 12; i++) await send(`CORRECTION_${i}`, channelA, root.id);
    failOpen(new Error("network unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toContain("ORIGINAL_DURING_OPEN");
    for (let i = 0; i < 12; i++) expect(turns[0].text).toContain(`CORRECTION_${i}`);
  });

  it("discards a cancelled session even when the harness ignores abort", async () => {
    const open = fixture.harness!.openSession!;
    vi.spyOn(fixture.harness!, "openSession").mockImplementationOnce(async (...args) => {
      const session = await open(...args), prompt = session.prompt;
      session.prompt = (input, progress, update) => prompt(input, progress, update);
      return session;
    });
    const root = await send("NONCOOPERATIVE_ORIGINAL");
    await send("NONCOOPERATIVE_CORRECTION", channelA, root.id);
    await finish(turns[0], "STALE_ANSWER");
    expect(replies()).toHaveLength(0);
    expect(turns[1].session).not.toBe(turns[0].session);
    expect(turns[0].session.alive).toBe(false);
    expect(turns[1].text).toContain("NONCOOPERATIVE_CORRECTION");
  });

  it("does not prompt a replacement session cancelled while it was opening", async () => {
    const open = fixture.harness!.openSession!;
    let release!: () => Promise<void>;
    vi.spyOn(fixture.harness!, "openSession").mockImplementationOnce(open)
      .mockImplementationOnce((...args) => new Promise(resolve => { release = async () => { resolve(await open(...args)); }; }));
    const root = await send("REPLAY_ORIGINAL");
    turns[0].fail();
    await vi.advanceTimersByTimeAsync(0);
    await send("REPLAY_CORRECTION", channelA, root.id);
    await release();
    await vi.advanceTimersByTimeAsync(0);
    expect(turns).toHaveLength(2); // Failed original and the corrected turn; no cancelled replay.
    expect(sessions).toHaveLength(3);
    expect(sessions[1].alive).toBe(false);
    expect(turns[1].session).toBe(sessions[2]);
    expect(turns[1].text).toContain("REPLAY_CORRECTION");
  });

  it("does not multiply a channel's queue budget by its number of threads", async () => {
    await send("BLOCKING_TURN");
    for (let i = 0; i < 21; i++) await send(`QUEUED_${i}`);
    for (let i = 0; i < turns.length && i < 30; i++) await finish(turns[i]);
    expect(turns).toHaveLength(21); // Active turn plus the existing 20-item channel budget.
    expect(turns.slice(1).some(t => t.text.includes("QUEUED_0"))).toBe(false);
    expect(turns.at(-1)!.text).toContain("QUEUED_20");
  });

  it("removes revoked steering even when its queued trigger is also revoked", async () => {
    const siblingKey = new Uint8Array(32).fill(3), siblingPk = getPublicKey(siblingKey);
    await wire.publish(finalizeEvent({ kind: 47102, created_at: Math.floor(Date.now() / 1000),
      tags: [["d", "roster"], ["p", ownerPk], ["p", agentPk], ["p", siblingPk]], content: "",
    }, ownerKey));
    await wire.publish(finalizeEvent({ kind: 47006, created_at: Math.floor(Date.now() / 1000), tags: [["p", siblingPk]], content: "" }, ownerKey));
    const root = finalizeEvent({ kind: 47103, created_at: Math.floor(Date.now() / 1000),
      tags: [["h", channelA], ["p", agentPk]], content: "@isolation-test REVOKED_TRIGGER",
    }, siblingKey);
    await wire.publish(root);
    await vi.advanceTimersByTimeAsync(0);
    await wire.publish(finalizeEvent({ kind: 47103, created_at: Math.floor(Date.now() / 1000),
      tags: [["h", channelA], ["p", agentPk], ["e", root.id, "", "root"]], content: "@isolation-test REVOKED_CORRECTION",
    }, siblingKey));
    await vi.advanceTimersByTimeAsync(0);
    expect(turns[1].text).toContain("REVOKED_CORRECTION");
    turns[1].fail();
    await vi.advanceTimersByTimeAsync(0);
    turns[2].fail();
    await vi.advanceTimersByTimeAsync(0);
    await wire.publish(finalizeEvent({ kind: 30047, created_at: Math.floor(Date.now() / 1000),
      tags: [["d", "bans"], ["p", siblingPk]], content: "",
    }, ownerKey));
    await send("OWNER_BLOCKING_TURN");
    await send("OWNER_FOLLOWUP", channelA, root.id);
    await vi.advanceTimersByTimeAsync(5_000);
    await finish(turns[3]);
    expect(turns[4].text).toContain("OWNER_FOLLOWUP");
    expect(turns[4].text).not.toContain("REVOKED_TRIGGER");
    expect(turns[4].text).not.toContain("REVOKED_CORRECTION");
  });

  it("continues draining when a queued author has left the roster", async () => {
    const siblingKey = new Uint8Array(32).fill(3), siblingPk = getPublicKey(siblingKey);
    const roster = (members: string[]) => finalizeEvent({ kind: 47102, created_at: Math.floor(Date.now() / 1000),
      tags: [["d", "roster"], ...members.map(pk => ["p", pk])], content: "",
    }, ownerKey);
    await wire.publish(roster([ownerPk, agentPk, siblingPk]));
    await wire.publish(finalizeEvent({ kind: 47006, created_at: Math.floor(Date.now() / 1000), tags: [["p", siblingPk]], content: "" }, ownerKey));
    await send("ACTIVE_OWNER_WORK");
    await wire.publish(finalizeEvent({ kind: 47103, created_at: Math.floor(Date.now() / 1000),
      tags: [["h", channelA], ["p", agentPk]], content: "@isolation-test REMOVED_SIBLING_WORK",
    }, siblingKey));
    await vi.advanceTimersByTimeAsync(0);
    await send("WAITING_OWNER_WORK", channelB);
    await vi.advanceTimersByTimeAsync(1_000); // A newer replaceable roster, not a timestamp tie.
    await wire.publish(roster([ownerPk, agentPk]));
    await finish(turns[0]);
    expect(turns).toHaveLength(2);
    expect(turns[1].text).toContain("WAITING_OWNER_WORK");
    expect(turns[1].text).not.toContain("REMOVED_SIBLING_WORK");
  });
});
