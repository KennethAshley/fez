#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { CapabilityClient } from "./client.js";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import fs from "fs/promises";
import path from "path";
import os from "os";

const program = new Command();

program.name("fez").description("Fez — decentralized MCP for agents").version("0.1.0");

// ─── Default: Open TUI when no command given ───────────────────────────────

if (process.argv.length <= 2) {
  // No arguments — launch TUI
  const { FezTUI } = await import("./tui.js");
  const tui = new FezTUI(
    process.env.FEZ_RELAY || "wss://relay.damus.io",
    process.env.FEZ_PRIVATE_KEY
  );
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

// ─── run ────────────────────────────────────────────────────────────────────

program
  .command("run")
  .description("Run an agent from a file")
  .argument("<file>", "Path to agent script (.ts or .js)")
  .option("-r, --relay <url>", "Relay URL", "wss://relay.damus.io")
  .option("-k, --key <file>", "Private key file (hex)")
  .action(async (file, options) => {
    // Agent scripts are self-contained: they call Agent.create() and
    // agent.start() themselves (see examples/echo-agent.ts). `fez run`
    // doesn't construct the Agent — it just passes the relay/key through
    // as env vars, which scripts read the same way the TUI does.
    process.env.FEZ_RELAY = options.relay;

    if (options.key) {
      process.env.FEZ_PRIVATE_KEY = (await fs.readFile(options.key, "utf-8")).trim();
    } else if (!process.env.FEZ_PRIVATE_KEY) {
      const defaultKeyPath = path.join(os.homedir(), ".fez", "default.key");
      try {
        process.env.FEZ_PRIVATE_KEY = (await fs.readFile(defaultKeyPath, "utf-8")).trim();
      } catch {
        // script will auto-generate a key if FEZ_PRIVATE_KEY is unset
      }
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
  .action(async (name: string, options) => {
    try {
      const p = await createPersona({
        id: name,
        harness: options.harness,
        systemPrompt: options.prompt,
        aliases: options.alias,
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
