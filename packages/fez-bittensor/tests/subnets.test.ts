import { describe, expect, it } from "vitest";
import { subnetFromIdentity } from "../src/subnets.js";

const hex = (s: string) => "0x" + Buffer.from(s, "utf8").toString("hex");

describe("subnetFromIdentity", () => {
  it("decodes hex identity fields", () => {
    const s = subnetFromIdentity(64, {
      subnetName: hex("chutes"),
      description: hex("serverless compute"),
      githubRepo: hex("https://github.com/rayonlabs/chutes"),
      subnetUrl: hex("https://chutes.ai"),
    });
    expect(s).toEqual({
      netuid: 64,
      name: "chutes",
      description: "serverless compute",
      github: "https://github.com/rayonlabs/chutes",
      url: "https://chutes.ai",
      contact: "",
      discord: "",
    });
  });
  it("falls back to a placeholder name on an empty identity", () => {
    expect(subnetFromIdentity(7, {}).name).toBe("subnet 7");
  });
});
