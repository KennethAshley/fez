#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { CapabilityClient } from "./client.js";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import fs from "fs/promises";
import path from "path";
import os from "os";

// Loads ./.env (secrets like GITHUB_TOKEN for extension-registered MCP
// servers, see mcp-servers.ts) before anything reads process.env. Node's
// built-in loader, not the `dotenv` package — one less dependency for
// something this small. No .env file is the common case, not an error.
try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

const program = new Command();

program.name("fez").description("Fez — decentralized MCP for agents").version("0.1.0");

// ─── Default: Open TUI when no command given ───────────────────────────────

if (process.argv.length <= 2) {
  // No arguments — launch TUI. Identity must be stable across restarts —
  // community creator rights and channel membership are bound to the
  // pubkey, so a regenerated key each run would orphan everything you
  // created. Resolution: env override > ~/.fez/default.key > generate
  // once and persist there.
  let privateKey = process.env.FEZ_PRIVATE_KEY;
  if (!privateKey) {
    const { loadOrCreateKey } = await import("./keys.js");
    privateKey = loadOrCreateKey("default"); // keychain custody; migrates a legacy plaintext file
  }

  // First run (interactive terminals only — scripted/piped invocations
  // must never block on prompts): the whole required surface is ONE
  // input, the relay URL. Key already exists (above), a missing harness
  // gets actionable guidance, a starter persona covers the empty case,
  // and the communities extension bootstraps a Home community on its
  // side. Everything lands in ~/.fez/settings.json.
  const { loadSettings, resolveRelays } = await import("./settings.js");
  if (!loadSettings().onboarded && process.stdin.isTTY && process.stdout.isTTY) {
    const { firstRunWizard } = await import("./onboarding.js");
    await firstRunWizard();
  }

  const { FezTUI } = await import("./tui.js");
  const tui = new FezTUI(resolveRelays(), privateKey);
  await tui.start();
  // TUI blocks until /quit, then exits cleanly
  process.exit(0);
}

// ─── keygen ─────────────────────────────────────────────────────────────────

program
  .command("keygen")
  .description("Generate a new Nostr keypair")
  .option("-s, --save <file>", "Save private key to file")
  .action(async (options) => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const skHex = bytesToHex(sk);

    console.log(chalk.green("✅ Generated new keypair"));
    console.log(`   Private key: ${chalk.yellow(skHex)}`);
    console.log(`   Public key:  ${chalk.cyan(pk)}`);

    if (options.save) {
      await fs.writeFile(options.save, skHex, "utf-8");
      console.log(`   Saved to: ${options.save}`);
    }
  });

// ─── keys — custody (see src/keys.ts: keychain-backed, NIP-49 portability) ──

const keys = program.command("keys").description("Identity key custody (OS keychain; NIP-49 export/import)");

keys
  .command("list")
  .description("List known keys with pubkeys and storage backend")
  .action(async () => {
    const { listKeys } = await import("./keys.js");
    const entries = listKeys();
    if (entries.length === 0) return console.log("No keys yet — the TUI or an agent creates one on first run.");
    for (const entry of entries) {
      const marker = entry.backend === "keychain" ? chalk.green("keychain") : chalk.yellow("file    ");
      console.log(`  ${marker}  ${entry.name.padEnd(20)} ${chalk.cyan(entry.pubkey)}`);
    }
    if (entries.some((e) => e.backend === "file" && process.platform === "darwin")) {
      console.log(chalk.dim("\n  file-backed keys migrate to the keychain the next time their owner runs."));
    }
  });

keys
  .command("export <name>")
  .description("Export a key as passphrase-encrypted ncryptsec (NIP-49)")
  .action(async (name: string) => {
    const { exportKey } = await import("./keys.js");
    const inquirer = (await import("inquirer")).default;
    const { passphrase } = await inquirer.prompt([
      { type: "password", name: "passphrase", message: `Passphrase to encrypt "${name}":`, mask: "*" },
    ]);
    if (!passphrase) return console.error("Empty passphrase — aborted.");
    console.log(exportKey(name, passphrase));
  });

keys
  .command("import <name> <ncryptsec>")
  .description("Import a NIP-49 ncryptsec under the given key name")
  .action(async (name: string, ncryptsec: string) => {
    const { getKey, importKey } = await import("./keys.js");
    const inquirer = (await import("inquirer")).default;
    if (getKey(name)) {
      const { overwrite } = await inquirer.prompt([
        { type: "confirm", name: "overwrite", message: `Key "${name}" exists — overwrite? (the old key is NOT recoverable unless exported)`, default: false },
      ]);
      if (!overwrite) return console.log("Aborted.");
    }
    const { passphrase } = await inquirer.prompt([
      { type: "password", name: "passphrase", message: "Passphrase:", mask: "*" },
    ]);
    try {
      const pubkey = importKey(name, ncryptsec, passphrase);
      console.log(`${chalk.green("✅ Imported")} "${name}" — pubkey ${chalk.cyan(pubkey)}`);
    } catch {
      console.error("Decrypt failed — wrong passphrase or corrupted ncryptsec.");
      process.exitCode = 1;
    }
  });

// ─── setup — run the first-run wizard on demand ─────────────────────────────

program
  .command("setup")
  .description("(Re)run the setup wizard — relay, harness check, starter persona")
  .action(async () => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error("fez setup is interactive — run it from a terminal.");
      process.exitCode = 1;
      return;
    }
    const { firstRunWizard } = await import("./onboarding.js");
    await firstRunWizard();
  });

// ─── mem — NIP-AE agent memory (engrams) ────────────────────────────────────
//
// Two callers, one command: an AGENT invoking it from inside its harness
// shell (FEZ_AGENT_PERSONA/FEZ_AGENT_OWNER are in its env — fez-acp put
// them there), or the OWNER inspecting/seeding a local agent's memory
// with --persona (the agent key lives in local custody, and the
// conversation key is symmetric, so both sides read the same records).

const mem = program.command("mem").description("Agent memory (NIP-AE engrams) — set/get/list persistent agent memory");

interface MemContext {
  agentSecret: Uint8Array;
  agentPubkey: string;
  ownerPubkey: string;
  relayUrl: string;
}

async function memContext(personaFlag?: string): Promise<MemContext> {
  const { getKey } = await import("./keys.js");
  const { resolveRelay } = await import("./settings.js");
  const { getPublicKey: pk } = await import("nostr-tools/pure");
  const persona = personaFlag ?? process.env.FEZ_AGENT_PERSONA;
  if (!persona) {
    console.error("No persona in scope — run inside an agent shell, or pass --persona <name>.");
    process.exit(1);
  }
  const agentHex = getKey(`agent:${persona}`);
  if (!agentHex) {
    console.error(`No local key for agent "${persona}" (it gets one the first time it runs).`);
    process.exit(1);
  }
  const ownerPubkey =
    process.env.FEZ_AGENT_OWNER ??
    (() => {
      const hex = getKey("default");
      return hex ? pk(Uint8Array.from(Buffer.from(hex, "hex"))) : undefined;
    })();
  if (!ownerPubkey) {
    console.error("No owner in scope (FEZ_AGENT_OWNER unset and no default identity).");
    process.exit(1);
  }
  const agentSecret = Uint8Array.from(Buffer.from(agentHex, "hex"));
  return { agentSecret, agentPubkey: pk(agentSecret), ownerPubkey, relayUrl: resolveRelay() };
}

/** Query all engram candidates for the pair; returns heads map. */
async function memHeads(ctx: MemContext) {
  const { RelayConnection } = await import("./relay.js");
  const { conversationKey, engramHeads, KIND_AGENT_ENGRAM } = await import("./engram.js");
  const relay = new RelayConnection({ url: ctx.relayUrl });
  await relay.connect();
  const events = await relay.query([{ kinds: [KIND_AGENT_ENGRAM], authors: [ctx.agentPubkey], "#p": [ctx.ownerPubkey] }]);
  const convKey = conversationKey(ctx.agentSecret, ctx.ownerPubkey);
  return { relay, convKey, heads: engramHeads(events as never, ctx.agentPubkey, ctx.ownerPubkey, convKey) };
}

mem
  .command("set <slug> <text>")
  .description('Write a memory record ("core" or "mem/...") — as the agent in scope')
  .option("--persona <name>", "agent persona (default: FEZ_AGENT_PERSONA)")
  .action(async (slug: string, text: string, options) => {
    const { isValidSlug, buildEngramEvent } = await import("./engram.js");
    const { finalizeEvent } = await import("nostr-tools/pure");
    if (!isValidSlug(slug)) {
      console.error(`Bad slug "${slug}" — use "core" or mem/<lowercase-alnum-_->[/...]`);
      process.exit(1);
    }
    const ctx = await memContext(options.persona);
    const { relay, convKey, heads } = await memHeads(ctx);
    const prior = heads.get(slug);
    // Monotonic created_at defeats the same-second tiebreak (spec: Writing step 2).
    const createdAt = Math.max(Math.floor(Date.now() / 1000), (prior?.event.created_at ?? 0) + 1);
    const body = slug === "core" ? { slug, profile: text } : { slug, value: text };
    const template = buildEngramEvent(convKey, ctx.ownerPubkey, body, createdAt);
    await relay.publish(finalizeEvent({ ...template, pubkey: ctx.agentPubkey } as never, ctx.agentSecret));
    console.log(`✅ ${slug} written (${text.length} chars)`);
    relay.disconnect();
  });

mem
  .command("get <slug>")
  .description("Read a memory record")
  .option("--persona <name>", "agent persona (default: FEZ_AGENT_PERSONA)")
  .action(async (slug: string, options) => {
    const ctx = await memContext(options.persona);
    const { relay, heads } = await memHeads(ctx);
    relay.disconnect();
    const head = heads.get(slug);
    if (!head || head.body.value === null) {
      console.log(`(no entry for ${slug})`);
      process.exitCode = 1;
      return;
    }
    console.log(slug === "core" ? head.body.profile : head.body.value);
  });

mem
  .command("del <slug>")
  .description("Tombstone a mem/... record (core cannot be deleted, only rewritten)")
  .option("--persona <name>", "agent persona (default: FEZ_AGENT_PERSONA)")
  .action(async (slug: string, options) => {
    if (slug === "core") {
      console.error('core cannot be tombstoned — rewrite it with `fez mem set core "..."`.');
      process.exit(1);
    }
    const { buildEngramEvent } = await import("./engram.js");
    const { finalizeEvent } = await import("nostr-tools/pure");
    const ctx = await memContext(options.persona);
    const { relay, convKey, heads } = await memHeads(ctx);
    const createdAt = Math.max(Math.floor(Date.now() / 1000), (heads.get(slug)?.event.created_at ?? 0) + 1);
    const template = buildEngramEvent(convKey, ctx.ownerPubkey, { slug, value: null }, createdAt);
    await relay.publish(finalizeEvent({ ...template, pubkey: ctx.agentPubkey } as never, ctx.agentSecret));
    console.log(`🪦 ${slug} tombstoned`);
    relay.disconnect();
  });

mem
  .command("list")
  .description("List memory entries (and whether a core exists)")
  .option("--persona <name>", "agent persona (default: FEZ_AGENT_PERSONA)")
  .action(async (options) => {
    const ctx = await memContext(options.persona);
    const { relay, heads } = await memHeads(ctx);
    relay.disconnect();
    const core = heads.get("core");
    console.log(core ? `core: ${(core.body.profile ?? "").slice(0, 80)}${(core.body.profile ?? "").length > 80 ? "…" : ""}` : "core: (not set)");
    const entries = [...heads.values()]
      .filter((h) => h.body.slug !== "core" && h.body.value !== null)
      .sort((a, b) => a.body.slug.localeCompare(b.body.slug));
    for (const entry of entries) {
      console.log(`  ${entry.body.slug}: ${String(entry.body.value).slice(0, 70)}`);
    }
    if (entries.length === 0) console.log("  (no memory entries)");
  });

