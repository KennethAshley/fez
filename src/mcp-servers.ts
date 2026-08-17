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

/**
 * Settings-backed skills (~/.fez/settings.json "mcpServers") — the
 * headless registry. Extensions can still register programmatically in
 * the TUI, but agents spawned by the sentinel/herdr load their skills
 * from here: a persona's `mcpServers: [web-search]` only means
 * something if settings define what "web-search" IS. Shapes pass
 * through to the ACP SDK untouched:
 *   "web-search": { "command": "npx", "args": ["-y", "some-mcp"], "env": {"KEY": "..."} }
 *   "hosted":     { "type": "http", "url": "https://...", "headers": [] }
 */
let settingsLoaded = false;
export function loadMcpServersFromSettings(
  entries: Record<string, Record<string, unknown>> | undefined
): void {
  if (settingsLoaded || !entries) return;
  settingsLoaded = true;
  for (const [name, config] of Object.entries(entries)) {
    if (!config || typeof config !== "object") continue;
    const server = { name, ...(config.command && !config.type ? { type: undefined } : {}), ...config } as unknown as McpServer;
    if (registry.has(name)) continue;
    registry.set(name, server);
  }
}
