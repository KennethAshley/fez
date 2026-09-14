import { describe, it, expect } from "vitest";
import { bindMcpPersona, fezMcpLaunch, resolveNodeCommand } from "../../fez-acp/src/mcp-path.js";

describe("bindMcpPersona", () => {
  it("replaces a registry-authored persona on cloned stdio configs", () => {
    const authored = { name: "computer-use", command: "node", args: ["mcp.js"], env: [
      { name: "TOKEN", value: "secret" }, { name: "FEZ_AGENT_PERSONA", value: "spoofed" },
    ] };
    const [bound] = bindMcpPersona([authored], "researcher");

    expect(bound).toEqual({ ...authored, env: [
      { name: "TOKEN", value: "secret" }, { name: "FEZ_AGENT_PERSONA", value: "researcher" },
    ] });
    expect(bound).not.toBe(authored);
    expect(authored.env[1].value).toBe("spoofed");
  });

  it("leaves HTTP configs unchanged", () => {
    const http = { name: "remote", type: "http", url: "https://example.test/mcp", headers: [] };
    const [bound] = bindMcpPersona([http], "researcher");
    expect(bound).toEqual(http);
    expect(bound).not.toBe(http);
  });
});

/**
 * Why this exists: EVERY desktop-spawned agent was running without fez_*
 * tools — while its prompt claimed it had them. Two compiled-binary traps
 * stacked: the dev path resolves through import.meta.url, which inside a
 * bun-compiled fez-agent points into the virtual filesystem (the same
 * ENOENT the bazaar validator documented), and the launch used
 * process.execPath as the runtime — which in a compiled binary is
 * fez-agent ITSELF, so even a found server.js would have booted a second
 * agent instead of the MCP server. Found live: "⚠️ fez-mcp not built" in
 * every desktop agent's boot log, drift writing memory through the shell.
 */
describe("fezMcpLaunch", () => {
  const devUrl = "file:///repo/packages/fez-acp/src/agent.ts";

  it("dev: runs the repo's server.js with the current runtime", () => {
    const { launch } = fezMcpLaunch({
      importMetaUrl: devUrl,
      execPath: "/usr/local/bin/bun",
      exists: (p) => p === "/repo/packages/fez-mcp/dist/server.js",
    });
    expect(launch).toEqual({ command: "/usr/local/bin/bun", args: ["/repo/packages/fez-mcp/dist/server.js"] });
  });

  it("compiled: runs the SIBLING fez-mcp binary directly — never execPath with a script", () => {
    const { launch } = fezMcpLaunch({
      importMetaUrl: "file:///$bunfs/root/agent.ts",
      execPath: "/Users/x/.fez/bin/fez-agent",
      exists: (p) => p === "/Users/x/.fez/bin/fez-mcp",
    });
    expect(launch).toEqual({ command: "/Users/x/.fez/bin/fez-mcp", args: [] });
  });

  it("dev path wins when both exist — source runs should test source tools", () => {
    const { launch } = fezMcpLaunch({
      importMetaUrl: devUrl,
      execPath: "/usr/local/bin/bun",
      exists: () => true,
    });
    expect(launch?.args[0]).toBe("/repo/packages/fez-mcp/dist/server.js");
  });

  it("neither: no launch, and the warning can name both places it looked", () => {
    const { launch, tried } = fezMcpLaunch({
      importMetaUrl: devUrl,
      execPath: "/Users/x/.fez/bin/fez-agent",
      exists: () => false,
    });
    expect(launch).toBeUndefined();
    expect(tried).toHaveLength(2);
    expect(tried[1]).toBe("/Users/x/.fez/bin/fez-mcp");
  });
});

/**
 * resolveNodeCommand — a skill entry's bare `command: node` dies on the
 * GUI PATH (no node on an nvm machine), and the harness proceeds without
 * the tool, silently. The resolver prefers the managed runtime fez
 * itself installs, newest version first, then the standard homes.
 */
describe("resolveNodeCommand", () => {
  const home = "/Users/x";
  const managed = (v: string) => `/Users/x/.fez/runtimes/node/${v}/darwin-arm64/bin/node`;

  it("prefers the newest managed runtime", () => {
    const disk = new Set([managed("v24.18.0"), managed("v22.1.0"), "/opt/homebrew/bin/node"]);
    const got = resolveNodeCommand({ home, exists: (p) => disk.has(p), list: () => ["v22.1.0", "v24.18.0"] });
    expect(got).toBe(managed("v24.18.0"));
  });

  it("falls back to the standard homes when no managed runtime exists", () => {
    const disk = new Set(["/usr/local/bin/node"]);
    const got = resolveNodeCommand({ home, exists: (p) => disk.has(p), list: () => { throw new Error("ENOENT"); } });
    expect(got).toBe("/usr/local/bin/node");
  });

  it("returns undefined when node is nowhere — the caller warns, loudly", () => {
    const got = resolveNodeCommand({ home, exists: () => false, list: () => [] });
    expect(got).toBeUndefined();
  });
});
