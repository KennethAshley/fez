#!/usr/bin/env node
import { fezHome } from "./shared/fez-home.js";
import { Command } from "commander";
import { FEZ_VERSION } from "./extensions/host-compat.js";

// Loads ./.env (secrets like GITHUB_TOKEN for extension-registered MCP
// servers, see mcp-servers.ts) before anything reads process.env. Node's
// built-in loader, not the `dotenv` package — one less dependency for
// something this small. No .env file is the common case, not an error.
try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}
// The CANONICAL secret file: ~/.fez/.env. cwd-relative ./.env is fine
// for a dev shell, but a launchd SERVICE (the orchestrator, the
// sentinel) has no useful cwd — its secrets belong in a fixed home, so
// `FEZ_ORCHESTRATOR_KEY=…` in ~/.fez/.env reaches every `fez`
// invocation. Loaded second so a project-local ./.env can still
// override for development. Existing process env always wins (path=…).
try {
  process.loadEnvFile(fezHome(".env"));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}
// The GUI writes secrets to the keychain (service "fez-skill-env"), so a
// managed secret set in Skills & Secrets reaches CLI services too: for
// any FEZ_* var still unset, fall back to a same-named keychain entry.
// One custody, two faces — .env for the terminal, keychain for the app.
for (const { env: name, account } of [
  // env var  ←  keychain account the GUI's SecretField writes (<skill>.<key>)
  { env: "FEZ_ORCHESTRATOR_KEY", account: "fez.FEZ_ORCHESTRATOR_KEY" },
]) {
  if (process.env[name]) continue;
  try {
    const out = (await import("node:child_process")).execFileSync(
      "security",
      ["find-generic-password", "-s", "fez-skill-env", "-a", account, "-w"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    if (out) process.env[name] = out;
  } catch { /* no keychain entry — the common case */ }
}

const program = new Command();

program.name("fez").description("Fez — decentralized MCP for agents").version(FEZ_VERSION);

// ─── Default: Open TUI when no command given ───────────────────────────────

if (process.argv.length <= 2) {
  // No arguments — launch TUI. Identity must be stable across restarts —
  // community creator rights and channel membership are bound to the
  // pubkey, so a regenerated key each run would orphan everything you
  // created. Resolution: env override > ~/.fez/default.key > generate
  // once and persist there.
  let privateKey = process.env.FEZ_PRIVATE_KEY;
  if (!privateKey) {
    const { loadOrCreateKey } = await import("./identity/keys.js");
    privateKey = loadOrCreateKey("default"); // keychain custody; migrates a legacy plaintext file
  }

  // First run (interactive terminals only — scripted/piped invocations
  // must never block on prompts): the whole required surface is ONE
  // input, the relay URL. Key already exists (above), a missing harness
  // gets actionable guidance, a starter persona covers the empty case,
  // and the communities extension bootstraps a Home community on its
  // side. Everything lands in ~/.fez/settings.json.
  const { loadSettings, resolveRelays } = await import("./shared/settings.js");
  if (!loadSettings().onboarded && process.stdin.isTTY && process.stdout.isTTY) {
    const { firstRunWizard } = await import("./cli/onboarding.js");
    await firstRunWizard();
  }

  const { FezTUI } = await import("./cli/tui.js");
  const tui = new FezTUI(resolveRelays(), privateKey);
  await tui.start();
  // TUI blocks until /quit, then exits cleanly
  process.exit(0);
}

// ─── commands — one registrar per group, see src/cli/cmd-*.ts ───────────────

import { registerIdentityCommands } from "./cli/cmd-identity.js";
import { registerMemCommands } from "./cli/cmd-mem.js";
import { registerDocCommands } from "./cli/cmd-doc.js";
import { registerServiceCommands } from "./cli/cmd-services.js";
import { registerWorkspaceCommands } from "./cli/cmd-workspace.js";
import { registerSkillCommands } from "./cli/cmd-skill.js";
import { registerExtensionCommands } from "./cli/cmd-extensions.js";
import { registerPersonaCommands } from "./cli/cmd-persona.js";
import { registerResetCommand } from "./cli/cmd-reset.js";

registerIdentityCommands(program);
registerMemCommands(program);
registerDocCommands(program);
registerServiceCommands(program);
registerWorkspaceCommands(program);
registerSkillCommands(program);
registerExtensionCommands(program);
registerPersonaCommands(program);
registerResetCommand(program);

program.parse();
