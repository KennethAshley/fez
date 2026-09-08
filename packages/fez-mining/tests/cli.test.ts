import { describe, expect, it } from "vitest";
import { statusRows, machineNodeRows } from "../src/cli.js";

describe("statusRows", () => {
  it("annotates miners with liveness", () => {
    const rows = statusRows(
      [{ netuid: 553, persona: "quill", hotkey: "5F", desired: "running", pid: 1 }],
      (pid) => pid === 1
    );
    expect(rows[0]).toMatchObject({ netuid: 553, alive: true });
    const dead = statusRows(
      [{ netuid: 553, persona: "quill", hotkey: "5F", desired: "running", pid: 999999 }],
      () => false
    );
    expect(dead[0].alive).toBe(false);
  });
});

describe("machineNodeRows", () => {
  it("pulls node id (huid preferred) and hourly price from lium ls rows", () => {
    const rows = machineNodeRows([
      { huid: "eager-wolf-aa", id: "42", price_per_hour: "1.50" },
      { id: "7", price_per_hour: "0" }, // priceOf treats non-positive as unreadable
    ]);
    expect(rows).toEqual([
      { node: "eager-wolf-aa", usdHour: 1.5 },
      { node: "7", usdHour: null },
    ]);
  });
});
