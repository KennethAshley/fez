import { fezHome } from "../shared/fez-home.js";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { detectHarnesses, registerBuiltinHarnesses } from "../agent/harness.js";
import { listPersonas } from "../identity/personas.js";
import { CAPABLE_FEZ_PERSONA } from "../identity/fez-persona.js";
import { HOSTED_ROUTER, resolveRelay, saveSettings } from "../shared/settings.js";

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
    console.log(chalk.dim("    Claude Code:  npm install -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp"));
    console.log(chalk.dim("    or pi (any provider, incl. local models):  npm install -g --ignore-scripts @earendil-works/pi-coding-agent pi-acp"));
  }

  // 3. Starter persona, only when none exist and there's a harness to run it.
  // Fleet default: prefer pi when both engines are present — it runs on
  // any provider (or none), so starter personas work account-free.
  const starterHarness = harnesses.find((h) => h.id === "pi") ?? harnesses[0];
  if ((await listPersonas()).length === 0 && harnesses.length > 0) {
    const { starter } = await inquirer.prompt([
      { type: "confirm", name: "starter", message: "Create a starter persona (@researcher)?", default: true },
    ]);
    if (starter) {
      const file = fezHome("personas", "researcher.md");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Written directly (not createPersona) to include the description
      // frontmatter — verb phrases are what orchestrators route on.
      fs.writeFileSync(
        file,
        `---\nharness: ${starterHarness.id}\naliases: [research]\ndescription: search the web, find papers and specs, look up facts\n---\nYou are a research assistant. Be concise.\n`,
        "utf-8"
      );
      console.log(`  ${chalk.green("✓")} @researcher → ${file} (edit the markdown to shape it)`);
    }
  }

  // 4. The orchestrator itself. Without this there is nobody to talk to
  // on a fresh install: @mentions only work if you already know which
  // agent you want, and the whole point of @fez is not having to.
  //
  // `harness: router` is not an agent — it holds no session and writes
  // no prose. It reads the roster, asks a small model which name fits,
  // and hands off. So it is created even when no harness is installed:
  // routing works before thinking does.
  //
  // The URL is the HOSTED router, deliberately. A fresh machine has no
  // model and no server, and an out-of-box orchestrator that silently
  // does nothing is worse than none at all. `fez router-install` swaps
  // this one line for a local endpoint — ~90ms instead of ~3s, and no
  // dependence on somebody else's box.
  // Smart default: with a real harness, @fez IS the guide — one agent that
  // answers about fez AND delegates. Without one, fall back to the tiny
  // hosted router (install nothing) that only routes to a seeded guide.
  const guideBrain = harnesses.find((h) => h.id === "claude-code")?.id ?? harnesses.find((h) => h.id === "pi")?.id;
  const fezFile = fezHome("personas", "fez.md");
  if (!fs.existsSync(fezFile)) {
    fs.mkdirSync(path.dirname(fezFile), { recursive: true });
    if (guideBrain) {
      fs.writeFileSync(fezFile, CAPABLE_FEZ_PERSONA.replace("{{HARNESS}}", guideBrain), "utf-8");
      console.log(`  ${chalk.green("✓")} @fez → ${fezFile} (your guide, on ${guideBrain})`);
    } else {
      fs.writeFileSync(
        fezFile,
        "---\n" +
          "routable: false\n" +
          "harness: router\n" +
          `url: ${HOSTED_ROUTER}\n` +
          "aliases: [orchestrator]\n" +
          "fallback: fez-guide\n" +
          "description: routes tasks to the right agent — mention @fez with anything\n" +
          "---\n" +
          "🎩 fez here. Mention @fez with a task and I'll bring in whoever's best for it.\n",
        "utf-8"
      );
      console.log(`  ${chalk.green("✓")} @fez → ${fezFile} (routes to the hosted router)`);
      console.log(chalk.dim(`    install a harness (Claude Code / pi) and re-run to make @fez a full guide`));
    }
  }

  saveSettings({ relay: relay.trim(), onboarded: true });
  console.log(`\n  ${chalk.green("✓")} saved to ~/.fez/settings.json — check your setup anytime with ${chalk.cyan("fez doctor")}\n`);
}