// ─── doc — the channel's living document (kind 40100, Buzz's canvas) ────────
// Agent-facing like `fez mem`: agents APPEND by default (append-only
// contributions don't clobber each other); `set` replaces wholesale and is
// for when someone asked for a rewrite. Signs as the persona in scope
// (FEZ_AGENT_PERSONA / --persona), else as the user.

const doc = program.command("doc").description("Channel doc (shared markdown, kind 40100) — append/set/get as the identity in scope");

interface DocCliContext {
  secret: Uint8Array;
  pubkey: string;
  relay: import("./relay.js").RelayConnection;
  channelId: string;
  latest?: { id: string; created_at: number; content: string };
}

async function docContext(channelFlag: string | undefined, personaFlag: string | undefined): Promise<DocCliContext> {
  const { getKey } = await import("./keys.js");
  const { resolveRelays } = await import("./settings.js");
  const { getPublicKey: pk } = await import("nostr-tools/pure");
  const { RelayConnection } = await import("./relay.js");
  const persona = personaFlag ?? process.env.FEZ_AGENT_PERSONA;
  const hex = persona ? getKey(`agent:${persona}`) : getKey("default");
  if (!hex) {
    console.error(persona ? `No local key for agent "${persona}".` : "No fez identity — fez keygen first.");
    process.exit(1);
  }
  const channelSpec = channelFlag ?? process.env.FEZ_DOC_CHANNEL;
  if (!channelSpec) {
    console.error("No channel — pass --channel <name-or-id>.");
    process.exit(1);
  }
  const relay = new RelayConnection({ urls: resolveRelays() });
  await relay.connect();
  // Resolve name-or-id against stored 47101s; the community rides the c tag.
  const channels = await relay.query([{ kinds: [47101] }]);
  const match = channels.find((e) => {
    const d = e.tags.find((t) => t[0] === "d")?.[1];
    if (d === channelSpec) return true;
    try {
      return (JSON.parse(e.content).name ?? "").toLowerCase() === channelSpec.replace(/^#/, "").toLowerCase();
    } catch {
      return false;
    }
  });
  const channelId = match?.tags.find((t) => t[0] === "d")?.[1];
  if (!channelId) {
    console.error(`No channel "${channelSpec}" on the relay.`);
    relay.disconnect();
    process.exit(1);
  }
  const versions = await relay.query([{ kinds: [40100], "#h": [channelId], limit: 200 }]);
  const latest = versions.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? 1 : -1)).at(-1);
  const secret = Uint8Array.from(Buffer.from(hex, "hex"));
  return { secret, pubkey: pk(secret), relay, channelId, latest };
}

async function docPublish(ctx: DocCliContext, content: string): Promise<void> {
  const { finalizeEvent } = await import("nostr-tools/pure");
  // Monotonic vs the latest version — same-second ties resolve by lowest
  // id, which would make concurrent-edit outcomes arbitrary.
  const createdAt = Math.max(Math.floor(Date.now() / 1000), (ctx.latest?.created_at ?? 0) + 1);
  await ctx.relay.publish(
    finalizeEvent(
      {
        kind: 40100,
        created_at: createdAt,
        tags: [["h", ctx.channelId], ...(ctx.latest ? [["base", ctx.latest.id]] : [])],
        content,
      },
      ctx.secret
    )
  );
}

doc
  .command("append <text>")
  .description("Add to the channel doc (the agent default — appends never clobber)")
  .option("--channel <name-or-id>", "channel (default: FEZ_DOC_CHANNEL)")
  .option("--persona <name>", "sign as this agent (default: FEZ_AGENT_PERSONA, else you)")
  .action(async (text: string, options) => {
    const ctx = await docContext(options.channel, options.persona);
    await docPublish(ctx, ctx.latest ? `${ctx.latest.content}\n\n${text.replace(/\\n/g, "\n")}` : text.replace(/\\n/g, "\n"));
    console.log(`📄 appended (${text.length} chars)`);
    ctx.relay.disconnect();
  });

doc
  .command("set <text>")
  .description("Replace the channel doc wholesale — only when a rewrite was asked for")
  .option("--channel <name-or-id>", "channel (default: FEZ_DOC_CHANNEL)")
  .option("--persona <name>", "sign as this agent (default: FEZ_AGENT_PERSONA, else you)")
  .action(async (text: string, options) => {
    const ctx = await docContext(options.channel, options.persona);
    await docPublish(ctx, text.replace(/\\n/g, "\n"));
    console.log(`📄 doc replaced (${text.length} chars)`);
    ctx.relay.disconnect();
  });

doc
  .command("get")
  .description("Print the channel doc")
  .option("--channel <name-or-id>", "channel (default: FEZ_DOC_CHANNEL)")
  .option("--persona <name>", "sign as this agent (default: FEZ_AGENT_PERSONA, else you)")
  .action(async (options) => {
    const ctx = await docContext(options.channel, options.persona);
    console.log(ctx.latest ? ctx.latest.content : "(no doc yet)");
    ctx.relay.disconnect();
  });

// ─── agent — run a standing channel agent (the fez-acp runtime) ─────────────

program
  .command("agent <persona>")
  .description("Run a standing channel agent for a persona (fez-acp runtime)")
  .option("-c, --channels <list>", 'channel names/ids, comma-separated; "none" = DM-only', "general")
  .option("-r, --relay <url>", "Relay URL (default: settings/env)")
  .option("--respond-to <policy>", "anyone | owner | allowlist:<pk,...> (default: persona frontmatter, else owner)")
  .option("--owner <pubkey>", "owner pubkey (default: your fez identity)")
  .option("--on-busy <mode>", "steer | queue", "steer")
  .action(async (personaId: string, options) => {
    const { resolveRelays } = await import("./settings.js");
    process.env.FEZ_RELAY = resolveRelays(options.relay).join(",");
    process.env.FEZ_AGENT_PERSONA = personaId;
    process.env.FEZ_AGENT_CHANNELS = options.channels === "none" ? "" : options.channels;
    if (options.respondTo) process.env.FEZ_AGENT_RESPOND_TO = options.respondTo;
    process.env.FEZ_AGENT_ON_BUSY = options.onBusy;
    // Owner defaults to the user's own identity — the observer stream
    // (/watch) and sibling gating work out of the box instead of being
    // an env var most people never discover.
    if (!process.env.FEZ_AGENT_OWNER) {
      const owner =
        options.owner ??
        (await (async () => {
          const { getKey } = await import("./keys.js");
          const hex = getKey("default");
          return hex ? getPublicKey(Uint8Array.from(Buffer.from(hex, "hex"))) : undefined;
        })());
      if (owner) process.env.FEZ_AGENT_OWNER = owner;
    }
    // Runtime resolution: explicit override, then the repo/npm-link
    // layout relative to this CLI build.
    const { fileURLToPath, pathToFileURL } = await import("node:url");
    const { existsSync } = await import("node:fs");
    const candidates = [
      process.env.FEZ_ACP_RUNTIME,
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/fez-acp/dist/agent.js"),
    ].filter((p): p is string => !!p);
    const runtime = candidates.find((p) => existsSync(p));
    if (!runtime) {
      console.error(`fez-acp runtime not found (looked at: ${candidates.join(", ")}) — build it with: npm run acp:build`);
      process.exit(1);
    }
    await import(pathToFileURL(runtime).href);
  });

program
  .command("sentinel")
  .description("Run the always-on watcher: wakes sleeping agents on DMs/mentions, delivers desktop notifications — no TUI needed")
  .option("-r, --relay <url>", "Relay URL (default: settings/env)")
  .action(async (options) => {
    const { resolveRelays } = await import("./settings.js");
    process.env.FEZ_RELAY = resolveRelays(options.relay).join(",");
    const { fileURLToPath, pathToFileURL } = await import("node:url");
    const { existsSync } = await import("node:fs");
    const candidates = [
      process.env.FEZ_SENTINEL_RUNTIME,
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/fez-sentinel/dist/index.js"),
    ].filter((p): p is string => !!p);
    const runtime = candidates.find((p) => existsSync(p));
    if (!runtime) {
      console.error(`fez-sentinel runtime not found (looked at: ${candidates.join(", ")}) — build it in packages/fez-sentinel`);
      process.exit(1);
    }
    await import(pathToFileURL(runtime).href);
  });

program
  .command("sentinel-install")
  .description("Install the sentinel as a launchd agent: starts at login, restarts on crash (macOS)")
  .option("-r, --relay <url>", "Relay URL baked into the service (default: settings/env)")
  .action(async (options) => {
    if (process.platform !== "darwin") {
      console.error("launchd is macOS-only — on Linux, use a systemd user unit running `fez sentinel`.");
      process.exit(1);
    }
    const { execSync } = await import("node:child_process");
    const fsSync = await import("node:fs");
    // The relay is NOT baked into the plist unless --relay was given.
    // An env var in a launchd plist outlives every settings change —
    // the sentinel kept watching localhost after the workspace moved,
    // because install-time state had been promoted to a permanent
    // override. Default: the service reads settings.json at start,
    // exactly like running it by hand.
    const relayPin = options.relay
      ? `\n    <key>FEZ_RELAY</key><string>${options.relay}</string>`
      : "";
    const logDir = path.join(os.homedir(), ".fez", "logs");
    fsSync.mkdirSync(logDir, { recursive: true });
    const label = "com.fez.sentinel";
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const cliPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "cli.js");
    // launchd inherits a bare PATH; the node dir must ride explicitly, and
    // `security` (keychain) lives in /usr/bin.
    const pathEnv = `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${cliPath}</string>
    <string>sentinel</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${pathEnv}</string>${relayPin}
    <key>HOME</key><string>${os.homedir()}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Unconditional: a SIGTERM from logout/sleep teardown exits 0, and
       SuccessfulExit=false read that as "meant to stop" — leaving the
       sentinel dead until someone noticed (someone noticed). Deliberate
       stops go through launchctl unload, which KeepAlive respects. -->
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${path.join(logDir, "sentinel.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, "sentinel.log")}</string>
</dict>
</plist>
`;
    fsSync.mkdirSync(path.dirname(plistPath), { recursive: true });
    fsSync.writeFileSync(plistPath, plist);
    // bootout first so re-install picks up plist changes; ignore "not loaded".
    try { execSync(`launchctl bootout gui/$(id -u) ${plistPath} 2>/dev/null`); } catch { /* not loaded */ }
    execSync(`launchctl bootstrap gui/$(id -u) ${plistPath}`);
    console.log(`✅ sentinel installed as ${label} — starts at login, restarts on crash.`);
    console.log(`   plist: ${plistPath}`);
    console.log(`   logs:  ${path.join(logDir, "sentinel.log")}`);
    console.log(`   remove anytime: fez sentinel-uninstall`);
    console.log(`   ⚠️ if a foreground \`fez sentinel\` is running elsewhere, stop it — the pidfile keeps them from doubling, but one owner is cleaner.`);
  });

program
  .command("sentinel-uninstall")
  .description("Remove the launchd sentinel service")
  .action(async () => {
    const { execSync } = await import("node:child_process");
    const fsSync = await import("node:fs");
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.fez.sentinel.plist");
    try { execSync(`launchctl bootout gui/$(id -u) ${plistPath} 2>/dev/null`); } catch { /* not loaded */ }
    fsSync.rmSync(plistPath, { force: true });
    console.log("✅ sentinel launchd service removed (any running instance was stopped).");
  });

