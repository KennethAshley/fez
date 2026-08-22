/**
 * Where a skill COMES FROM — the browser-safe mirror.
 *
 * The canonical implementation is src/skill-source.ts in @fezchat/protocol,
 * which is Node-only (it lives beside the persona loader and the
 * settings writer). The GUI needs the same parser to render a command
 * before consent, and the GUI cannot import Node. Same arrangement as
 * kinds.ts ↔ K, and same defence: skill-source.test.ts runs BOTH
 * implementations over one adversarial case table and fails on any
 * disagreement, so a scheme added to one and not the other is a red
 * test rather than a GUI that installs something the CLI would refuse.
 *
 * The rule this file exists to enforce, restated because it is the
 * whole point: a persona declares WHICH PUBLISHED PACKAGE it wants, and
 * never a command. Personas travel — if `command:` were reachable from
 * frontmatter, installing one would be arbitrary code execution wearing
 * a YAML key. And a bare name (`web-search`) deliberately resolves to
 * nothing: npm has at least three unrelated packages answering to it,
 * so a name is an alias, not an identifier.
 */

/** Exactly what settings.json stores under mcpServers[name]. */
export interface SkillSpec {
  command?: string;
  args?: string[];
  type?: string;
  url?: string;
  env?: Record<string, string>;
}

const RUNNERS: Record<string, (pkg: string) => SkillSpec> = {
  "npm:": (pkg) => ({ command: "npx", args: ["-y", pkg] }),
  "uvx:": (pkg) => ({ command: "uvx", args: [pkg] }),
  "pipx:": (pkg) => ({ command: "pipx", args: ["run", pkg] }),
};

export const SOURCE_SCHEMES = [...Object.keys(RUNNERS), "https://", "http://"];

/** npm's grammar and the subset PyPI shares — no paths, flags, whitespace or versions. */
const PACKAGE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

export function parseSkillSource(spec: string): SkillSpec | undefined {
  const trimmed = spec.trim();
  if (!trimmed) return undefined;

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.username || url.password) return undefined;
      return { type: "http", url: url.toString() };
    } catch {
      return undefined;
    }
  }

  for (const [scheme, run] of Object.entries(RUNNERS)) {
    if (!trimmed.toLowerCase().startsWith(scheme)) continue;
    const pkg = trimmed.slice(scheme.length);
    return PACKAGE.test(pkg) ? run(pkg) : undefined;
  }
  return undefined;
}

/** The command line a spec resolves to, for rendering before consent. */
export function describeSkillSpec(config: SkillSpec): string {
  return config.url ?? [config.command, ...(config.args ?? [])].filter(Boolean).join(" ");
}

/**
 * Does this config name a path that only exists HERE? Returns the
 * offending argument, or undefined when the command is portable.
 *
 * A listing carries a pointer, never bytes. Publish `node
 * /Users/me/proj/dist/mcp.js` and the installer gets that path verbatim,
 * then their agents spawn against a directory that isn't there — and it
 * fails silently, because an MCP server that won't start looks exactly
 * like a skill nobody declared.
 */
export function machineLocalPath(config: SkillSpec | undefined): string | undefined {
  return (config?.args ?? []).find((arg) => /^(\/|~|\.\.?\/)/.test(arg));
}

/** The one bare name that resolves, because fez owns the @fez npm scope. */
export function wellKnownSource(name: string): string | undefined {
  const match = /^fez-([\w-]+)$/.exec(name);
  return match ? `npm:@fezchat/${match[1]}` : undefined;
}

/**
 * `[web-search=npm:@brave/x, github]` → names plus the sources declared
 * for them. Splits on the FIRST `=` only: a spec is itself full of
 * colons and slashes, and `npm:@scope/pkg` must survive intact.
 */
export function parseSkillEntries(entries: string[]): { names: string[]; sources: Record<string, string> } {
  const names: string[] = [];
  const sources: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    const name = (eq === -1 ? entry : entry.slice(0, eq)).trim();
    if (!name) continue;
    names.push(name);
    const source = eq === -1 ? "" : entry.slice(eq + 1).trim();
    if (source) sources[name] = source;
  }
  return { names, sources };
}

/** Render a skill list back into frontmatter form, sources preserved. */
export function formatSkillEntries(names: string[], sources: Record<string, string>): string {
  return names.map((name) => (sources[name] ? `${name}=${sources[name]}` : name)).join(", ");
}
