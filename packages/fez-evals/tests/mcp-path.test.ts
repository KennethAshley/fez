import { describe, it, expect } from "vitest";
import { fezMcpLaunch } from "../../fez-acp/src/mcp-path.js";

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
