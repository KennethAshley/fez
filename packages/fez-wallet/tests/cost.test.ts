import { describe, expect, it } from "vitest";
import { costResult } from "../src/cli-commands.js";

describe("costResult", () => {
  it("shapes rao into the json the gui reads", () => {
    // 1 TAO = 1e9 rao
    expect(costResult(553, 500_000_000n)).toEqual({ netuid: 553, rao: "500000000", tao: "0.5" });
  });
});