program
  .command("orchestrator")
  .description("Run @fez, the routing agent: mentions of @fez get routed to the best agent for the task")
  .option("-r, --relay <url>", "Relay URL (default: settings/env)")
  .action(async (options) => {
    const { resolveRelays } = await import("./settings.js");
    process.env.FEZ_RELAY = resolveRelays(options.relay).join(",");
    const { fileURLToPath, pathToFileURL } = await import("node:url");
    const { existsSync } = await import("node:fs");
    const candidates = [
      process.env.FEZ_ORCHESTRATOR_RUNTIME,
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/fez-orchestrator/dist/orchestrator.js"),
    ].filter((p): p is string => !!p);
    const runtime = candidates.find((p) => existsSync(p));
    if (!runtime) {
      console.error(`fez-orchestrator runtime not found (looked at: ${candidates.join(", ")}) — build it in packages/fez-orchestrator`);
      process.exit(1);
    }
    await import(pathToFileURL(runtime).href);
  });

program
  .command("orchestrator-install")
  .description("Install @fez as a launchd agent: starts at login, always restarted (macOS)")
  .option("-r, --relay <url>", "Relay URL baked into the service (default: settings/env)")
  .action(async (options) => {
    if (process.platform !== "darwin") {
      console.error("launchd is macOS-only — on Linux, use a systemd user unit running `fez orchestrator`.");
      process.exit(1);
    }
    const { execSync } = await import("node:child_process");
    const fsSync = await import("node:fs");
    // The relay is NOT baked into the plist unless --relay was given.
    // An env var in a launchd plist outlives every settings change —
    // the sentinel kept watching localhost after the workspace moved,
    // because install-time state had been promoted to a permanent
    // override. Default: the service reads settings.json at start,
    // exactly like running it by hand.
    const relayPin = options.relay
      ? `\n    <key>FEZ_RELAY</key><string>${options.relay}</string>`
      : "";
    const logDir = path.join(os.homedir(), ".fez", "logs");
    fsSync.mkdirSync(logDir, { recursive: true });
    const label = "com.fez.orchestrator";
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const cliPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "cli.js");
    const pathEnv = `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${cliPath}</string>
    <string>orchestrator</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${pathEnv}</string>${relayPin}
    <key>HOME</key><string>${os.homedir()}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${path.join(logDir, "orchestrator.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, "orchestrator.log")}</string>
</dict>
</plist>
`;
    fsSync.writeFileSync(plistPath, plist);
    try { execSync(`launchctl bootout gui/$(id -u) ${plistPath} 2>/dev/null`); } catch { /* not loaded */ }
    execSync(`launchctl bootstrap gui/$(id -u) ${plistPath}`);
    console.log(`✅ @fez installed as ${label} — starts at login, always restarted.`);
    console.log(`   plist: ${plistPath}`);
    console.log(`   logs:  ${path.join(logDir, "orchestrator.log")}`);
    console.log(`   remove anytime: fez orchestrator-uninstall`);
  });

program
  .command("orchestrator-uninstall")
  .description("Remove the launchd @fez service")
  .action(async () => {
    const { execSync } = await import("node:child_process");
    const fsSync = await import("node:fs");
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.fez.orchestrator.plist");
    try { execSync(`launchctl bootout gui/$(id -u) ${plistPath} 2>/dev/null`); } catch { /* not loaded */ }
    fsSync.rmSync(plistPath, { force: true });
    console.log("✅ @fez launchd service removed (any running instance was stopped).");
  });

program
  .command("invite <pubkey> [role]")
  .description("Add a pubkey to the workspace roster (member|admin|bot) — the owner-signed 47102")
  .option("-r, --relay <url>", "Relay to publish to (default: settings/env)")
  .action(async (pubkey: string, role = "member", options: { relay?: string }) => {
    const ROLES = ["member", "admin", "bot", "owner"];
    if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
      console.error(`✗ "${pubkey}" is not a 64-hex pubkey`);
      process.exit(1);
    }
    if (!ROLES.includes(role)) {
      console.error(`✗ role must be one of: ${ROLES.join(", ")}`);
      process.exit(1);
    }
    const { getKey } = await import("./keys.js");
    const { resolveRelays } = await import("./settings.js");
    const { CapabilityClient } = await import("./client.js");
    const { RelayConnection } = await import("./relay.js");
    const { KIND_MEMBERSHIP, ROSTER_D } = await import("./kinds.js");
    const { fetchRelayInfo } = await import("./nip11.js");

    const keyHex = getKey("default");
    if (!keyHex) {
      console.error("No fez identity — run `fez keygen` first.");
      process.exit(1);
    }
    const relays = options.relay ? [options.relay] : resolveRelays();
    const client = new CapabilityClient({ relay: relays, privateKey: keyHex });
    const relay = new RelayConnection({ urls: relays, authSigner: client.authSigner });
    await relay.connect();
    const me = client.getPubkey();

    // Only the owner's roster counts, so refuse early rather than
    // publishing an event every other client will ignore.
    const info = await fetchRelayInfo(relays[0]);
    if (info?.pubkey && info.pubkey !== me) {
      console.error(`✗ only the workspace owner can invite — this relay's owner is ${info.pubkey.slice(0, 12)}…, you are ${me.slice(0, 12)}…`);
      relay.disconnect();
      process.exit(1);
    }

    // Rebuild from the CURRENT roster: 47102 is replaceable, so
    // publishing a roster of one would evict everybody else.
    const existing = await relay.query([{ kinds: [KIND_MEMBERSHIP], authors: [me], "#d": [ROSTER_D], limit: 1 }]);
    const members = new Map<string, string>();
    const latest = existing.sort((a, b) => b.created_at - a.created_at)[0];
    for (const tag of latest?.tags ?? []) if (tag[0] === "p" && tag[1]) members.set(tag[1], tag[2] || "member");
    members.set(me, "owner"); // the owner is always on their own roster

    if (members.get(pubkey) === role) {
      console.log(`✓ ${pubkey.slice(0, 12)}… is already on the roster as ${role}`);
      relay.disconnect();
      return;
    }
    const had = members.has(pubkey);
    members.set(pubkey, role);

    // created_at must beat the event being replaced, or relays keep the old one.
    const createdAt = Math.max(Math.floor(Date.now() / 1000), (latest?.created_at ?? 0) + 1);
    await relay.publish(
      client.signEvent({
        kind: KIND_MEMBERSHIP,
        tags: [["d", ROSTER_D], ...[...members.entries()].map(([pk, r]) => ["p", pk, r])],
        content: "",
        created_at: createdAt,
      })
    );
    console.log(`✅ ${had ? "updated" : "invited"} ${pubkey.slice(0, 12)}… as ${role} (${members.size} on the roster)`);
    relay.disconnect();
  });

const router = program.command("router").description("Where @fez routes — the `url:` in ~/.fez/personas/fez.md");

router
  .command("show")
  .description("Which endpoint @fez uses, and whether it answers")
  .action(async () => {
    const { findPersona } = await import("./personas.js");
    const { HOSTED_ROUTER } = await import("./settings.js");
    const persona = await findPersona("fez");
    if (!persona) {
      console.log("No @fez persona — run `fez setup` to create one.");
      return;
    }
    // Same precedence the runtime uses, so this reports what would
    // actually happen rather than what the file says.
    const env = process.env.FEZ_ORCHESTRATOR_URL;
    const url = (env || persona.extra.url || "http://127.0.0.1:8080/v1").replace(/\/$/, "");
    const from = env ? "FEZ_ORCHESTRATOR_URL" : persona.extra.url ? "persona" : "default";
    const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)\b/.test(url);
    console.log(`${url}  (${from}${url === HOSTED_ROUTER ? ", hosted" : local ? ", local" : ""})`);
    try {
      const res = await fetch(`${url}/models`, { signal: AbortSignal.timeout(local ? 2500 : 8000) });
      const body = (await res.json()) as { data?: { id: string }[] };
      console.log(`  ✓ answering — model ${body.data?.[0]?.id ?? "?"}`);
    } catch {
      console.log("  ✗ not answering");
    }
  });

router
  .command("set <url>")
  .description("Point @fez at an endpoint (any OpenAI-compatible /v1 base)")
  .action(async (url: string) => {
    const fsSync = await import("node:fs");
    if (!/^https?:\/\//i.test(url)) {
      console.error(`✗ "${url}" is not an http(s) URL`);
      process.exit(1);
    }
    const personaFile = path.join(os.homedir(), ".fez", "personas", "fez.md");
    if (!fsSync.existsSync(personaFile)) {
      console.error("No ~/.fez/personas/fez.md — run `fez setup` first.");
      process.exit(1);
    }
    const clean = url.replace(/\/$/, "");
    const before = fsSync.readFileSync(personaFile, "utf-8");
    const after = /^url:.*$/m.test(before)
      ? before.replace(/^url:.*$/m, `url: ${clean}`)
      : before.replace(/^---\n/, `---\nurl: ${clean}\n`);
    fsSync.writeFileSync(personaFile, after, "utf-8");
    console.log(`✅ @fez → ${clean}`);
    if (process.env.FEZ_ORCHESTRATOR_URL) {
      console.log(`   ⚠️  FEZ_ORCHESTRATOR_URL=${process.env.FEZ_ORCHESTRATOR_URL} is set and WINS over this.`);
    }
    console.log("   Restart @fez to pick it up.");
  });

