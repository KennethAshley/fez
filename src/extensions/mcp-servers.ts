import { execFileSync } from "node:child_process";
import type { McpServer } from "@agentclientprotocol/sdk";
import { resolveInstalledSkill, type SkillEntry } from "./skill-source.js";
import { markOAuthServer } from "./connections.js";

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
 * something if settings define what "web-search" IS. Authored in
 * convenient JSON (env as an object), normalized into the ACP shape here:
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
    if (registry.has(name)) continue;
    registry.set(name, normalizeSettingsServer(name, config));
  }
}

/**
 * A settings entry is authored in convenient JSON, but the ACP SDK's
 * McpServer union is strict: a stdio server MUST carry `command`,
 * `args: string[]` and `env: EnvVariable[]` (name/value pairs) — env as an
 * object silently loses the stdio branch, and the union error then blames
 * the http branch's missing `url`/`headers` (the confusing symptom this
 * fixes). An http/sse server needs `headers: HttpHeader[]`. Both arrays are
 * required, so they default to [] rather than being dropped.
 */
function normalizeSettingsServer(name: string, config: Record<string, unknown>): McpServer {
  const type = typeof config.type === "string" ? config.type : undefined;
  if (config.command) {
    return {
      name,
      command: String(config.command),
      args: Array.isArray(config.args) ? (config.args as string[]) : [],
      env: resolveEnv(name, config.env as Record<string, string> | undefined) ?? [],
    } as unknown as McpServer;
  }
  if ((type === "http" || type === "sse") && config.url) {
    // auth:"oauth" — fez owns the token lifecycle (see connections.ts);
    // the Authorization header is injected FRESH at spawn by
    // withFreshOAuth, so nothing static is resolved here.
    if (config.auth === "oauth") markOAuthServer(name);
    return {
      name,
      type,
      url: String(config.url),
      headers: resolveHeaders(name, config.headers as { name: string; value: string }[] | undefined) ?? [],
    } as unknown as McpServer;
  }
  // Unknown shape (e.g. an "acp" server): pass through best-effort.
  return { name, ...config } as unknown as McpServer;
}

/**
 * Secret env values live in the OS keychain (service "fez-skill-env",
 * account "<skill>.<KEY>") — same custody as the identity key, set
 * write-only from the GUI or `security` directly. settings.json keeps
 * only the NAMES (empty values); a filled plaintext value still works
 * but the keychain wins. Resolved once, at spawn time.
 */
function resolveEnv(
  skill: string,
  env: Record<string, string> | { name: string; value: string }[] | undefined
): { name: string; value: string }[] | undefined {
  if (!env) return undefined;
  // Authored form is an object; tolerate an already-ACP array too.
  const pairs = Array.isArray(env)
    ? env.map((e) => [e.name, e.value] as const)
    : Object.entries(env);
  if (pairs.length === 0) return undefined;
  return pairs.map(([key, plaintext]) => ({ name: key, value: keychainSecret(skill, key) ?? plaintext }));
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

/**
 * Split what a persona declared into what this machine can provide and
 * what it can't. The gap is returned rather than swallowed: a spawn
 * proceeds without the skill and the agent is told to say so, which is
 * the honest failure mode — a confidently wrong answer is the bad one.
 *
 * `name` on a resolved entry is what the PERSONA declared, never the
 * local catalog key. The agent's tool namespace is the persona's
 * vocabulary; this machine's filing system stays private to it.
 */
export function resolveDeclaredSkills(
  catalog: Record<string, SkillEntry>,
  declared: { name: string; source?: string }[]
): {
  resolved: { name: string; key: string; entry: SkillEntry }[];
  missing: { name: string; source?: string }[];
} {
  const resolved: { name: string; key: string; entry: SkillEntry }[] = [];
  const missing: { name: string; source?: string }[] = [];
  for (const decl of declared) {
    const hit = resolveInstalledSkill(catalog, decl);
    if (hit) resolved.push({ name: decl.name, key: hit.key, entry: hit.entry });
    else missing.push({ name: decl.name, source: decl.source });
  }
  return { resolved, missing };
}
