import { describe, expect, it } from "vitest";
import { minerRootLine, parseMinerRoot } from "../src/thread.js";

describe("miner root line", () => {
  it("round-trips netuid + persona", () => {
    const line = minerRootLine(553, "quill");
    expect(line).toBe("⛏ mining · netuid 553 · persona quill");
    expect(parseMinerRoot(line)).toEqual({ netuid: 553, persona: "quill" });
  });
  it("rejects unrelated content", () => {
    expect(parseMinerRoot("hello world")).toBeNull();
    expect(parseMinerRoot("⛏ mining · netuid abc · persona x")).toBeNull();
  });
});
