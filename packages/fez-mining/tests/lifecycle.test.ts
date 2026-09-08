import { describe, expect, it } from "vitest";
import { lifecycleMessage } from "../src/lifecycle.js";

const base = { netuid: 553, persona: "quill", hotkey: "5F", desired: "running" as const };

describe("lifecycleMessage", () => {
  it("announces a fresh start", () => {
    expect(lifecycleMessage(undefined, { ...base })).toMatch(/started/i);
  });
  it("announces stop", () => {
    expect(lifecycleMessage({ ...base }, { ...base, desired: "stopped" })).toMatch(/stopped/i);
  });
  it("announces needs-attention", () => {
    expect(lifecycleMessage({ ...base }, { ...base, attention: "capped" })?.toLowerCase()).toContain("attention");
  });
  it("says nothing on a no-op poll", () => {
    expect(lifecycleMessage({ ...base }, { ...base })).toBeNull();
  });
  it("announces a reprovision", () => {
    const prev = { ...base, provisions: [1000] };
    const next = { ...base, provisions: [1000, 2000] };
    expect(lifecycleMessage(prev, next)).toMatch(/reprovision/i);
  });
  it("announces a death while desired running", () => {
    const prev = { ...base, lastExit: undefined };
    const next = { ...base, lastExit: "exit 1" };
    expect(lifecycleMessage(prev, next)).toMatch(/died|exit/i);
  });
  it("stays quiet when a stopped miner's lastExit is recorded", () => {
    const prev = { ...base, desired: "stopped" as const, lastExit: undefined };
    const next = { ...base, desired: "stopped" as const, lastExit: "exit 0" };
    expect(lifecycleMessage(prev, next)).toBeNull();
  });
});
