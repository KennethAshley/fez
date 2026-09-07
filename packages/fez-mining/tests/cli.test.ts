import { describe, expect, it } from "vitest";
import { statusRows } from "../src/cli.js";

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
