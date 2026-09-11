import { afterEach, expect, it, vi } from "vitest";
import { buildApi, setClientBackend, setNostrBackend, type NostrAccess } from "../../../src/extensions/extensions.js";
import { FezClient } from "../../fez-client/dist/index.js";
import communities from "../../fez-communities/src/index.js";
import notifications from "../../fez-notifications/src/index.js";
import type { CommandHandler } from "../../../src/cli/commands.js";

const memory = { id: "memory", kind: 30174, pubkey: "agent", created_at: 1, tags: [["d", "core"]], content: "cipher", sig: "sig" };
function backend(): NostrAccess {
  return {
    pubkey: "owner",
    publish: async () => { throw new Error("unexpected publish"); },
    signEvent: () => { throw new Error("unexpected signing"); },
    query: async () => [memory],
    subscribe: () => () => {},
    encrypt: () => { throw new Error("unexpected encryption"); },
    decrypt: () => JSON.stringify({ slug: "core", profile: "Remember this profile" }),
    sendDm: async () => { throw new Error("unexpected DM"); },
    unwrapDm: () => undefined,
  };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([true, false])("/memory awaits decryption and handles its failure (granted: %s)", async (granted) => {
  vi.useFakeTimers(); // communities owns an observer-status interval
  const wire = backend();
  const client = new FezClient({ ...wire, decrypt: async (pk, text) => wire.decrypt(pk, text) });
  vi.spyOn(client, "pkByName").mockReturnValue("agent");
  setClientBackend(client);
  setNostrBackend(wire);
  const commands = new Map<string, CommandHandler>();
  communities({
    ...buildApi(["commands", "ui", "read:channels", ...(granted ? ["sign"] : [])], "communities"),
    registerCommand: (name, handler) => { commands.set(name, handler); },
  });
  const replies: string[] = [];
  await commands.get("memory")!("agent", { reply: text => replies.push(text) });
  expect(replies).toHaveLength(1);
  expect(replies[0]).toContain(granted ? "Remember this profile" : "has no memory yet");
});

it("notifications tolerate denied optional DM reads inside the relay callback", () => {
  let receive: Parameters<NostrAccess["subscribe"]>[1] | undefined;
  const unwrapDm = vi.fn(() => undefined);
  setNostrBackend({
    ...backend(),
    unwrapDm,
    subscribe: (_filters, handler) => { receive = handler; return () => {}; },
  });
  notifications(buildApi(["commands", "ui", "read:channels"], "notifications"));
  expect(receive).toBeTypeOf("function");
  expect(() => receive!({ ...memory, kind: 1059 })).not.toThrow();
  expect(unwrapDm).not.toHaveBeenCalled();
});
