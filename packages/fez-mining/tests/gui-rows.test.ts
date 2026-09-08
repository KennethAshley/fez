import { describe, expect, it } from "vitest";
import { subnetRows, machineChoices, HARDWARE_GATED } from "../src/gui-rows.js";

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
    const c = machineChoices({ gpu: "24GB" });
    expect(c.find((x) => x.choice === "local")).toMatchObject({
      enabled: false,
      reason: "needs a 24GB GPU",
    });
    expect(c.find((x) => x.choice === "lium")).toMatchObject({ enabled: true });
  });

  it("publicEndpoint requirement disables local (no public port) and enables lium", () => {
    const c = machineChoices({ publicEndpoint: true });
    expect(c.find((x) => x.choice === "local")).toMatchObject({
      enabled: false,
      reason: "validators must reach this miner — your Mac has no public port",
    });
    expect(c.find((x) => x.choice === "lium")).toMatchObject({ enabled: true });
  });

  it("no requirement → local only, no picker", () => {
    expect(machineChoices(undefined)).toEqual([{ choice: "local", enabled: true }]);
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
