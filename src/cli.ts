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
  const { loadSettings, resolveRelay } = await import("./settings.js");
  if (!loadSettings().onboarded && process.stdin.isTTY && process.stdout.isTTY) {
    const { firstRunWizard } = await import("./onboarding.js");
    await firstRunWizard();
  }

  const { FezTUI } = await import("./tui.js");
  const tui = new FezTUI(resolveRelay(), privateKey);
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
  communityId: string;
  latest?: { id: string; created_at: number; content: string };
}

async function docContext(channelFlag: string | undefined, personaFlag: string | undefined): Promise<DocCliContext> {
  const { getKey } = await import("./keys.js");
  const { resolveRelay } = await import("./settings.js");
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
  const relay = new RelayConnection({ url: resolveRelay() });
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
  const communityId = match?.tags.find((t) => t[0] === "c")?.[1];
  if (!channelId || !communityId) {
    console.error(`No channel "${channelSpec}" on the relay.`);
    relay.disconnect();
    process.exit(1);
  }
  const versions = await relay.query([{ kinds: [40100], "#h": [channelId], limit: 200 }]);
  const latest = versions.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? 1 : -1)).at(-1);
  const secret = Uint8Array.from(Buffer.from(hex, "hex"));
  return { secret, pubkey: pk(secret), relay, channelId, communityId, latest };
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
        tags: [["h", ctx.channelId], ["c", ctx.communityId], ...(ctx.latest ? [["base", ctx.latest.id]] : [])],
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
  .option("--respond-to <policy>", "anyone | owner | allowlist:<pk,...>", "owner")
  .option("--owner <pubkey>", "owner pubkey (default: your fez identity)")
  .option("--on-busy <mode>", "steer | queue", "steer")
  .action(async (personaId: string, options) => {
    const { resolveRelay } = await import("./settings.js");
    process.env.FEZ_RELAY = resolveRelay(options.relay);
    process.env.FEZ_AGENT_PERSONA = personaId;
    process.env.FEZ_AGENT_CHANNELS = options.channels === "none" ? "" : options.channels;
    process.env.FEZ_AGENT_RESPOND_TO = options.respondTo;
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
    const { resolveRelay } = await import("./settings.js");
    process.env.FEZ_RELAY = resolveRelay(options.relay);
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
    const { resolveRelay } = await import("./settings.js");
    const { execSync } = await import("node:child_process");
    const fsSync = await import("node:fs");
    const relayUrl = resolveRelay(options.relay);
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
    <key>PATH</key><string>${pathEnv}</string>
    <key>FEZ_RELAY</key><string>${relayUrl}</string>
    <key>HOME</key><string>${os.homedir()}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
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

// ─── doctor — is this machine ready to fez? ─────────────────────────────────

program
  .command("doctor")
  .description("Check identity, relay, harness, personas — with fixes for whatever's missing")
  .action(async () => {
    const { getKey, listKeys } = await import("./keys.js");
    const { detectHarnesses, listHarnesses, registerBuiltinHarnesses } = await import("./harness.js");
    registerBuiltinHarnesses();
    const { listPersonas } = await import("./personas.js");
    const { loadSettings, resolveRelay, DEFAULT_RELAY } = await import("./settings.js");
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

    // relay: value + provenance + reachability
    const relay = resolveRelay();
    const source = process.env.FEZ_RELAY
      ? "env FEZ_RELAY"
      : loadSettings().relay
        ? "~/.fez/settings.json"
        : `built-in default (${DEFAULT_RELAY})`;
    const reachable = await new Promise<boolean>((resolve) => {
      void import("ws").then(({ default: WebSocket }) => {
        const socket = new WebSocket(relay);
        const timer = setTimeout(() => { socket.terminate(); resolve(false); }, 4000);
        socket.on("open", () => { clearTimeout(timer); socket.close(); resolve(true); });
        socket.on("error", () => { clearTimeout(timer); resolve(false); });
      });
    });
    if (reachable) ok(`relay ${relay} reachable (${source})`);
    else bad(`relay ${relay} unreachable (${source})`, `start one (npm run dev:relay in the fez repo) or set another in ~/.fez/settings.json`);

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
      try {
        const res = await fetch(`${routerUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(2500) });
        const body = (await res.json()) as { data?: { id: string }[] };
        ok(`orchestrator router at ${routerUrl} (${body.data?.[0]?.id ?? "?"})`);
      } catch {
        warn(`orchestrator router ${routerUrl} not responding`, "cactus serve ~/.cache/cactus/weights/needle-prebuilt --no-cloud-handoff --no-cloud-tele");
      }
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
    const { resolveRelay } = await import("./settings.js");
    process.env.FEZ_RELAY = resolveRelay(options.relay);

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
    let manifest: { name?: string; scripts?: Record<string, string>; fez?: { extension?: { entry?: string } } };
    try {
      manifest = JSON.parse(fsSync.readFileSync(path.join(pkgDir, "package.json"), "utf-8"));
    } catch {
      console.error(chalk.red(`No readable package.json in ${pkgDir}`));
      process.exit(1);
    }
    const entry = manifest.fez?.extension?.entry;
    if (!entry) {
      console.error(chalk.red(`${manifest.name ?? pkgDir} declares no fez.extension.entry — nothing to link.`));
      process.exit(1);
    }
    if (options.build !== false && manifest.scripts?.build) {
      // cwd pinned to the package — the copy-from-the-wrong-directory
      // foot-gun is the reason this command exists.
      execSync("npm run build", { cwd: pkgDir, stdio: "inherit" });
    }
    const name = path.basename(pkgDir);
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
