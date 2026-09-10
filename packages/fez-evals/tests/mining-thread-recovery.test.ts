import { afterEach, expect, it, vi } from "vitest";

const relay = vi.hoisted(() => ({ query: vi.fn(), disconnect: vi.fn() }));
vi.mock("@fezchat/protocol", () => ({
  getKey: () => "1".repeat(64),
  resolveRelays: (url: string) => [url],
  buildDmWraps: vi.fn(),
  RelayConnection: class {
    queryWithStatus = relay.query;
    disconnect = relay.disconnect;
  },
}));
import { findPersonaRoot } from "../../fez-mining/src/persona-post.js";

afterEach(() => vi.clearAllMocks());

it("refuses incomplete history before the caller can create a new root", async () => {
  relay.query.mockResolvedValue({ events: [], failures: [{ relay: "ws://fixture", reason: "timeout" }] });
  await expect(findPersonaRoot("scout", "channel", "root", undefined, "ws://fixture"))
    .rejects.toThrow("history could not be fully read");
  expect(relay.disconnect).toHaveBeenCalledOnce();
});

it("accepts a completed empty read and validates a recovered legacy root's channel", async () => {
  relay.query.mockResolvedValueOnce({ events: [], failures: [] });
  expect(await findPersonaRoot("scout", "channel", "root")).toBeUndefined();
  relay.query.mockResolvedValueOnce({ failures: [], events: [
    { id: "wrong", kind: 47103, content: "root", tags: [["h", "other"]], created_at: 1 },
    { id: "reply", kind: 47103, content: "root", tags: [["h", "channel"], ["e", "parent", "", "root"]], created_at: 2 },
    { id: "saved", kind: 47103, content: "root", tags: [["h", "channel"]], created_at: 3 },
  ] });
  expect(await findPersonaRoot("scout", "channel", "root", "saved")).toBe("saved");
  expect(relay.disconnect).toHaveBeenCalledTimes(2);
});
