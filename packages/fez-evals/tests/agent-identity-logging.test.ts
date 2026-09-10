import { expect, test, vi } from "vitest";
import { Agent } from "../../../src/agent/agent.js";

test("a generated SDK identity logs only its public key", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const agent = new Agent({ relay: "ws://127.0.0.1:1", name: "test", supportedTasks: [] });
    const loggedKeys = log.mock.calls.flat().join(" ").match(/\b[0-9a-f]{64}\b/g);
    expect(loggedKeys?.length).toBe(1);
    expect(loggedKeys?.every(key => key === agent.getPubkey())).toBe(true);
  } finally {
    log.mockRestore();
  }
});
