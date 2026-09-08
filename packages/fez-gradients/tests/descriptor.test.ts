import { describe, expect, it } from "vitest";
import miners from "../src/miner-part.js";

describe("gradients descriptor", () => {
  it("declares SN56 with a public-endpoint requirement, no GPU floor", () => {
    expect(miners).toHaveLength(1);
    expect(miners[0]).toMatchObject({
      netuid: 56,
      name: "gradients",
      requirements: { alwaysOn: true, publicEndpoint: true },
    });
    expect(miners[0].requirements?.gpu).toBeUndefined();
    expect(typeof miners[0].start).toBe("function");
  });
});