program
  .command("router-install")
  .description("Run @fez's routing model on this machine (launchd) and point fez.md at it")
  .requiredOption("-m, --model <path>", "GGUF model file (Qwen3-0.6B q4 is what the bench is tuned against)")
  .option("-s, --server <path>", "llama-server binary", path.join(os.homedir(), ".fez", "bin", "llama-server"))
  .option("-p, --port <port>", "Port to serve on", "8080")
  .action(async (options) => {
    if (process.platform !== "darwin") {
      console.error("launchd is macOS-only — on Linux, run llama-server under a systemd user unit and set `url:` in ~/.fez/personas/fez.md.");
      process.exit(1);
    }
    const { execSync } = await import("node:child_process");
    const fsSync = await import("node:fs");
    const model = path.resolve(options.model);
    const server = path.resolve(options.server);
    for (const [what, p] of [["model", model], ["llama-server", server]] as const) {
      if (!fsSync.existsSync(p)) {
        console.error(`✗ no ${what} at ${p}`);
        console.error("  Get a build from https://github.com/ggml-org/llama.cpp/releases and a Qwen3-0.6B GGUF from Hugging Face.");
        process.exit(1);
      }
    }
    const logDir = path.join(os.homedir(), ".fez", "logs");
    fsSync.mkdirSync(logDir, { recursive: true });
    const label = "com.fez.router";
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const arg = (s: string) => `    <string>${s}</string>`;
    // --alias fez-router matters: detectProfile() keys the request shape
    // off the model id, and anything not matching /needle/ gets the
    // `tools` profile — the one with tool_choice required, which is what
    // makes a general chat model emit a routing call instead of prose.
    // --predict 96 caps the prose preamble; measured identical to 512.
    // --parallel 1 keeps ONE KV cache, so the repeated roster prefix
    // stays cached: a warm route is ~90ms instead of ~230ms.
    const args = [
      server, "-m", model,
      "--host", "127.0.0.1", "--port", String(options.port),
      "-c", "8192", "--jinja", "--reasoning", "off",
      "--alias", "fez-router", "--no-webui",
      "--parallel", "1", "--predict", "96",
    ];
    fsSync.writeFileSync(
      plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>${os.homedir()}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${path.join(logDir, "router.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, "router.log")}</string>
</dict>
</plist>
`
    );
    try { execSync(`launchctl bootout gui/$(id -u) ${plistPath} 2>/dev/null`); } catch { /* not loaded */ }
    execSync(`launchctl bootstrap gui/$(id -u) ${plistPath}`);

    // The switch itself is one line of frontmatter. Rewritten rather
    // than appended so re-running this is idempotent, and left alone if
    // the persona already points somewhere local — someone who chose a
    // port or a second machine should keep it.
    const url = `http://127.0.0.1:${options.port}/v1`;
    const personaFile = path.join(os.homedir(), ".fez", "personas", "fez.md");
    if (fsSync.existsSync(personaFile)) {
      const before = fsSync.readFileSync(personaFile, "utf-8");
      const after = /^url:.*$/m.test(before)
        ? before.replace(/^url:.*$/m, `url: ${url}`)
        : before.replace(/^---\n/, `---\nurl: ${url}\n`);
      if (after !== before) {
        fsSync.writeFileSync(personaFile, after, "utf-8");
        console.log(`✅ @fez now routes via ${url}`);
      } else {
        console.log(`✅ router installed; @fez already points at ${url}`);
      }
    } else {
      console.log(`✅ router installed at ${url}`);
      console.log("   No ~/.fez/personas/fez.md yet — run `fez setup` to create @fez.");
    }
    console.log(`   plist: ${plistPath}`);
    console.log(`   logs:  ${path.join(logDir, "router.log")}`);
    console.log("   Restart @fez to pick it up: fez orchestrator-install (or restart the service).");
    console.log("   remove anytime: fez router-uninstall");
  });

program
  .command("router-uninstall")
  .description("Stop the local routing model and send @fez back to the hosted router")
  .action(async () => {
    const { execSync } = await import("node:child_process");
    const fsSync = await import("node:fs");
    const { HOSTED_ROUTER } = await import("./settings.js");
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.fez.router.plist");
    try { execSync(`launchctl bootout gui/$(id -u) ${plistPath} 2>/dev/null`); } catch { /* not loaded */ }
    fsSync.rmSync(plistPath, { force: true });
    const personaFile = path.join(os.homedir(), ".fez", "personas", "fez.md");
    if (fsSync.existsSync(personaFile)) {
      const before = fsSync.readFileSync(personaFile, "utf-8");
      // Only reclaim a LOCAL url — a deliberate third-party endpoint is
      // not ours to overwrite on the way out.
      const after = before.replace(/^url:\s*https?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)\b.*$/m, `url: ${HOSTED_ROUTER}`);
      if (after !== before) {
        fsSync.writeFileSync(personaFile, after, "utf-8");
        console.log(`✅ local router removed — @fez back on ${HOSTED_ROUTER}`);
      } else {
        console.log("✅ local router removed — @fez's url: was not local, left as-is.");
      }
    } else {
      console.log("✅ local router removed.");
    }
  });

// ─── skill — the machine's MCP catalog + the decentralized marketplace ──────

const skill = program.command("skill").description("Skills (MCP servers) personas can declare — define locally, publish/install via the relay");

skill
  .command("add <name>")
  .description("Define a skill: what the name means on THIS machine (personas reference it via mcpServers:)")
  .option("--from <spec>", "source spec — npm:<pkg>, uvx:<pkg>, pipx:<pkg> or an https:// url")
  .option("--command <cmd>", "executable to launch (stdio MCP server)")
  .option("--args <list>", "comma-separated arguments")
  .option("--url <url>", "HTTP MCP server URL instead of a command")
  .option("--env <pairs...>", "KEY=value pairs (stored locally, never published)")
  .action(async (name: string, options) => {
    const { loadSettings, saveSettings } = await import("./settings.js");
    const { parseSkillSource, describeSkillSpec, SOURCE_SCHEMES } = await import("./skill-source.js");
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
      console.error("A skill needs --from (a published package), --command (stdio) or --url (http).");
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
    console.log(`✅ skill "${name}" defined — personas declaring mcpServers: [${name}] get it on next spawn.`);
  });

skill
  .command("list")
  .description("List defined skills and which personas declare them")
  .action(async () => {
    const { loadSettings } = await import("./settings.js");
    const { listPersonas } = await import("./personas.js");
    const settings = loadSettings() as { mcpServers?: Record<string, { command?: string; url?: string; env?: Record<string, string> }> };
    const skills = settings.mcpServers ?? {};
    const personas = await listPersonas();
    if (Object.keys(skills).length === 0) {
      console.log("No skills defined — fez skill add <name> --command ... (or install one from the marketplace: fez skill market)");
    }
    for (const [name, config] of Object.entries(skills)) {
      const users = personas.filter((persona) => persona.mcpServers.includes(name)).map((persona) => `@${persona.id}`);
      const what = config.url ?? [config.command].join(" ");
      console.log(`  ${chalk.green(name.padEnd(18))} ${what}${config.env ? chalk.dim(` (env: ${Object.keys(config.env).join(", ")})`) : ""}${users.length ? chalk.cyan(`  ← ${users.join(", ")}`) : ""}`);
    }
    // Declared-but-undefined is the actionable gap, so print the fix
    // rather than only the complaint — a persona that declared a source
    // has already answered "which package?", which is the hard part.
    const { installHint, wellKnownSource } = await import("./skill-source.js");
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

skill
  .command("remove <name>")
  .description("Remove a skill definition (personas declaring it fall back to disclosure)")
  .action(async (name: string) => {
    const { loadSettings, saveSettings } = await import("./settings.js");
    const settings = loadSettings() as { mcpServers?: Record<string, unknown> };
    if (!settings.mcpServers?.[name]) return console.log(`No skill named "${name}".`);
    const { [name]: _removed, ...rest } = settings.mcpServers;
    saveSettings({ mcpServers: rest } as never);
    console.log(`🗑  skill "${name}" removed.`);
  });

skill
  .command("publish <name>")
  .description("Publish a marketplace listing (env VALUES never leave this machine)")
  .option("-r, --relay <url>", "Relay URL (default: settings/env)")
  .option("--description <text>", "what this skill does")
  .option("--homepage <url>", "docs link")
  .option("--github <url>", "source repository")
  .option("--npm <name>", "npm package name")
  .option("--artifact <type>", "mcp (default) | extension (fez install) | pi-package (persona packages:)")
  .action(async (name: string, options) => {
    const { loadSettings, resolveRelays } = await import("./settings.js");
    const { loadOrCreateKey } = await import("./keys.js");
    const { KIND_SKILL_LISTING } = await import("./kinds.js");
    const settings = loadSettings() as { mcpServers?: Record<string, { command?: string; args?: string[]; url?: string; type?: string; env?: Record<string, string> }> };
    const artifact = (options.artifact as string | undefined) ?? "mcp";
    const config = settings.mcpServers?.[name];
    if (artifact === "mcp" && !config) {
      console.error(`No skill named "${name}" — define it first: fez skill add ${name} ...`);
      process.exitCode = 1;
      return;
    }
    if (artifact !== "mcp" && !options.npm) {
      console.error(`--artifact ${artifact} needs --npm <package> (that's what gets installed).`);
      process.exitCode = 1;
      return;
    }
    // A listing carries a POINTER, never bytes — so it has to point at
    // something the installer can reach. A path on this disk fails
    // silently on theirs: the MCP server won't start, and a server that
    // won't start is indistinguishable from a skill nobody declared.
    const { machineLocalPath } = await import("./skill-source.js");
    const localPath = artifact === "mcp" ? machineLocalPath(config) : undefined;
    if (localPath) {
      console.error(
        `Can't publish "${name}" — its command points at ${localPath}, which exists only on this machine.\n` +
          `Anyone installing it would get that path verbatim and their agents would spawn against nothing.\n` +
          `Publish the package first, then define the skill from it: fez skill add ${name} --from npm:<package>`
      );
      process.exitCode = 1;
      return;
    }
    const { RelayConnection } = await import("./relay.js");
    const client = new CapabilityClient({ relay: resolveRelays(options.relay), privateKey: loadOrCreateKey("default") });
    const relay = new RelayConnection({ urls: resolveRelays(options.relay), authSigner: client.authSigner });
    await relay.connect();
    const envKeys = Object.keys(config?.env ?? {});
    const installCmd =
      artifact === "extension"
        ? `fez install npm:${options.npm}`
        : artifact === "pi-package"
          ? `add to the persona frontmatter: packages: [npm:${options.npm}]`
          : `fez skill install ${name}${envKeys.length ? " " + envKeys.map((key) => `--env ${key}=<value>`).join(" ") : ""}`;
    const listing = {
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
      ...(options.homepage ? { homepage: options.homepage } : {}),
      ...(options.github ? { github: options.github } : {}),
      ...(options.npm ? { npm: options.npm } : {}),
    };
    await relay.publish(client.signEvent({ kind: KIND_SKILL_LISTING, tags: [["d", name]], content: JSON.stringify(listing) }));
    console.log(`📡 published "${name}" to the marketplace (signed by your key; env values NOT included).`);
    relay.disconnect();
  });

skill
  .command("install <name>")
  .description("Install a skill from a marketplace listing (writes your catalog + publishes an install receipt)")
  .option("-r, --relay <url>", "Relay URL (default: settings/env)")
  .option("--from <pubkey>", "listing author (default: most-installed listing of that name)")
  .option("--env <pairs...>", "KEY=value for each env key the listing requires (stored locally)")
  .action(async (name: string, options) => {
    const { loadSettings, saveSettings, resolveRelays } = await import("./settings.js");
    const { loadOrCreateKey } = await import("./keys.js");
    const { KIND_SKILL_LISTING, KIND_SKILL_INSTALL } = await import("./kinds.js");
    const { RelayConnection } = await import("./relay.js");
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
    const listing = JSON.parse(event.content) as { artifact?: string; command?: string; args?: string[]; url?: string; type?: string; envKeys?: string[]; installCmd?: string; npm?: string };
    if ((listing.artifact ?? "mcp") !== "mcp") {
      console.log(`"${name}" is a ${listing.artifact} — install it with:\n  ${listing.installCmd ?? `fez install npm:${listing.npm}`}`);
      relay.disconnect();
      return;
    }
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
    const what = listing.url ?? [listing.command, ...(listing.args ?? [])].join(" ");
    console.log(`This will run on your machine when declaring agents spawn:\n  ${chalk.yellow(what)}\n  (listed by ${event.pubkey.slice(0, 12)})`);
    const config = listing.url
      ? { type: "http", url: listing.url }
      : { command: listing.command, ...(listing.args?.length ? { args: listing.args } : {}), ...(Object.keys(env).length ? { env } : {}) };
    const settings = loadSettings() as { mcpServers?: Record<string, unknown> };
    saveSettings({ mcpServers: { ...settings.mcpServers, [name]: config } } as never);
    const receipt = client.signEvent({ kind: KIND_SKILL_INSTALL, tags: [["skill", name], ["p", event.pubkey]], content: "" });
    await relay.publish(receipt);
    // Global counter (best-effort): the receipt is already on the wire;
    // the index just makes the number universal across relays.
    const { resolveSkillCountsUrl } = await import("./settings.js");
    const countsUrl = resolveSkillCountsUrl();
    if (countsUrl) {
      await fetch(countsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(receipt),
        signal: AbortSignal.timeout(5000),
      }).catch(() => console.log(chalk.dim("   (global counter unreachable — receipt is on the relay regardless)")));
    }
    console.log(`✅ installed "${name}" (+1 on its install count) — declare mcpServers: [${name}] in a persona to use it.`);
    relay.disconnect();
  });

skill
  .command("market")
  .description("Browse marketplace listings on the relay")
  .option("-r, --relay <url>", "Relay URL (default: settings/env)")
  .action(async (options) => {
    const { resolveRelays } = await import("./settings.js");
    const { loadOrCreateKey } = await import("./keys.js");
    const { KIND_SKILL_LISTING } = await import("./kinds.js");
    const { RelayConnection } = await import("./relay.js");
    const client = new CapabilityClient({ relay: resolveRelays(options.relay), privateKey: loadOrCreateKey("default") });
    const relay = new RelayConnection({ urls: resolveRelays(options.relay), authSigner: client.authSigner });
    await relay.connect();
    const { KIND_SKILL_INSTALL } = await import("./kinds.js");
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
    const { resolveSkillCountsUrl } = await import("./settings.js");
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
    if (latest.size === 0) console.log("No listings on this relay yet — fez skill publish <name> puts yours up.");
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

// ─── doctor — is this machine ready to fez? ─────────────────────────────────

const relayCmd = program
  .command("relay")
  .description("The relay set — where your events are published and read from");

relayCmd
  .command("list", { isDefault: true })
  .description("Show the relay set and where it came from")
  .action(async () => {
    const { loadSettings, resolveRelays, DEFAULT_RELAY } = await import("./settings.js");
    const settings = loadSettings();
    const urls = resolveRelays();
    const source = process.env.FEZ_RELAY
      ? "env FEZ_RELAY"
      : settings.relays?.length
        ? "settings.relays"
        : settings.relay
          ? "settings.relay (legacy single)"
          : `built-in default (${DEFAULT_RELAY})`;
    console.log(chalk.bold(`\nrelays (${source})`));
    for (const url of urls) console.log(`  ${chalk.cyan(url)}`);
    if (urls.length === 1) {
      console.log(
        chalk.dim("\n  One relay is one operator who can lose your history, go away, or decline to carry it.")
      );
      console.log(chalk.dim("  fez relay add wss://another.example\n"));
    } else {
      console.log(chalk.dim(`\n  Publishes fan out to all ${urls.length}; reads are the union. Any one can fail.\n`));
    }
  });

relayCmd
  .command("add <url>")
  .description("Add a relay to the set")
  .action(async (url: string) => {
    const { loadSettings, saveSettings, resolveRelays } = await import("./settings.js");
    if (!/^wss?:\/\//.test(url)) {
      console.error(chalk.red(`"${url}" is not a relay URL — expected ws:// or wss://`));
      process.exit(1);
    }
    const settings = loadSettings();
    // Fold a legacy single `relay` into the list on first add rather
    // than leaving two settings that disagree about where events go.
    const current = settings.relays?.length ? settings.relays : resolveRelays();
    if (current.includes(url)) {
      console.log(chalk.dim(`${url} is already in the set`));
      return;
    }
    const next = [...current, url];
    saveSettings({ relays: next });
    console.log(chalk.green(`✓ added ${url}`));
    console.log(chalk.dim(`  set is now: ${next.join(", ")}`));
    console.log(chalk.dim("  running agents pick it up on restart"));
  });

relayCmd
  .command("remove <url>")
  .description("Remove a relay from the set")
  .action(async (url: string) => {
    const { loadSettings, saveSettings, resolveRelays } = await import("./settings.js");
    const settings = loadSettings();
    const current = settings.relays?.length ? settings.relays : resolveRelays();
    const next = current.filter((entry) => entry !== url);
    if (next.length === current.length) {
      console.error(chalk.yellow(`${url} is not in the set (${current.join(", ")})`));
      process.exit(1);
    }
    if (next.length === 0) {
      console.error(chalk.red("refusing to remove the last relay — add another first"));
      process.exit(1);
    }
    saveSettings({ relays: next });
    console.log(chalk.green(`✓ removed ${url}`));
    console.log(chalk.dim(`  set is now: ${next.join(", ")}`));
  });

program
  .command("doctor")
  .description("Check identity, relay, harness, personas — with fixes for whatever's missing")
  .action(async () => {
    const { getKey, listKeys } = await import("./keys.js");
    const { detectHarnesses, listHarnesses, registerBuiltinHarnesses } = await import("./harness.js");
    registerBuiltinHarnesses();
    const { listPersonas } = await import("./personas.js");
    const { loadSettings, resolveRelays, DEFAULT_RELAY } = await import("./settings.js");
    const ok = (s: string) => console.log(`  ${chalk.green("✓")} ${s}`);
    const warn = (s: string, fix?: string) => {
      console.log(`  ${chalk.yellow("!")} ${s}`);
      if (fix) console.log(chalk.dim(`      fix: ${fix}`));
    };
    const bad = (s: string, fix?: string) => {
      console.log(`  ${chalk.red("✗")} ${s}`);
      if (fix) console.log(chalk.dim(`      fix: ${fix}`));
      failures++;
    };
    let failures = 0;

    // identity
    const key = getKey("default");
    if (key) {
      const backends = new Set(listKeys().map((k) => k.backend));
      ok(`identity key (${listKeys().find((k) => k.name === "default")?.backend ?? "?"}${backends.has("file") ? "; some agent keys still file-backed — they migrate on next run" : ""})`);
    } else {
      warn("no identity yet — one is generated on first `fez` launch");
    }

    // relays: value + provenance + reachability, EVERY one of them.
    // Checking only the first would pass on a set whose other relays
    // have been unreachable for a month — the failure the set exists to
    // prevent, hidden by the check meant to catch it.
    const relays = resolveRelays();
    const settingsNow = loadSettings();
    const source = process.env.FEZ_RELAY
      ? "env FEZ_RELAY"
      : settingsNow.relays?.length || settingsNow.relay
        ? "~/.fez/settings.json"
        : `built-in default (${DEFAULT_RELAY})`;
    const reach = (url: string) =>
      new Promise<boolean>((resolve) => {
        void import("ws").then(({ default: WebSocket }) => {
          const socket = new WebSocket(url);
          const timer = setTimeout(() => { socket.terminate(); resolve(false); }, 4000);
          socket.on("open", () => { clearTimeout(timer); socket.close(); resolve(true); });
          socket.on("error", () => { clearTimeout(timer); resolve(false); });
        });
      });
    const reachable = await Promise.all(relays.map(reach));
    const upCount = reachable.filter(Boolean).length;
    if (relays.length === 1) {
      if (upCount === 1) {
        ok(`relay ${relays[0]} reachable (${source})`);
        warn("only one relay — its operator can lose or withhold your history", "fez relay add wss://another.example");
      } else {
        bad(`relay ${relays[0]} unreachable (${source})`, "start one (npm run dev:relay in the fez repo) or `fez relay add <url>`");
      }
    } else if (upCount === relays.length) {
      ok(`relays: ${upCount}/${relays.length} reachable (${source})`);
    } else if (upCount > 0) {
      warn(
        `relays: ${upCount}/${relays.length} reachable (${source}) — down: ${relays.filter((_, i) => !reachable[i]).join(", ")}`,
        "publishes still land, but you are closer to a single point of failure than you think"
      );
    } else {
      bad(`no relay reachable of ${relays.length} (${source})`, "check the network, or `fez relay add <url>`");
    }

    // harness
    const harnesses = await detectHarnesses();
    if (harnesses.length > 0) ok(`harness: ${harnesses.map((h) => h.id).join(", ")}`);
    else bad(`no agent harness (checked: ${listHarnesses().map((h) => h.command).join(", ")})`, "npm install -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp");

    // harness auth. Default mode shares the user's own Claude login
    // (Buzz's model — no second session) with account connectors
    // suppressed by env; only explicit FEZ_HARNESS_ISOLATE=1 needs its
    // own clean-room login.
    if (harnesses.length > 0) {
      if (process.env.ANTHROPIC_API_KEY) {
        ok("harness auth: ANTHROPIC_API_KEY set");
      } else if (process.env.FEZ_HARNESS_ISOLATE === "1") {
        const cleanDir = path.join(os.homedir(), ".fez", "harness", "claude", "shared");
        const { createHash } = await import("node:crypto");
        const { spawnSync } = await import("node:child_process");
        const authed =
          process.platform === "darwin"
            ? spawnSync("security", ["find-generic-password", "-s", `Claude Code-credentials-${createHash("sha256").update(cleanDir).digest("hex").slice(0, 8)}`], { stdio: "ignore" }).status === 0
            : await fs.access(path.join(cleanDir, ".credentials.json")).then(() => true, () => false);
        if (authed) ok("harness auth: isolated session present (FEZ_HARNESS_ISOLATE)");
        else bad("FEZ_HARNESS_ISOLATE is set but the clean room isn't logged in", `CLAUDE_CONFIG_DIR=~/.fez/harness/claude/shared claude /login   (one time)`);
      } else {
        ok("harness auth: shared with your Claude login (connectors suppressed)");
      }
    }

    // personas
    const personas = await listPersonas();
    if (personas.length > 0) ok(`personas: ${personas.map((p) => `@${p.id}`).join(", ")}`);
    else warn("no personas — @mentions have nobody to become", "create ~/.fez/personas/<name>.md (the first-run wizard offers a starter)");

    // ── the workspace itself: reachable is not CLAIMED ───────────
    // An unclaimed relay refuses every governed event while answering
    // pings happily, so a doctor that only pinged called a broken
    // workspace healthy. The NIP-11 document is also where relay
    // extensions advertise what they serve — git, below, reads it.
    let nip11: Record<string, unknown> | undefined;
    try {
      const http = relays[0].replace(/^ws(s?):\/\//i, "http$1://").replace(/\/+$/, "");
      const res = await fetch(http, { headers: { Accept: "application/nostr+json" }, signal: AbortSignal.timeout(5000) });
      if (res.ok) nip11 = (await res.json()) as Record<string, unknown>;
    } catch { /* reported below */ }
    if (!nip11) {
      warn("primary relay serves no NIP-11 document — the workspace stays unclaimed", "the relay must answer Accept: application/nostr+json on its http origin");
    } else if (typeof nip11.pubkey !== "string") {
      bad("relay serves NIP-11 but names no owner — channel/roster events will all be refused", "restart the relay with --owner <your pubkey>");
    } else if (key && getPublicKey(Uint8Array.from(Buffer.from(key, "hex"))) === nip11.pubkey) {
      ok(`workspace "${nip11.name ?? "unnamed"}" — you are the owner`);
    } else {
      ok(`workspace "${nip11.name ?? "unnamed"}" · owner ${String(nip11.pubkey).slice(0, 12)}… (not you — you cannot open channels)`);
    }
    const gitBase = (nip11?.fez_git as { clone_base?: string } | undefined)?.clone_base;
    if (gitBase) ok(`git server advertised: ${gitBase}`);

    // ── repo: personas — the whole chain each one needs at spawn ─
    // Every link here failed for real at least once: no provider (spawn
    // dies), no helper in ~/.fez/bin (the agent goes spelunking through
    // password managers for credentials that do not exist), no git
    // server on the relay (clone fails far from the reason).
    const repoPersonas = personas.filter((p) => p.extra.repo);
    if (repoPersonas.length > 0) {
      const who = repoPersonas.map((p) => `@${p.id}`).join(", ");
      const providerDir = path.join(os.homedir(), ".fez", "workspace-providers");
      const providers = (await fs.readdir(providerDir).catch(() => [] as string[])).filter((f) => f.endsWith(".js"));
      if (providers.length === 0) bad(`${who} name a repo: but no workspace provider is installed — their spawn dies`, "fez install @fez/git");
      else ok(`workspace provider present for ${who}`);
      const helper = path.join(os.homedir(), ".fez", "bin", "git-credential-fez");
      if (await fs.access(helper).then(() => true, () => false)) ok("git credential helper: ~/.fez/bin/git-credential-fez");
      else bad("git credential helper missing — agent pushes fail as auth errors far from the cause", "fez install @fez/git (fills ~/.fez/bin)");
      if (nip11 && !gitBase) bad(`${who} need git, but the relay advertises no git server`, "install @fez/git ON THE RELAY; start it with --extensions --origin <public url>");
    }

    // ── sentinel: not just RUNNING — on the RIGHT relay ──────────
    // A launchd env pin held the sentinel to localhost for a day after
    // the workspace moved; every existing check passed while mentions
    // vanished. The log states which relay it bound; the pidfile only
    // proves the process is alive, which was never the question.
    try {
      const pid = Number((await fs.readFile(path.join(os.homedir(), ".fez", "sentinel.pid"), "utf-8")).trim());
      process.kill(pid, 0); // throws if dead
      const log = await fs.readFile(path.join(os.homedir(), ".fez", "logs", "sentinel.log"), "utf-8").catch(() => "");
      const bound = [...log.matchAll(/sentinel on (\S+)/g)].at(-1)?.[1];
      if (bound && !relays.includes(bound)) {
        bad(`sentinel is on ${bound}, but settings say ${relays[0]} — mentions there never reach it`, "launchctl kickstart -k gui/$(id -u)/com.fez.sentinel   (or restart fez sentinel)");
      } else {
        ok(`sentinel running${bound ? ` on ${bound}` : ""} (pid ${pid})`);
      }
    } catch {
      warn("sentinel not running — nothing wakes sleeping agents on DMs/mentions", "fez sentinel   (or: fez sentinel-install)");
    }
    // Legacy relay pins: an env var in a plist outranks settings.json
    // forever, and installers used to write one. Current installers do
    // not — so finding one means it predates the fix and will bite.
    for (const label of ["com.fez.sentinel", "com.fez.orchestrator"]) {
      const plist = await fs.readFile(path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`), "utf-8").catch(() => "");
      if (plist.includes("FEZ_RELAY")) {
        warn(`${label}.plist pins FEZ_RELAY — it overrides settings.json on every start`, `re-run fez ${label.replace("com.fez.", "")}-install (current installers write no pin)`);
      }
    }

    // extensions + themes (informational)
    for (const [dir, label] of [["extensions", "extensions"], ["themes", "themes"], ["workflows", "workflows"]] as const) {
      try {
        const count = (await fs.readdir(path.join(os.homedir(), ".fez", dir))).filter((f) => !f.startsWith(".")).length;
        if (count > 0) ok(`${label}: ${count} installed`);
      } catch { /* none — fine */ }
    }

    // orchestrator endpoint, only if configured
    const { findPersona } = await import("./personas.js");
    const fezPersona = await findPersona("fez");
    const routerUrl = process.env.FEZ_ORCHESTRATOR_URL || fezPersona?.extra.url;
    if (routerUrl) {
      const key = process.env.FEZ_ORCHESTRATOR_KEY || fezPersona?.extra.key;
      const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)\b/.test(routerUrl);
      try {
        const res = await fetch(`${routerUrl.replace(/\/$/, "")}/models`, {
          headers: key ? { Authorization: `Bearer ${key}` } : {},
          // A hosted router is a network round trip, not a loopback call.
          signal: AbortSignal.timeout(local ? 2500 : 8000),
        });
        const body = (await res.json()) as { data?: { id: string }[] };
        ok(`orchestrator router at ${routerUrl} (${body.data?.[0]?.id ?? "?"})`);
      } catch {
        warn(
          `orchestrator router ${routerUrl} not responding`,
          local
            ? "start it, or point fez.md at the hosted router: url: https://137-184-135-188.sslip.io/v1"
            : "check the URL, or run a local one and set url: http://127.0.0.1:8080/v1 in ~/.fez/personas/fez.md"
        );
      }
    }

    // ── external tools installed extensions declare ──────────────
    // An extension that shells out to a missing binary does not crash:
    // it loads, registers, runs on schedule, and quietly does nothing.
    // That failure only ever appeared as a warning in a log nobody
    // reads, so it belongs here, where someone is already looking.
    {
      const { adoptUserPath, whichBinary } = await import("./user-path.js");
      adoptUserPath();
      const extDir = path.join(os.homedir(), ".fez", "extensions");
      const requirements = new Map<string, string[]>(); // binary → extensions wanting it
      let scanned = 0;
      for (const dir of [path.join(process.cwd(), "packages"), extDir]) {
        let entries: string[] = [];
        try { entries = await fs.readdir(dir); } catch { continue; }
        for (const entry of entries) {
          const manifest = path.join(dir, entry, "package.json");
          try {
            const pkg = JSON.parse(await fs.readFile(manifest, "utf-8")) as { fez?: { requires?: string[] } };
            const needs = pkg.fez?.requires ?? [];
            if (needs.length === 0) continue;
            scanned++;
            for (const binary of needs) {
              requirements.set(binary, [...(requirements.get(binary) ?? []), entry]);
            }
          } catch { /* not a fez package */ }
        }
      }
      for (const [binary, wanters] of requirements) {
        const found = whichBinary(binary);
        const who = wanters.join(", ");
        if (found) ok(`${binary} — ${found} (${who})`);
        else warn(`${binary} not found, needed by ${who}`, `install it, then: launchctl kickstart -k gui/$(id -u)/com.fez.sentinel`);
      }
      if (scanned === 0) ok("no extension declares an external tool");
    }

    console.log(failures === 0 ? chalk.green("\nAll clear.") : chalk.red(`\n${failures} problem(s).`));
    process.exitCode = failures === 0 ? 0 : 1;
  });

// ─── run ────────────────────────────────────────────────────────────────────

program
  .command("run")
  .description("Run an agent from a file")
  .argument("<file>", "Path to agent script (.ts or .js)")
  .option("-r, --relay <url>", "Relay URL (default: FEZ_RELAY env, else wss://relay.damus.io)")
  .option("-k, --key <file>", "Private key file (hex)")
  .action(async (file, options) => {
    // Agent scripts are self-contained: they call Agent.create() and
    // agent.start() themselves (see examples/echo-agent.ts). `fez run`
    // doesn't construct the Agent — it just passes the relay/key through
    // as env vars, which scripts read the same way the TUI does.
    // Explicit -r wins; otherwise an inherited FEZ_RELAY stands (a
    // supervisor like herdr sets it on the launched process — a baked-in
    // commander default silently clobbered it), then the user's saved
    // settings, then the public default.
    const { resolveRelays } = await import("./settings.js");
    process.env.FEZ_RELAY = resolveRelays(options.relay).join(",");

    if (options.key) {
      process.env.FEZ_PRIVATE_KEY = (await fs.readFile(options.key, "utf-8")).trim();
    } else if (!process.env.FEZ_PRIVATE_KEY) {
      const { getKey } = await import("./keys.js");
      const stored = getKey("default"); // keychain custody; migrates a legacy plaintext file
      if (stored) process.env.FEZ_PRIVATE_KEY = stored;
      // else: script will auto-generate a key if FEZ_PRIVATE_KEY is unset
    }

    await import(path.resolve(file));
  });

// ─── discover ─────────────────────────────────────────────────────────────

program
  .command("discover")
  .description("Discover agents on the network")
  .option("-r, --relay <url>", "Relay URL", "wss://relay.damus.io")
  .option("-t, --type <type>", "Filter by capability type")
  .option("-n, --name <name>", "Filter by agent name")
  .action(async (options) => {
    const client = new CapabilityClient({ relay: options.relay });
    await client.connect();

    console.log(chalk.blue(`🔍 Discovering agents on ${options.relay}...\n`));

    let agents: Array<{ pubkey: string; name: string; supportedTasks: string[] }> = [];

    if (options.name) {
      agents = await client.findAgentsByName(options.name);
    }

    if (agents.length === 0 && options.type) {
      const capabilities = await client.findCapabilities({ type: options.type });
      capabilities.forEach((cap) => {
        console.log(`  ${chalk.green(cap.name)}`);
        console.log(`    Pubkey: ${chalk.dim(cap.pubkey)}`);
        console.log(`    Type: ${cap.type}`);
        console.log(`    ${cap.description || ""}`);
        if (cap.pricing) {
          console.log(`    Pricing: ${JSON.stringify(cap.pricing)}`);
        }
        console.log();
      });
      client.disconnect();
      return;
    }

    if (agents.length === 0) {
      // Fallback: show all metadata agents
      agents = await client.findAgentsByName("");
    }

    agents.forEach((agent) => {
      console.log(`  ${chalk.green(agent.name)}`);
      console.log(`    Pubkey: ${chalk.dim(agent.pubkey)}`);
      console.log(`    Tasks: ${agent.supportedTasks.join(", ")}`);
      console.log();
    });

    client.disconnect();
  });

// ─── send ───────────────────────────────────────────────────────────────────

program
  .command("send")
  .description("Send a task to an agent")
  .requiredOption("-t, --to <pubkey>", "Target agent pubkey")
  .requiredOption("--type <type>", "Task type")
  .option("-i, --instruction <text>", "Instruction text", "Do something")
  .option("-r, --relay <url>", "Relay URL", "wss://relay.damus.io")
  .option("-k, --key <file>", "Private key file")
  .option("-p, --params <json>", "JSON params", "{}")
  .action(async (options) => {
    let privateKey: string | undefined;
    if (options.key) {
      privateKey = (await fs.readFile(options.key, "utf-8")).trim();
    }

    const client = new CapabilityClient({ relay: options.relay, privateKey });
    await client.connect();

    console.log(chalk.blue(`📤 Sending task to ${options.to}...`));

    const result = await client.sendTask({
      to: options.to,
      taskType: options.type,
      instruction: options.instruction,
      params: JSON.parse(options.params),
    });

    if (result.status === "success") {
      console.log(chalk.green("✅ Success"));
      console.log(JSON.stringify(result.result, null, 2));
    } else {
      console.log(chalk.red(`❌ ${result.status}`));
      console.log(result.error?.message || "Unknown error");
    }

    client.disconnect();
  });

import { PackageManager } from "./package-manager.js";

// ─── install / list / remove ───────────────────────────────────────────────

program
  .command("install <source>")
  .description("Install a fez package (agent, integration, or extension)")
  .option("-v, --version <version>", "Pin to a specific version")
  .action(async (source: string, options) => {
    const pm = new PackageManager();
    await pm.init();
    await pm.install(source, { version: options.version });
  });

program
  .command("link <dir>")
  .description("Dev-install a local extension package: build, copy its entry to ~/.fez/extensions, smoke-import the result")
  .option("--no-build", "Skip the package's npm build script")
  .action(async (dir: string, options) => {
    const { execSync } = await import("node:child_process");
    const { pathToFileURL } = await import("node:url");
    const fsSync = await import("node:fs");
    const pkgDir = path.resolve(dir);
    let manifest: {
      name?: string;
      scripts?: Record<string, string>;
      /** npm's bin map — honored like install: copied to ~/.fez/bin. */
      bin?: Record<string, string>;
      fez?: {
        extension?: { entry?: string };
        /** What this package says it needs — see extension-permissions.ts. */
        permissions?: string[];
        /** Multi-part packages: one install, three attachment points. */
        parts?: {
          skill?: { command?: string; args?: string[]; env?: Record<string, string>; url?: string };
          headless?: string;
          gui?: string;
          /** → ~/.fez/relay-extensions; loaded only by a relay started with --extensions */
          relay?: string;
          /** → ~/.fez/workspace-providers; gives a `repo:` persona a checkout to work in */
          workspace?: string;
          /** opt in to running scheduled tasks inside the always-on sentinel */
          background?: boolean;
        };
      };
    };
    try {
      manifest = JSON.parse(fsSync.readFileSync(path.join(pkgDir, "package.json"), "utf-8"));
    } catch {
      console.error(chalk.red(`No readable package.json in ${pkgDir}`));
      process.exit(1);
    }
    // ── permissions: shown BEFORE anything is copied, recorded on grant.
    const { consentLines, parsePermissions } = await import("./extension-permissions.js");
    const declared = manifest.fez?.permissions;
    const lines = consentLines(declared);
    if (lines.length > 0) {
      console.log(chalk.bold(`\n${manifest.name ?? path.basename(pkgDir)} asks for:`));
      for (const line of lines) {
        console.log(`  ${line.sensitive ? chalk.yellow("\u26a0") : chalk.dim("\u00b7")} ${line.description} ${chalk.dim(`(${line.id})`)}`);
      }
      const { unknown } = parsePermissions(declared);
      if (unknown.length > 0) console.log(chalk.yellow(`  \u26a0 unrecognized: ${unknown.join(", ")} — these grant nothing`));
      console.log(chalk.dim("  (linking a local package grants these)\n"));
    } else {
      console.log(chalk.dim(`${manifest.name ?? "package"} declares no permissions — legacy read-only grant.\n`));
    }

    const parts = manifest.fez?.parts;
    const entry = parts?.headless ?? manifest.fez?.extension?.entry;
    if (!entry && !parts?.gui && !parts?.skill) {
      console.error(chalk.red(`${manifest.name ?? pkgDir} declares no fez.parts (or fez.extension.entry) — nothing to link.`));
      process.exit(1);
    }
    if (options.build !== false && manifest.scripts?.build) {
      // cwd pinned to the package — the copy-from-the-wrong-directory
      // foot-gun is the reason this command exists.
      execSync("npm run build", { cwd: pkgDir, stdio: "inherit" });
    }
    const name = path.basename(pkgDir);

    // ── skill part: merge the MCP definition into the machine catalog.
    // Existing env VALUES the user filled in are kept; the package only
    // supplies names/defaults.
    if (parts?.skill) {
      const { loadSettings, saveSettings } = await import("./settings.js");
      const settings = loadSettings() as { mcpServers?: Record<string, { env?: Record<string, string> }> };
      const existing = settings.mcpServers?.[name];
      const mergedEnv = { ...(parts.skill.env ?? {}), ...(existing?.env ?? {}) };
      saveSettings({
        mcpServers: {
          ...settings.mcpServers,
          [name]: { ...parts.skill, ...(Object.keys(mergedEnv).length ? { env: mergedEnv } : {}) },
        },
      } as never);
      console.log(chalk.green(`✓ skill "${name}" defined — personas declaring mcpServers: [${name}] get it on next spawn`));
    }

    // ── gui part: copied to ~/.fez/gui-extensions for fez-desktop's
    // loader (webview code — no node smoke-import possible here).
    if (parts?.gui) {
      const guiDir = path.join(os.homedir(), ".fez", "gui-extensions");
      fsSync.mkdirSync(guiDir, { recursive: true });
      fsSync.copyFileSync(path.join(pkgDir, parts.gui), path.join(guiDir, `${name}.js`));
      console.log(chalk.green(`✓ gui part → ~/.fez/gui-extensions/${name}.js (loads on next fez-desktop launch)`));
    }

    // ── relay + workspace parts: link matches install exactly. It did
    // not always — link predates multi-part packages, and a linked
    // package that silently dropped its workspace provider meant a
    // `repo:` persona failed loudly (fatal, by design) while the person
    // who "installed" the package stared at a link that said ✓.
    if (parts?.relay) {
      const relayDir = path.join(os.homedir(), ".fez", "relay-extensions");
      fsSync.mkdirSync(relayDir, { recursive: true });
      fsSync.copyFileSync(path.join(pkgDir, parts.relay), path.join(relayDir, `${name}.js`));
      console.log(chalk.green(`✓ relay part → ~/.fez/relay-extensions/${name}.js (a relay started with --extensions loads it)`));
    }
    if (parts?.workspace) {
      const wsDir = path.join(os.homedir(), ".fez", "workspace-providers");
      fsSync.mkdirSync(wsDir, { recursive: true });
      fsSync.copyFileSync(path.join(pkgDir, parts.workspace), path.join(wsDir, `${name}.js`));
      console.log(chalk.green(`✓ workspace provider → ~/.fez/workspace-providers/${name}.js (personas with repo: use it)`));
    }

    // ── bins: same seam install honors, so a linked package's
    // executables (credential helper, fez-adopt) exist in the one
    // predictable place things resolve them from.
    if (manifest.bin) {
      const binDir = path.join(os.homedir(), ".fez", "bin");
      fsSync.mkdirSync(binDir, { recursive: true });
      for (const [cmd, rel] of Object.entries(manifest.bin)) {
        const target = path.join(binDir, cmd);
        fsSync.copyFileSync(path.join(pkgDir, rel), target);
        fsSync.chmodSync(target, 0o755);
        console.log(chalk.green(`✓ bin → ~/.fez/bin/${cmd}`));
      }
      if (!(process.env.PATH ?? "").split(":").includes(path.join(os.homedir(), ".fez", "bin"))) {
        console.log(chalk.dim(`  (~/.fez/bin is not on your PATH — add it to call these by name)`));
      }
    }

    // ── background part: the sentinel only loads extensions that ASKED
    // for background life, so a TUI extension never starts doing its
    // foreground job a second time inside the always-on process.
    {
      const { loadSettings, saveSettings } = await import("./settings.js");
      const { granted } = parsePermissions(declared);
      const settings = loadSettings() as { extensionPermissions?: Record<string, string[]> };
      saveSettings({ extensionPermissions: { ...settings.extensionPermissions, [name]: granted } } as never);
    }

    if (parts?.background) {
      const { loadSettings, saveSettings } = await import("./settings.js");
      const settings = loadSettings() as { backgroundExtensions?: string[] };
      const list = new Set(settings.backgroundExtensions ?? []);
      list.add(name);
      saveSettings({ backgroundExtensions: [...list] } as never);
      console.log(chalk.green(`✓ background tasks enabled — restart the sentinel to run them`));
    }

    if (!entry) {
      console.log(chalk.green(`✓ linked ${name} (no headless part)`));
      return;
    }
    const ext = path.extname(entry) || ".js";
    const extensionsDir = path.join(os.homedir(), ".fez", "extensions");
    fsSync.mkdirSync(extensionsDir, { recursive: true });
    // Stage next to the destination (same dir, so the {"type":"module"}
    // marker applies), smoke-import, and only then replace the installed
    // bundle — a broken build must never clobber a working extension.
    const staged = path.join(extensionsDir, `.staged-${name}${ext}`);
    fsSync.copyFileSync(path.join(pkgDir, entry), staged);
    if (ext === ".js" || ext === ".mjs") {
      try {
        await import(pathToFileURL(staged).href);
      } catch (err) {
        fsSync.rmSync(staged, { force: true });
        console.error(chalk.red(`✗ built bundle fails to import — not installed: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    }
    const dest = path.join(extensionsDir, `${name}${ext}`);
    fsSync.renameSync(staged, dest);
    console.log(chalk.green(`✓ linked ${name}${ext} (${(fsSync.statSync(dest).size / 1024).toFixed(1)}kb) → ~/.fez/extensions/`));
  });

program
  .command("list")
  .description("List installed fez packages")
  .action(async () => {
    const pm = new PackageManager();
    await pm.init();
    const packages = pm.list();

    if (packages.length === 0) {
      console.log(chalk.yellow("No packages installed."));
      console.log(chalk.dim("Try: fez install claude-code"));
      return;
    }

    console.log(chalk.blue(`📦 Installed packages:\n`));
    for (const pkg of packages) {
      console.log(`  ${chalk.green(pkg.name)} ${chalk.dim(pkg.version)}`);
      console.log(`    Type: ${pkg.type}`);
      console.log(`    Source: ${pkg.source}`);
      console.log(`    Installed: ${new Date(pkg.installedAt).toLocaleDateString()}`);
      console.log();
    }
  });

program
  .command("remove <name>")
  .description("Remove an installed fez package")
  .action(async (name: string) => {
    const pm = new PackageManager();
    await pm.init();
    await pm.remove(name);
  });

// ─── persona ────────────────────────────────────────────────────────────────

import { createPersona, listPersonas, removePersona } from "./personas.js";
import { registerBuiltinHarnesses, listHarnesses } from "./harness.js";
import { loadExtensions } from "./extensions.js";

// ─── pair — move the keychain identity to a second device ─────────────────

const pair = program.command("pair").description("Pair a second device: identity travels encrypted, verified by a 6-digit code you compare on both screens");

async function askYesNo(question: string): Promise<boolean> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

pair
  .command("receive")
  .description("Run this on the NEW device — prints a pairing code for the old device")
  .option("--as <account>", "keychain account to store the identity under", "default")
  .option("--relay <url>", "relay to pair over (default: configured relay)")
  .action(async (options: { as: string; relay?: string }) => {
    const { pairReceive } = await import("./pairing.js");
    const { getKey, setKey } = await import("./keys.js");
    const { resolveRelay } = await import("./settings.js");
    if (getKey(options.as)) {
      console.error(`Account "${options.as}" already holds a key — pairing will not overwrite it. Use --as <other-name> or remove it first.`);
      process.exit(1);
    }
    const relayUrl = options.relay ?? resolveRelay(undefined);
    console.log(`⏳ Waiting for the other device (relay: ${relayUrl})…\n`);
    const { key, account } = await pairReceive(relayUrl, {
      confirmSas: async (sas) => {
        console.log(`\n   🔐 Pairing code:  ${sas.slice(0, 3)} ${sas.slice(3)}\n`);
        return askYesNo("   Does the OTHER device show the same 6 digits? [y/N] ");
      },
      log: (line) => console.log(`   ${line}`),
    }, {
      onUri: (uri) => console.log(`On your existing device, run:\n\n   fez pair send "${uri}"\n`),
    });
    setKey(options.as, key);
    console.log(`✅ Identity stored as "${options.as}"${account !== "default" ? ` (sent from account "${account}")` : ""} — this device is now you. Try: fez`);
  });

pair
  .command("send <uri>")
  .description("Run this on your EXISTING device with the code from `fez pair receive`")
  .option("--from <account>", "keychain account to send", "default")
  .action(async (uri: string, options: { from: string }) => {
    const { pairSend } = await import("./pairing.js");
    const { getKey } = await import("./keys.js");
    const key = getKey(options.from);
    if (!key) {
      console.error(`No key under account "${options.from}" (fez keygen first).`);
      process.exit(1);
    }
    await pairSend(uri, key, options.from, {
      confirmSas: async (sas) => {
        console.log(`\n   🔐 Pairing code:  ${sas.slice(0, 3)} ${sas.slice(3)}\n`);
        return askYesNo("   Does the OTHER device show the same 6 digits? [y/N] ");
      },
      log: (line) => console.log(`   ${line}`),
    });
    console.log("✅ Identity delivered — the other device holds your key now too.");
  });

const persona = program.command("persona").description("Manage named agent identities");

persona
  .command("draft <name>")
  .description("Propose a persona for owner review (agents run this from their shell; nothing spawns until approved)")
  .option("--harness <name>", "harness for the agent", "claude-code")
  .option("--description <text>", "what it's for — this is the routing signal")
  .option("--prompt <text>", "system prompt")
  .option("--skills <list>", "comma-separated mcpServers")
  .option("--file <path>", "read the complete persona md from a file instead of flags")
  .action(async (name: string, options) => {
    const { writeDraft } = await import("./persona-drafts.js");
    const proposedBy = process.env.FEZ_AGENT_PERSONA ?? "owner";
    let content: string;
    if (options.file) {
      content = await fs.readFile(options.file, "utf-8");
      if (!/^proposedBy:/m.test(content)) {
        content = content.replace(/^---\r?\n/, `---\nproposedBy: ${proposedBy}\nproposedAt: ${new Date().toISOString()}\n`);
      }
    } else {
      const skills = (options.skills as string | undefined)?.split(",").map((s: string) => s.trim()).filter(Boolean) ?? [];
      content = [
        "---",
        `harness: ${options.harness}`,
        ...(options.description ? [`description: ${options.description}`] : []),
        ...(skills.length ? [`mcpServers: [${skills.join(", ")}]`] : []),
        `proposedBy: ${proposedBy}`,
        `proposedAt: ${new Date().toISOString()}`,
        "---",
        "",
        (options.prompt as string | undefined)?.trim() || `You are ${name}.`,
        "",
      ].join("\n");
    }
    try {
      writeDraft(name, content);
      console.log(`📝 draft "${name}" written (proposed by ${proposedBy}).`);
      console.log(`   The owner reviews it: fez persona drafts · fez persona approve ${name} · fez persona reject ${name}`);
      console.log(`   Nothing spawns until approved — don't claim @${name} exists yet.`);
    } catch (err) {
      console.error(`❌ ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  });

persona
  .command("publish <name>")
  .description("Publish this persona to the marketplace (the full md rides the wire — an agent IS its text)")
  .option("-r, --relay <url>", "Relay URL (default: settings/env)")
  .option("--github <url>", "source/docs link")
  .action(async (name: string, options) => {
    const { resolveRelays } = await import("./settings.js");
    const { loadOrCreateKey } = await import("./keys.js");
    const { KIND_SKILL_LISTING } = await import("./kinds.js");
    const { RelayConnection } = await import("./relay.js");
    const raw = await fs.readFile(path.join(os.homedir(), ".fez", "personas", `${name}.md`), "utf-8").catch(() => undefined);
    if (!raw) {
      console.error(`No persona named "${name}".`);
      process.exitCode = 1;
      return;
    }
    const description = raw.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
    const skills = raw.match(/^mcpServers:\s*\[(.*)\]$/m)?.[1]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
    const client = new CapabilityClient({ relay: resolveRelays(options.relay), privateKey: loadOrCreateKey("default") });
    const relay = new RelayConnection({ urls: resolveRelays(options.relay), authSigner: client.authSigner });
    await relay.connect();
    await relay.publish(
      client.signEvent({
        kind: KIND_SKILL_LISTING,
        tags: [["d", `persona:${name}`]],
        content: JSON.stringify({
          name,
          artifact: "persona",
          description,
          persona: raw, // the complete artifact — no code, just text
          requiredSkills: skills,
          installCmd: `fez persona install ${name}`,
          ...(options.github ? { github: options.github } : {}),
        }),
      })
    );
    console.log(`📡 published persona "${name}" to the marketplace (installers review it like a PR before it goes live).`);
    relay.disconnect();
  });

persona
  .command("install <name>")
  .description("Install a persona from the marketplace — lands as a DRAFT for your review, never straight to live")
  .option("-r, --relay <url>", "Relay URL (default: settings/env)")
  .option("--from <pubkey>", "listing author")
  .action(async (name: string, options) => {
    const { resolveRelays } = await import("./settings.js");
    const { loadOrCreateKey } = await import("./keys.js");
    const { KIND_SKILL_LISTING, KIND_SKILL_INSTALL } = await import("./kinds.js");
    const { RelayConnection } = await import("./relay.js");
    const { writeDraft } = await import("./persona-drafts.js");
    const client = new CapabilityClient({ relay: resolveRelays(options.relay), privateKey: loadOrCreateKey("default") });
    const relay = new RelayConnection({ urls: resolveRelays(options.relay), authSigner: client.authSigner });
    await relay.connect();
    const events = (await relay.query([{ kinds: [KIND_SKILL_LISTING], "#d": [`persona:${name}`], limit: 50 }])) as { pubkey: string; content: string; created_at: number }[];
    const event = events
      .filter((e) => !options.from || e.pubkey === options.from)
      .sort((a, b) => b.created_at - a.created_at)[0];
    if (!event) {
      console.error(`No persona listing named "${name}" on this relay.`);
      relay.disconnect();
      process.exitCode = 1;
      return;
    }
    const listing = JSON.parse(event.content) as { persona?: string; requiredSkills?: string[] };
    if (!listing.persona) {
      console.error("Listing carries no persona body — malformed.");
      relay.disconnect();
      process.exitCode = 1;
      return;
    }
    const stamped = listing.persona.replace(/^---\r?\n/, `---\nproposedBy: marketplace:${event.pubkey.slice(0, 12)}\nproposedAt: ${new Date().toISOString()}\n`);
    try {
      writeDraft(name, stamped);
    } catch (err) {
      console.error(`❌ ${err instanceof Error ? err.message : err}`);
      relay.disconnect();
      process.exitCode = 1;
      return;
    }
    await relay.publish(client.signEvent({ kind: KIND_SKILL_INSTALL, tags: [["skill", `persona:${name}`], ["p", event.pubkey]], content: "" }));
    console.log(`📝 "${name}" downloaded as a DRAFT (by ${event.pubkey.slice(0, 12)}).`);
    console.log(`   Review the prompt like a PR: fez persona drafts → fez persona approve ${name}`);
    if (listing.requiredSkills?.length) {
      console.log(`   Declares skills: ${listing.requiredSkills.join(", ")} — define any you're missing: fez skill list`);
    }
    relay.disconnect();
  });

persona
  .command("drafts")
  .description("List proposed personas awaiting review")
  .action(async () => {
    const { listDrafts } = await import("./persona-drafts.js");
    const drafts = listDrafts();
    if (drafts.length === 0) return console.log("No drafts — agents propose with `fez persona draft <name> ...`.");
    for (const draft of drafts) {
      console.log(`  ${chalk.yellow(draft.id.padEnd(20))} by ${draft.proposedBy ?? "?"}${draft.description ? ` — ${draft.description}` : ""}`);
    }
    console.log(chalk.dim(`\n  fez persona approve <name> · fez persona reject <name> · cat ~/.fez/personas/drafts/<name>.md`));
  });

persona
  .command("approve <name>")
  .description("Approve a draft — validates, installs it as a live persona (@mention then summons it)")
  .action(async (name: string) => {
    const { approveDraft } = await import("./persona-drafts.js");
    const { registerBuiltinHarnesses, listHarnesses } = await import("./harness.js");
    try {
      registerBuiltinHarnesses();
      const { warnings } = approveDraft(name, listHarnesses().map((h) => h.id));
      for (const warning of warnings) console.log(chalk.yellow(`  ⚠ ${warning}`));
      console.log(`✅ @${name} approved — mention @${name} in a channel to summon it.`);
    } catch (err) {
      console.error(`❌ ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  });

persona
  .command("reject <name>")
  .description("Reject and delete a draft")
  .action(async (name: string) => {
    const { rejectDraft } = await import("./persona-drafts.js");
    try {
      rejectDraft(name);
      console.log(`🗑  draft "${name}" rejected.`);
    } catch (err) {
      console.error(`❌ ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  });

persona
  .command("validate [name]")
  .description("Lint persona files: errors fail, unknown keys / missing description warn (Buzz's pack-validate split)")
  .option("--all", "validate every persona in ~/.fez/personas")
  .action(async (name: string | undefined, options: { all?: boolean }) => {
    const { validatePersonaFile } = await import("./personas.js");
    const { registerBuiltinHarnesses, listHarnesses } = await import("./harness.js");
    const fsSync = await import("node:fs");
    const os = await import("node:os");
    const pathMod = await import("node:path");
    registerBuiltinHarnesses();
    const knownHarnesses = listHarnesses().map((h) => h.id);
    const dir = pathMod.join(os.homedir(), ".fez", "personas");
    const targets = options.all || !name
      ? fsSync.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => pathMod.basename(f, ".md"))
      : [name.toLowerCase()];
    let failed = 0;
    for (const id of targets) {
      const file = pathMod.join(dir, `${id}.md`);
      let raw: string;
      try {
        raw = fsSync.readFileSync(file, "utf-8");
      } catch {
        console.error(`✗ ${id}: no such persona (${file})`);
        failed++;
        continue;
      }
      const { errors, warnings } = validatePersonaFile(raw, id, knownHarnesses);
      if (errors.length === 0 && warnings.length === 0) {
        console.log(`✓ ${id}`);
        continue;
      }
      for (const error of errors) console.error(`✗ ${id}: ${error}`);
      for (const warning of warnings) console.warn(`⚠ ${id}: ${warning}`);
      if (errors.length > 0) failed++;
    }
    if (failed > 0) process.exit(1);
  });

persona
  .command("create <name>")
  .description("Create a named persona backed by a harness (e.g. claude-code)")
  .requiredOption("-h, --harness <id>", "Harness id this persona runs on (see: fez persona harnesses)")
  .option("-p, --prompt <text>", "System prompt prefixed to every instruction")
  .option("-a, --alias <names...>", "Additional names this persona responds to")
  .option("-m, --mcp-server <names...>", "Skills (registered MCP servers) this persona gets access to")
  .action(async (name: string, options) => {
    try {
      const p = await createPersona({
        id: name,
        harness: options.harness,
        systemPrompt: options.prompt,
        aliases: options.alias,
        mcpServers: options.mcpServer,
      });
      console.log(chalk.green(`✅ Created persona @${p.id} on harness "${p.harness}"`));
    } catch (err) {
      console.error(chalk.red(`❌ ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

persona
  .command("list")
  .description("List configured personas")
  .action(async () => {
    const personas = await listPersonas();
    if (personas.length === 0) {
      console.log(chalk.yellow("No personas configured."));
      console.log(chalk.dim("Try: fez persona create researcher --harness claude-code --prompt \"...\""));
      return;
    }
    for (const p of personas) {
      console.log(`  ${chalk.green(`@${p.id}`)} ${chalk.dim(`(${p.harness})`)}`);
      if (p.aliases.length) console.log(`    Aliases: ${p.aliases.join(", ")}`);
      if (p.mcpServers.length) console.log(`    Skills: ${p.mcpServers.join(", ")}`);
      if (p.systemPrompt) console.log(`    Prompt: ${p.systemPrompt}`);
      console.log();
    }
  });

persona
  .command("remove <name>")
  .description("Remove a persona")
  .action(async (name: string) => {
    const removed = await removePersona(name);
    console.log(removed ? chalk.green(`✅ Removed @${name}`) : chalk.yellow(`⚠️  No persona named "${name}"`));
  });

persona
  .command("harnesses")
  .description("List available harnesses personas can be built on")
  .action(async () => {
    registerBuiltinHarnesses();
    await loadExtensions();
    for (const h of listHarnesses()) {
      console.log(`  ${chalk.green(h.id)} ${chalk.dim(`(${h.command})`)}`);
    }
  });

// Helpers
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

program.parse();
