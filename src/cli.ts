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

// ─── agent — run a standing channel agent (the fez-acp runtime) ─────────────

program
  .command("agent <persona>")
  .description("Run a standing channel agent for a persona (fez-acp runtime)")
  .option("-c, --channels <list>", "channel names/ids, comma-separated", "general")
  .option("-r, --relay <url>", "Relay URL (default: settings/env)")
  .option("--respond-to <policy>", "anyone | owner | allowlist:<pk,...>", "owner")
  .option("--owner <pubkey>", "owner pubkey (default: your fez identity)")
  .option("--on-busy <mode>", "steer | queue", "steer")
  .action(async (personaId: string, options) => {
    const { resolveRelay } = await import("./settings.js");
    process.env.FEZ_RELAY = resolveRelay(options.relay);
    process.env.FEZ_AGENT_PERSONA = personaId;
    process.env.FEZ_AGENT_CHANNELS = options.channels;
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

    // harness clean-room auth: agents run against an isolated Claude
    // config dir with its OWN login session (a copied token rots — see
    // harness.ts). API key in env makes login unnecessary.
    if (harnesses.length > 0 && process.env.FEZ_HARNESS_INHERIT !== "1") {
      if (process.env.ANTHROPIC_API_KEY) {
        ok("harness auth: ANTHROPIC_API_KEY set");
      } else {
        const cleanDir = path.join(os.homedir(), ".fez", "harness", "claude", "shared");
        const { createHash } = await import("node:crypto");
        const { spawnSync } = await import("node:child_process");
        const authed =
          process.platform === "darwin"
            ? spawnSync("security", ["find-generic-password", "-s", `Claude Code-credentials-${createHash("sha256").update(cleanDir).digest("hex").slice(0, 8)}`], { stdio: "ignore" }).status === 0
            : await fs.access(path.join(cleanDir, ".credentials.json")).then(() => true, () => false);
        if (authed) ok("harness auth: clean-room session present");
        else bad("harness clean room isn't logged in — agent turns will fail", `CLAUDE_CONFIG_DIR=~/.fez/harness/claude/shared claude /login   (one time)`);
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

const persona = program.command("persona").description("Manage named agent identities");

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
