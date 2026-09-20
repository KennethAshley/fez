import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startWorkflowEngine, type EngineNostr, type FezEvent } from "../../fez-workflows/src/engine.js";
import { loadDefs } from "../../fez-workflows/src/defs.js";
import { KIND_AGENT_METADATA, KIND_CHANNEL_MESSAGE, KIND_MEMBERSHIP, KIND_WORKFLOW_RUN, ROSTER_D } from "../../../src/protocol/kinds.js";

/**
 * The silent summons end to end inside the engine: a `wake:` step sends
 * one owner-encrypted control frame and posts nothing; a host that cannot
 * send control frames fails the run instead of posting a summons; and
 * whatever a workflow does say carries its name so clients can render it
 * as system output.
 */
const OWNER = "a".repeat(64);
const QUILL = "b".repeat(64);
const DRIFT = "c".repeat(64);
const CH = "1ed7db5f-b39b-46ad-8506-24899dc038db";

function host(withControl: boolean) {
  const published: FezEvent[] = [];
  const controls: { to: string; frame: Record<string, unknown> }[] = [];
  let handler: ((e: FezEvent) => void) | undefined;
  let n = 0;
  const seed: FezEvent[] = [
    { id: "1".repeat(64), kind: KIND_AGENT_METADATA, pubkey: QUILL, created_at: 1, content: JSON.stringify({ name: "quill" }), tags: [] },
    { id: "2".repeat(64), kind: KIND_AGENT_METADATA, pubkey: DRIFT, created_at: 1, content: JSON.stringify({ name: "drift" }), tags: [] },
    { id: "3".repeat(64), kind: KIND_MEMBERSHIP, pubkey: OWNER, created_at: 1, content: "", tags: [["d", ROSTER_D], ["p", OWNER], ["p", QUILL], ["p", DRIFT]] },
  ];
  const nostr: EngineNostr = {
    pubkey: OWNER,
    publish: async (tmpl) => {
      const event = { ...tmpl, id: String(++n).padStart(64, "0"), pubkey: OWNER, created_at: 1 } as FezEvent;
      published.push(event);
      return event;
    },
    subscribe: (_filters, h) => { handler = h; return () => {}; },
    query: async (filters) => seed.filter((e) => filters.some((f) => (f.kinds as number[]).includes(e.kind))),
    sendDm: async () => {},
    ...(withControl ? { control: async (to: string, frame: Record<string, unknown>) => { controls.push({ to, frame }); } } : {}),
  };
  return { nostr, published, controls, fire: (e: FezEvent) => handler!(e) };
}

function defs(yaml: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wf-wake-"));
  fs.writeFileSync(path.join(dir, "w.yaml"), yaml);
  return { defs: loadDefs(dir), stateFile: path.join(dir, "state.json") };
}

const trigger: FezEvent = { id: "d".repeat(64), kind: KIND_CHANNEL_MESSAGE, pubkey: DRIFT, created_at: 2, content: "hello there", tags: [["h", CH]] };

async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const traces = (published: FezEvent[]) => published.filter((e) => e.kind === KIND_WORKFLOW_RUN).map((e) => JSON.parse(e.content) as { status: string; detail?: string });

const wakeDef = `name: w\nchannel: ${CH}\ntrigger: { on: message, from: drift }\nsteps:\n  - wake: { agent: quill, text: "one sentence: {{trigger.text}}" }\n`;

describe("wake step", () => {
  test("sends one control frame into the trigger's thread and posts nothing", async () => {
    const h = host(true);
    const { defs: d, stateFile } = defs(wakeDef);
    const engine = await startWorkflowEngine({ nostr: h.nostr, owner: OWNER, defs: d, stateFile, channelIds: async () => [CH] });
    h.fire(trigger);
    await until(() => traces(h.published).some((t) => t.status === "done"));
    engine.stop();
    expect(h.controls).toEqual([{ to: QUILL, frame: { cmd: "wake", ts: expect.any(Number), channel: CH, root: trigger.id, reply: trigger.id, depth: 1, text: "one sentence: hello there" } }]);
    expect(h.published.filter((e) => e.kind === KIND_CHANNEL_MESSAGE)).toEqual([]);
  });

  test("a host without control fails the run rather than posting a summons", async () => {
    const h = host(false);
    const { defs: d, stateFile } = defs(wakeDef);
    const engine = await startWorkflowEngine({ nostr: h.nostr, owner: OWNER, defs: d, stateFile, channelIds: async () => [CH] });
    h.fire(trigger);
    await until(() => traces(h.published).some((t) => t.status === "failed"));
    engine.stop();
    expect(traces(h.published).find((t) => t.status === "failed")?.detail).toMatch(/owner identity/);
    expect(h.published.filter((e) => e.kind === KIND_CHANNEL_MESSAGE)).toEqual([]);
  });

  test("what a workflow does say is tagged with its name", async () => {
    const h = host(true);
    const { defs: d, stateFile } = defs(`name: loud\nchannel: ${CH}\ntrigger: { on: message, from: drift }\nsteps:\n  - say: "noted"\n`);
    const engine = await startWorkflowEngine({ nostr: h.nostr, owner: OWNER, defs: d, stateFile, channelIds: async () => [CH] });
    h.fire(trigger);
    await until(() => traces(h.published).some((t) => t.status === "done"));
    engine.stop();
    const said = h.published.find((e) => e.kind === KIND_CHANNEL_MESSAGE)!;
    expect(said.tags).toContainEqual(["workflow", "loud"]);
  });
});
