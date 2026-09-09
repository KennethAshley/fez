import { describe, expect, it } from "vitest";
import { subnetRows, machineChoices, stackFor, HARDWARE_GATED } from "../src/gui-rows.js";

describe("subnetRows", () => {
  it("badges covered subnets and sorts them first", () => {
    const rows = subnetRows(
      [{ netuid: 1, name: "one" }, { netuid: 553, name: "bazaar" }],
      [553]
    );
    expect(rows[0]).toMatchObject({ netuid: 553, curated: true });
    expect(rows[1]).toMatchObject({ netuid: 1, curated: false });
  });
});

describe("machineChoices", () => {
  it("gpu requirement disables local (needs GPU) and enables lium", () => {
    const c = machineChoices({ gpu: "24GB" }, false);
    expect(c.find((x) => x.choice === "local")).toMatchObject({
      enabled: false,
      reason: "needs a 24GB GPU",
    });
    expect(c.find((x) => x.choice === "lium")).toMatchObject({ enabled: true });
  });

  it("publicEndpoint requirement disables local (no public port) and enables lium", () => {
    const c = machineChoices({ publicEndpoint: true }, false);
    expect(c.find((x) => x.choice === "local")).toMatchObject({
      enabled: false,
      reason: "validators must reach this miner — your Mac has no public port",
    });
    expect(c.find((x) => x.choice === "lium")).toMatchObject({ enabled: true });
  });

  it("no requirement → local only, no picker", () => {
    expect(machineChoices(undefined, false)).toEqual([{ choice: "local", enabled: true }]);
  });

  it("publicEndpoint offers ssh — a host you already run satisfies it", () => {
    const c = machineChoices({ publicEndpoint: true }, false);
    expect(c.map((x) => x.choice)).toEqual(["local", "ssh", "lium", "do"]);
    expect(c.find((x) => x.choice === "ssh")).toMatchObject({ enabled: true });
  });

  it("gpu requirement offers ssh too — the user may own the hardware; the caveat lives in the label", () => {
    const sshChoice = machineChoices({ gpu: "24GB" }, false).find((x) => x.choice === "ssh");
    expect(sshChoice).toMatchObject({ enabled: true });
    expect(sshChoice?.reason).toMatch(/24GB GPU/);
    expect(sshChoice?.reason).toMatch(/can't check/);
  });

  it("remote-needing subnets offer DO when a token exists, disabled with the fix when not", () => {
    const withTok = machineChoices({ publicEndpoint: true }, true);
    expect(withTok.find((x) => x.choice === "do")).toMatchObject({ enabled: true });
    const noTok = machineChoices({ publicEndpoint: true }, false);
    expect(noTok.find((x) => x.choice === "do")).toMatchObject({ enabled: false });
    expect(noTok.find((x) => x.choice === "do")?.reason).toMatch(/DO_API_TOKEN/);
  });

  it("no-requirement subnets still skip the picker entirely", () => {
    expect(machineChoices(undefined, true)).toEqual([{ choice: "local", enabled: true }]);
  });
});

describe("gated badge", () => {
  it("marks hardware-gated netuids", () => {
    const rows = subnetRows([{ netuid: 4, name: "targon" }], [], HARDWARE_GATED);
    expect(rows[0]).toMatchObject({ gated: true, curated: false });
  });

  it("does not gate netuids outside the list", () => {
    const rows = subnetRows([{ netuid: 553, name: "bazaar" }], [553], HARDWARE_GATED);
    expect(rows[0]).toMatchObject({ gated: false, curated: true });
  });
});

describe("stackFor — subnet stacking components", () => {
  it("bazaar composes with Chutes (curated)", () => {
    expect(stackFor(553, undefined)).toEqual([64]);
  });
  it("an endpoint requirement composes with Lium", () => {
    expect(stackFor(56, { publicEndpoint: true })).toEqual([51]);
  });
  it("a gpu requirement composes with Lium", () => {
    expect(stackFor(99, { gpu: "A100" })).toEqual([51]);
  });
  it("no requirement, no curation → no stack", () => {
    expect(stackFor(7, undefined)).toEqual([]);
  });
});

describe("release freeze", () => {
  it("a frozen curated subnet is marked and never mineable-ranked", () => {
    const rows = subnetRows([{ netuid: 56, name: "gradients" }], [56], [], [56]);
    expect(rows[0]).toMatchObject({ curated: true, frozen: true });
  });
  it("unlisted netuids stay unfrozen", () => {
    expect(subnetRows([{ netuid: 553, name: "bazaar" }], [553], [], [56])[0].frozen).toBe(false);
  });
});
