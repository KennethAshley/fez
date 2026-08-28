/** keygen, key custody (keychain / NIP-49), the setup wizard, and device pairing. */
import type { Command } from "commander";
import chalk from "chalk";
import fs from "fs/promises";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";

export function registerIdentityCommands(program: Command): void {
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
    const { listKeys } = await import("../identity/keys.js");
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
    const { exportKey } = await import("../identity/keys.js");
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
    const { getKey, importKey } = await import("../identity/keys.js");
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
    const { pairReceive } = await import("../identity/pairing.js");
    const { getKey, setKey } = await import("../identity/keys.js");
    const { resolveRelay } = await import("../shared/settings.js");
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
    const { pairSend } = await import("../identity/pairing.js");
    const { getKey } = await import("../identity/keys.js");
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
}
