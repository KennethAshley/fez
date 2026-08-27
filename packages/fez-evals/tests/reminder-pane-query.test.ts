import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket as WsSocket } from "ws";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { startRelay, type RelayHandle } from "../../fez-relay/dist/relay.js";

/**
 * The reminders pane lists nothing after ◷ → 20m.
 *
 * setReminder publishes a 40007 tagged ["p", self]; the pane queries with
 * BOTH `authors` and `#p`. The client's own arming subscription filters on
 * `authors` ALONE, so the two paths disagree about the filter — and every
 * existing reminder test uses a fake wire whose query inspects only
 * `kinds`, which cannot see a tag-filter problem at all. This asks a REAL
 * relay the question the pane asks.
 */
const PORT = 7913;
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const KIND_REMINDER = 40007;

let relay: RelayHandle;

function ask(filter: Record<string, unknown>): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const ws = new WsSocket(`ws://127.0.0.1:${PORT}`);
    const got: unknown[] = [];
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify(["REQ", "s1", filter])));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as unknown[];
      if (msg[0] === "EVENT") got.push(msg[2]);
      if (msg[0] === "EOSE") { ws.close(); resolve(got); }
    });
  });
}

beforeAll(async () => {
  relay = await startRelay({ port: PORT });
  // Exactly what FezClient.setReminder writes.
  const event = finalizeEvent(
    {
      kind: KIND_REMINDER,
      tags: [["p", pk]],
      content: JSON.stringify({ note: "scout: hello", remind_at: Math.floor(Date.now() / 1000) + 1200 }),
      created_at: Math.floor(Date.now() / 1000),
    },
    sk
  );
  await new Promise<void>((resolve, reject) => {
    const ws = new WsSocket(`ws://127.0.0.1:${PORT}`);
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify(["EVENT", event])));
    ws.on("message", () => { ws.close(); resolve(); });
  });
});

afterAll(async () => { await relay?.close?.(); });

describe("the filter the reminders pane actually sends", () => {
  test("the client's own arming filter finds it", async () => {
    expect(await ask({ kinds: [KIND_REMINDER], authors: [pk], limit: 200 })).toHaveLength(1);
  });

  test("the PANE's filter finds it too", async () => {
    expect(
      await ask({ kinds: [KIND_REMINDER], authors: [pk], "#p": [pk], limit: 200 })
    ).toHaveLength(1);
  });
});
