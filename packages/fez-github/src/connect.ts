#!/usr/bin/env node
import { pollForToken, requestDeviceCode, saveTokens, savedClientId } from "./auth.js";
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
  const clientId = (flag >= 0 ? args[flag + 1] : undefined) ?? (await savedClientId());

  if (args[0] === "status" || args.includes("--status")) {
    const who = await ready();
    console.log(who.ok ? `✓ connected as ${who.login}` : `! ${who.why}`);
    process.exit(who.ok ? 0 : 1);
  }

  if (!clientId) {
    console.error(
      "Need a Client ID.\n" +
        "  1. register a GitHub App (read-only, per-repo) — see SETUP.md\n" +
        "  2. enable Device Flow in its settings (it is OFF by default)\n" +
        "  3. fez-github connect --client-id Iv23li…"
    );
    process.exit(1);
  }

  const code = await requestDeviceCode(clientId);
  console.log(`\n  Open ${code.verificationUri} and enter:\n`);
  console.log(`      ${code.userCode}\n`);
  console.log(`  Waiting… the code lasts ${Math.round(code.expiresIn / 60)} minutes.`);

  const tokens = await pollForToken(clientId, code);
  await saveTokens(clientId, tokens);
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
