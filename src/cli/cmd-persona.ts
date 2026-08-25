/** fez persona — named agent identities: drafts, review gates, marketplace publish/install. */
import type { Command } from "commander";
import chalk from "chalk";
import fs from "fs/promises";
import { CapabilityClient } from "../protocol/client.js";
import { createPersona, listPersonas, removePersona } from "../identity/personas.js";
import { registerBuiltinHarnesses, listHarnesses } from "../agent/harness.js";
import { loadExtensions } from "../extensions/extensions.js";
import { fezHome } from "../shared/fez-home.js";

export function registerPersonaCommands(program: Command): void {
// ─── persona ────────────────────────────────────────────────────────────────


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
    const { writeDraft } = await import("../identity/persona-drafts.js");
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
    const { resolveRelays } = await import("../shared/settings.js");
    const { loadOrCreateKey } = await import("../identity/keys.js");
    const { KIND_SKILL_LISTING } = await import("../protocol/kinds.js");
    const { RelayConnection } = await import("../protocol/relay.js");
    const raw = await fs.readFile(fezHome("personas", `${name}.md`), "utf-8").catch(() => undefined);
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
    const { resolveRelays } = await import("../shared/settings.js");
    const { loadOrCreateKey } = await import("../identity/keys.js");
    const { KIND_SKILL_LISTING, KIND_SKILL_INSTALL } = await import("../protocol/kinds.js");
    const { RelayConnection } = await import("../protocol/relay.js");
    const { writeDraft } = await import("../identity/persona-drafts.js");
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
    const { listDrafts } = await import("../identity/persona-drafts.js");
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
    const { approveDraft } = await import("../identity/persona-drafts.js");
    const { registerBuiltinHarnesses, listHarnesses } = await import("../agent/harness.js");
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
    const { rejectDraft } = await import("../identity/persona-drafts.js");
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
    const { validatePersonaFile } = await import("../identity/personas.js");
    const { registerBuiltinHarnesses, listHarnesses } = await import("../agent/harness.js");
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
}
