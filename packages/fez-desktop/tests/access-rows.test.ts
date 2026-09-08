import { describe, expect, test } from "vitest";
import { accessRows } from "../src/access-rows.js";

const PK_A = "a".repeat(64);
const PK_B = "b".repeat(64);
const PK_C = "c".repeat(64);

describe("allowlist picker rows", () => {
  test("guests are offered after workspace names, tagged as guests", () => {
    const rows = accessRows([[PK_A, "quill"]], [{ pk: PK_B, name: "lebron" }], []);
    expect(rows).toEqual([
      { pk: PK_A, name: "quill" },
      { pk: PK_B, name: "lebron", guest: true },
    ]);
  });

  test("a guest who later published a profile shows once, as the workspace name", () => {
    const rows = accessRows([[PK_B, "lebron-pro"]], [{ pk: PK_B, name: "lebron" }], []);
    expect(rows).toEqual([{ pk: PK_B, name: "lebron-pro" }]);
  });

  test("an already-allowlisted pubkey nobody can name still gets a row", () => {
    const rows = accessRows([], [], [PK_C]);
    expect(rows).toEqual([{ pk: PK_C, name: `${PK_C.slice(0, 8)}…` }]);
  });

  test("a nameless guest falls back to short hex", () => {
    expect(accessRows([], [{ pk: PK_B }], [])[0].name).toBe(`${PK_B.slice(0, 8)}…`);
  });

  test("this machine's own agents are hidden — their checkbox does nothing", () => {
    const rows = accessRows([[PK_A, "quill"], [PK_B, "lebron"]], [], [], new Set([PK_A]));
    expect(rows).toEqual([{ pk: PK_B, name: "lebron" }]);
  });

  test("an own agent that is already ticked stays visible so it can be unticked", () => {
    const rows = accessRows([[PK_A, "quill"]], [], [PK_A], new Set([PK_A]));
    expect(rows).toEqual([{ pk: PK_A, name: "quill" }]);
  });
});
