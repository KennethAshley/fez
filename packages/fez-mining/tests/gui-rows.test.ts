import { describe, expect, it } from "vitest";
import { subnetRows } from "../src/gui-rows.js";

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
