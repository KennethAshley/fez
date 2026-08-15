import type { McpServer } from "@agentclientprotocol/sdk";

/**
 * Named MCP servers ("skills") personas can opt into via their
 * `mcpServers:` frontmatter — e.g. @researcher gets `web-search`,
 * @reviewer gets `obsidian`. Reuses the ACP SDK's own McpServer type
 * directly (no Fez-invented schema) so whatever's registered here is
 * exactly what SessionBuilder.withMcpServer() accepts, unchanged.
 *
 * Same registry pattern as harness.ts's registerHarness/findHarness: one
 * entry point, built-ins and extensions register through it identically.
 * Registering the config is Fez's job; where the config's secrets (auth
 * tokens, etc.) come from is the registering extension's own — typically
 * a .env file loaded at startup (see cli.ts) and read via process.env.
 */
const registry = new Map<string, McpServer>();

export function registerMcpServer(name: string, server: McpServer): void {
  if (registry.has(name)) {
    console.error(`⚠️  MCP server "${name}" is already registered — skipping duplicate`);
    return;
  }
  registry.set(name, server);
}

export function findMcpServer(name: string): McpServer | undefined {
  return registry.get(name);
}

export function listMcpServers(): string[] {
  return [...registry.keys()];
}
