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
 * A settings.json mcpServers entry, plus the provenance recorded at
 * install time. All three extra fields are optional: a hand-rolled
 * skill (`fez skill add --command …`) has none of them and stays a
 * first-class citizen — local names are a category, not a legacy.
 */
export interface SkillEntry extends SkillSpec {
  /** Canonical id, from the installed package's own package.json name. */
  package?: string;
  /** The spec that reinstalls it — feeds the `name=source` form. */
  source?: string;
  /** One line for a picker. */
  description?: string;
}

/**
 * The package a source spec names, or undefined when it doesn't name one.
 *
 * Runs the same PACKAGE grammar the runners do, so a spec that would be
 * refused at install can never match an installed entry here either —
 * otherwise `npm:../../etc/passwd` could alias its way onto a real skill.
 * A url names no package; its identity IS the url, matched at step 2.
 */
export function packageFromSource(source: string | undefined): string | undefined {
  if (!source) return undefined;
  for (const scheme of ["npm:", "uvx:", "pipx:"]) {
    if (source.startsWith(scheme)) {
      const pkg = source.slice(scheme.length);
      return PACKAGE.test(pkg) ? pkg : undefined;
    }
  }
  return undefined;
}

/**
 * Find the catalog entry a declared skill means. Trust order:
 *
 *  1. the LOCAL KEY — this machine's own answer for that name, already
 *     approved by a human. Never overridden by a package match.
 *  2. the declared SOURCE, matched verbatim — covers hosted (url) skills,
 *     which name no package.
 *  3. the PACKAGE the source names — the fix. `fez install
 *     npm:@fezchat/wallet` keys it "wallet" and `fez link` keys it
 *     "fez-wallet"; a persona declaring either source resolves to
 *     whichever one this machine happens to have.
 *
 * Undefined means genuinely not installed. The caller reports the gap;
 * it never installs on the persona's say-so.
 */
export function resolveInstalledSkill(
  catalog: Record<string, SkillEntry>,
  declared: { name: string; source?: string }
): { key: string; entry: SkillEntry } | undefined {
  // `hasOwnProperty`, not a bare lookup: a persona declaring
  // "constructor" or "toString" would otherwise resolve against
  // Object.prototype and report itself healthy while getting no tool at
  // all — a silent failure inside the module built to remove them.
  if (Object.prototype.hasOwnProperty.call(catalog, declared.name)) {
    return { key: declared.name, entry: catalog[declared.name] };
  }
  if (!declared.source) return undefined;

  for (const [key, entry] of Object.entries(catalog)) {
    if (entry.source && entry.source === declared.source) return { key, entry };
  }
  const pkg = packageFromSource(declared.source);
  if (!pkg) return undefined;
  for (const [key, entry] of Object.entries(catalog)) {
    if (entry.package && entry.package === pkg) return { key, entry };
  }
  return undefined;
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

/**
 * The write-side guards for that same line. `mcpServers: [name=source, …]`
 * is ONE frontmatter line built out of `=`, `,` and `]`, so a name or
 * source carrying those characters (or a newline) restructures whatever
 * persona file it is written into: `x]\naliases: [admin` hands the agent
 * extra names to answer to, `https://x/sse\nowner: attacker` writes a real
 * key. WHATWG URL parsing strips raw CR/LF, so `parseSkillSource`
 * validating a source is no protection — the payload parses fine.
 *
 * These rules live HERE, next to the formatter, because every persona
 * writer must apply them: fez-desktop's skill-attach, the agent editor,
 * and the CLI's serialize were three writers and only the first was
 * guarded. For a NAME the SHAPE is allowed (npm's grammar plus `@` and
 * `/`); for a SOURCE the rule is round-trip — no structure, no
 * edge-whitespace — with `=` deliberately allowed so a hosted-MCP url
 * with a query-string key survives (`parseSkillEntries` splits on the
 * FIRST `=` only).
 */
const SAFE_SKILL_NAME = /^[A-Za-z0-9._@/-]{1,64}$/;
const SOURCE_STRUCTURAL = /[\r\n\],]/;
const MAX_SKILL_SOURCE = 256;

export function safeSkillName(name: string): boolean {
  return SAFE_SKILL_NAME.test(name);
}

export function safeSkillSource(source: string): boolean {
  if (!source || source.length > MAX_SKILL_SOURCE) return false;
  if (source !== source.trim()) return false;
  return !SOURCE_STRUCTURAL.test(source);
}

/** Judge the whole line a writer is about to render. */
export function safeSkillEntries(names: string[], sources: Record<string, string>): boolean {
  return names.every((name) => safeSkillName(name) && (!sources[name] || safeSkillSource(sources[name])));
}
