import { describe, it, expect } from "vitest";
import { skillEntryFor } from "@fezchat/protocol";

/**
 * What an install writes into settings.json. The point of the extra
 * fields is that the SAME package produces the same `package` value
 * however it arrived — that's what lets a persona find it under a
 * different local key.
 */
describe("skill provenance recorded at install", () => {
  const part = { command: "node", args: ["/abs/path/dist/mcp.js"] };

  it("records package and description from the manifest", () => {
    expect(
      skillEntryFor(part, { manifestName: "@fezchat/wallet", description: "pay and receive TAO", source: "npm:@fezchat/wallet" })
    ).toEqual({
      command: "node",
      args: ["/abs/path/dist/mcp.js"],
      package: "@fezchat/wallet",
      source: "npm:@fezchat/wallet",
      description: "pay and receive TAO",
    });
  });

  it("a linked package records its package but no source — there is no spec that fetches it", () => {
    expect(skillEntryFor(part, { manifestName: "@fezchat/wallet", description: "pay and receive TAO" })).toEqual({
      command: "node",
      args: ["/abs/path/dist/mcp.js"],
      package: "@fezchat/wallet",
      description: "pay and receive TAO",
    });
  });

  it("omits fields rather than writing empty ones — a hand-rolled skill stays clean", () => {
    expect(skillEntryFor(part, {})).toEqual({ command: "node", args: ["/abs/path/dist/mcp.js"] });
  });

  it("keeps env the caller merged in", () => {
    expect(skillEntryFor({ ...part, env: { TOKEN: "x" } }, { manifestName: "pkg" })).toEqual({
      command: "node",
      args: ["/abs/path/dist/mcp.js"],
      env: { TOKEN: "x" },
      package: "pkg",
    });
  });
});
