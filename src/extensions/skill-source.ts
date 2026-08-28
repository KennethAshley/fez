/**
 * Where a skill COMES FROM.
 *
 * A persona declaring `mcpServers: [web-search]` says nothing about what
 * to install. "web-search" is a local alias — a name in a namespace
 * nobody owns. npm has at least three unrelated packages answering to
 * it (@fuyouai/web-search-mcp, agent-search-mcp, @tongxiao/…), and
 * "brave-search" resolves to both Brave's own server and a stranger's
 * fork. Resolving a bare name by search would mean running arbitrary
 * code because a string matched. Fez does not do that.
 *
 * So the persona says where instead:
 *
 *   mcpServers: [web-search=npm:@brave/brave-search-mcp-server, github]
 *
 * The entry left of `=` stays the alias the prompt and the ACP session
 * see; the right side is a SOURCE SPEC, and it makes the install
 * deterministic — nothing to look up, nothing to guess, and the persona
 * becomes portable: hand it to someone and their fez knows exactly what
 * to fetch. This is what package.json and Cargo.toml do, for the same
 * reason. An entry with no `=` (`github` above) is still just a name,
 * and stays unresolvable by design.
 *
 * THE SECURITY PROPERTY, stated plainly: a spec names a PUBLISHED
 * PACKAGE or a URL. It can never name an arbitrary command. A persona
 * file arrives over the wire from whoever wrote it — if `command:` were
 * declarable there, installing a persona would be arbitrary code
 * execution wearing a frontmatter key. Declaring is a request;
 * installing is the approval, and the approval still renders the full
 * resolved command verbatim before anything runs.
 */

/** Exactly what settings.json stores under mcpServers[name]. */
export interface SkillSpec {
  command?: string;
  args?: string[];
  type?: string;
  url?: string;
  env?: Record<string, string>;
}

/**
 * The schemes, and the runner each one implies. Deliberately short: one
 * per ecosystem that actually ships MCP servers today. Each maps to a
 * launcher that fetches-and-runs a published package by name, which is
 * the whole reason a spec can't smuggle a command through.
 */
const RUNNERS: Record<string, (pkg: string) => SkillSpec> = {
  "npm:": (pkg) => ({ command: "npx", args: ["-y", pkg] }),
  "uvx:": (pkg) => ({ command: "uvx", args: [pkg] }),
  "pipx:": (pkg) => ({ command: "pipx", args: ["run", pkg] }),
};

export const SOURCE_SCHEMES = [...Object.keys(RUNNERS), "https://", "http://"];

/**
 * Package names we'll actually hand to a runner. npm's own grammar plus
 * the subset PyPI shares, and no more: no path separators beyond a
 * single scope slash, no whitespace, no leading dash (which argv would
 * read as a flag), no `@version` — pinning belongs in a later pass with
 * a lockfile behind it, and silently accepting a version we then drop
 * would be worse than refusing it.
 */
const PACKAGE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

/**
 * A source spec → the skill config it installs as, or undefined when the
 * spec is malformed or uses a scheme fez doesn't know. Undefined is not
 * an error to swallow: the caller shows the raw spec and says it can't
 * resolve it, which is honest, where guessing would not be.
 */
export function parseSkillSource(spec: string): SkillSpec | undefined {
  const trimmed = spec.trim();
  if (!trimmed) return undefined;

  if (/^https?:\/\//i.test(trimmed)) {
    // A hosted MCP server. Parsed, not pattern-matched, so a spec like
    // `https://x.com evil` can't slip through as a URL.
    try {
      const url = new URL(trimmed);
      if (url.username || url.password) return undefined; // credentials belong in env, not a shared persona
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
 * A listing carries a pointer, never bytes. `npx -y duckduckgo-mcp-server`
 * points at something anyone can fetch; `node /Users/me/proj/dist/mcp.js`
 * points at a directory on one laptop. Publish the second and the
 * installer's settings.json gets it verbatim — then their next agent
 * spawns against a path that isn't there, and it fails SILENTLY, because
 * an MCP server that won't start is indistinguishable from a skill
 * nobody declared. Unpublished packages are the usual cause, fez's own
 * included until they reach npm.
 *
 * Deliberately conservative: it only flags arguments that are
 * unambiguously filesystem paths. A package name can't start with `/`,
 * `~` or `./`, so there is nothing legitimate to catch here.
 */
export function machineLocalPath(config: SkillSpec | undefined): string | undefined {
  return (config?.args ?? []).find((arg) => /^(\/|~|\.\.?\/)/.test(arg));
}

/**
 * The one case where a bare name DOES resolve: fez's own packages.
 * `fez-kanban` → `@fezchat/kanban` is safe not because the name looks
 * official but because fez owns the @fez scope on npm — nobody else can
 * publish into it. That is a property of owning the namespace, and it
 * generalizes to no other prefix. Everything else stays unresolvable.
 */
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
  const direct = catalog[declared.name];
  if (direct) return { key: declared.name, entry: direct };
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
 * Resolve a declared skill for a spawn. Order is a trust order:
 *
 *  1. what's INSTALLED wins always — the local machine's answer to what
 *     this name means, already approved by a human;
 *  2. otherwise the declared source is reported, NOT run. A persona
 *     naming a source has asked for something; it has not been granted
 *     it. Headless spawns therefore proceed without the skill and say
 *     so, exactly as they already did for an unknown bare name.
 */
export function installHint(name: string, source: string | undefined): string {
  if (!source) return `${name} — no source declared; fez can't know what package that is`;
  const config = parseSkillSource(source);
  if (!config) {
    return `${name} — declared source "${source}" isn't a scheme fez knows (${SOURCE_SCHEMES.join(", ")})`;
  }
  return `${name} — declared ${source}; install it with: fez skill add ${name} --from ${source}`;
}
