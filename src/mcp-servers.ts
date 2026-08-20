import { execFileSync } from "node:child_process";
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
    const resolved = {
      ...config,
      env: resolveEnv(name, config.env as Record<string, string> | undefined),
      headers: resolveHeaders(name, config.headers as { name: string; value: string }[] | undefined),
    };
    if (!resolved.env) delete (resolved as { env?: unknown }).env;
    if (!resolved.headers) delete (resolved as { headers?: unknown }).headers;
    const server = { name, ...(config.command && !config.type ? { type: undefined } : {}), ...resolved } as unknown as McpServer;
    if (registry.has(name)) continue;
    registry.set(name, server);
  }
}

/**
 * Secret env values live in the OS keychain (service "fez-skill-env",
 * account "<skill>.<KEY>") — same custody as the identity key, set
 * write-only from the GUI or `security` directly. settings.json keeps
 * only the NAMES (empty values); a filled plaintext value still works
 * but the keychain wins. Resolved once, at spawn time.
 */
function resolveEnv(skill: string, env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env || Object.keys(env).length === 0) return env;
  const out: Record<string, string> = {};
  for (const [key, plaintext] of Object.entries(env)) {
    out[key] = keychainSecret(skill, key) ?? plaintext;
  }
  return out;
}

/**
 * The same custody for a HOSTED skill's auth.
 *
 * An http MCP server authenticates with a header, not an env var, so a
 * hosted skill had no way to hold a secret: settings.json is a plaintext
 * file in a git-adjacent directory, and the keychain path only resolved
 * `env`. A header with an empty value is filled from the keychain under
 * the same service and the same "<skill>.<KEY>" account as env keys, so
 * `Authorization` and `GITHUB_TOKEN` are stored, listed and rotated by
 * one mechanism.
 */
function resolveHeaders(
  skill: string,
  headers: { name: string; value: string }[] | undefined
): { name: string; value: string }[] | undefined {
  if (!headers || headers.length === 0) return headers;
  return headers.map((header) => ({
    ...header,
    value: header.value?.trim() ? header.value : keychainSecret(skill, header.name) ?? "",
  }));
}

function keychainSecret(skill: string, key: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const value = execFileSync(
      "security",
      ["find-generic-password", "-s", "fez-skill-env", "-a", `${skill}.${key}`, "-w"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}
