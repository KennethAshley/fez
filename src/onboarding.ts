import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { detectHarnesses, registerBuiltinHarnesses } from "./harness.js";
import { listPersonas } from "./personas.js";
import { resolveRelay, saveSettings } from "./settings.js";

/**
 * First-run wizard — the entire required surface of fez is deliberately
 * ONE question: which relay. Identity is already generated (keychain),
 * a harness is detected rather than configured, a starter persona
 * covers the empty case, and the communities extension creates a Home
 * community on first connect. Runs once; sets settings.onboarded.
 */
export async function firstRunWizard(): Promise<void> {
  const inquirer = (await import("inquirer")).default;

  console.log(chalk.bold("\nWelcome to fez — let's get you set up\n"));

  // 1. The relay — the only real input. An inherited FEZ_RELAY becomes
  // the suggestion so existing setups just press enter.
  const { relay } = await inquirer.prompt([
    {
      type: "input",
      name: "relay",
      message: "Nostr relay URL (your own fez-relay, or a public one):",
      // Re-runs (fez setup) suggest whatever currently wins: env > saved > default.
      default: resolveRelay(),
      validate: (v: string) => (/^wss?:\/\/.+/.test(v.trim()) ? true : "expected ws:// or wss://"),
    },
  ]);

  // 2. Harness — detected, not configured. Missing = the one actionable gap.
  registerBuiltinHarnesses();
  const harnesses = await detectHarnesses();
  if (harnesses.length > 0) {
    console.log(`  ${chalk.green("✓")} agent harness: ${harnesses.map((h) => h.id).join(", ")}`);
  } else {
    console.log(`  ${chalk.yellow("!")} no agent harness found — fez chats work, but @mentions can't think yet.`);
    console.log(chalk.dim("    install Claude Code + the ACP adapter:  npm install -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp"));
  }

  // 3. Starter persona, only when none exist and there's a harness to run it.
  if ((await listPersonas()).length === 0 && harnesses.length > 0) {
    const { starter } = await inquirer.prompt([
      { type: "confirm", name: "starter", message: "Create a starter persona (@researcher)?", default: true },
    ]);
    if (starter) {
      const file = path.join(os.homedir(), ".fez", "personas", "researcher.md");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Written directly (not createPersona) to include the description
      // frontmatter — verb phrases are what orchestrators route on.
      fs.writeFileSync(
        file,
        `---\nharness: ${harnesses[0].id}\naliases: [research]\ndescription: search the web, find papers and specs, look up facts\n---\nYou are a research assistant. Be concise.\n`,
        "utf-8"
      );
      console.log(`  ${chalk.green("✓")} @researcher → ${file} (edit the markdown to shape it)`);
    }
  }

  saveSettings({ relay: relay.trim(), onboarded: true });
  console.log(`\n  ${chalk.green("✓")} saved to ~/.fez/settings.json — check your setup anytime with ${chalk.cyan("fez doctor")}\n`);
}
