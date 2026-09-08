import { describe, expect, it } from "vitest";
import miners from "../src/miner-part.js";

describe("gradients descriptor", () => {
  it("declares SN56 with a GPU requirement", () => {
    expect(miners).toHaveLength(1);
    expect(miners[0]).toMatchObject({ netuid: 56, name: "gradients", requirements: { gpu: "24GB", alwaysOn: true } });
    expect(typeof miners[0].start).toBe("function");
  });
});
