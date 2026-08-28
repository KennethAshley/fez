import { describe, it, expect } from "vitest";
import { resolveDeclaredSkills } from "@fezchat/protocol";

/**
 * The spawn-time split: which declared skills this machine can actually
 * provide, and which are gaps the agent must disclose. Live case — the
 * author's @scout declares `mcpServers: [bittensor, fez-wallet]` while
 * @researcher declares a `github` that was never installed.
 */
describe("resolving a persona's declared skills at spawn", () => {
  const catalog = {
    "fez-wallet": { command: "node", args: ["/x/mcp.js"], package: "@fezchat/wallet", source: "npm:@fezchat/wallet" },
    bittensor: { command: "node", args: ["/y/mcp.js"], package: "@fezchat/bittensor" },
  };

  it("splits resolved from missing", () => {
    const out = resolveDeclaredSkills(catalog, [
      { name: "bittensor" },
      { name: "github" },
    ]);
    expect(out.resolved.map((r) => r.name)).toEqual(["bittensor"]);
    expect(out.missing).toEqual([{ name: "github", source: undefined }]);
  });

  it("a persona naming the package resolves against a differently-keyed entry", () => {
    const out = resolveDeclaredSkills(catalog, [{ name: "wallet", source: "npm:@fezchat/wallet" }]);
    expect(out.missing).toEqual([]);
    expect(out.resolved[0].key).toBe("fez-wallet");
    // The NAME the agent sees is what the persona declared, not the
    // local key — the prompt and the ACP session must not leak this
    // machine's filing system.
    expect(out.resolved[0].name).toBe("wallet");
  });

  it("preserves the declared source on a miss, so the caller can print an install hint", () => {
    const out = resolveDeclaredSkills(catalog, [{ name: "obsidian", source: "npm:@fezchat/obsidian" }]);
    expect(out.missing).toEqual([{ name: "obsidian", source: "npm:@fezchat/obsidian" }]);
  });

  it("an empty declaration list resolves to nothing, not an error", () => {
    expect(resolveDeclaredSkills(catalog, [])).toEqual({ resolved: [], missing: [] });
  });
});
