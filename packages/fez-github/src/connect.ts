#!/usr/bin/env node
import { appClientId, connect } from "./auth.js";
import { verificationUrl } from "./app-id.js";
import { ready } from "./github.js";

/**
 * `fez-github connect` — authorize this machine against the GitHub App.
 *
 * It lives in the extension rather than in fez's own CLI because core
 * compiles with rootDir ./src and cannot import a package; but that
 * constraint points the same way the design does. An extension that
 * needs a credential should own the act of getting one, so installing it
 * brings its setup along instead of requiring a matching change in core.
 *
 * This is the terminal version. The device flow is four HTTP calls and a
 * code to read aloud, all of which a webview can do — so the desktop app
 * is where this belongs, with the token written through the keychain
 * command it already has. This exists so the extension is usable before
 * that lands, not instead of it.
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--client-id");
  // Still overridable, for anyone running their own App — but no longer
  // something you must have before this command does anything.
  const clientId = (flag >= 0 ? args[flag + 1] : undefined) ?? appClientId();

  if (args[0] === "status" || args.includes("--status")) {
    const who = await ready();
    console.log(who.ok ? `✓ connected as ${who.login}` : `! ${who.why}`);
    process.exit(who.ok ? 0 : 1);
  }

  await connect((code) => {
    console.log(`\n  Open ${verificationUrl(code)}\n`);
    console.log(`  and enter:  ${code.userCode}\n`);
    console.log("  Waiting for you to approve it…");
  }, clientId);

  const who = await ready();
  console.log(
    who.ok
      ? `\n✓ connected as ${who.login} — token in your keychain, never in settings.json or on the relay`
      : `\n! token saved, but GitHub says: ${who.why}`
  );
  process.exit(who.ok ? 0 : 1);
}

void main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
