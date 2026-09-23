#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { buildNip98Header, keychainFind } from "@fezchat/protocol";
import { gitAuthUrl } from "./auth.js";

/**
 * `git credential-fez` — your nostr key as your git password.
 *
 * git asks a helper for credentials on stdin as `key=value` lines and
 * reads the answer the same way. So a NIP-98 event IS the password:
 * unmodified `git clone` and `git push` authenticate against a fez relay
 * with the key that signs your messages, and there is no account
 * anywhere to create, rotate or leak.
 *
 * Setup:
 *   git config --global --unset-all credential.helper   # see below
 *   git config --global credential.helper fez
 *   git config --global credential.useHttpPath true
 *
 * useHttpPath is REQUIRED, not advice. Without it git hands the helper
 * only a host, and the token could not be scoped to one repository — a
 * credential for any repo on the relay would open all of them.
 *
 * The unset matters on macOS. Apple's Command Line Tools ship a SYSTEM
 * gitconfig setting credential.helper=osxkeychain, and git runs every
 * configured helper rather than the first that answers. osxkeychain
 * cannot store an authtype credential, so it reports "failed to store:
 * -1" on every push — an alarming line about a push that completely
 * succeeded. Clearing the list first (or `-c credential.helper=` for one
 * command) removes it. Verified against a live relay.
 *
 * The key comes from the macOS keychain by default, the same custody the
 * rest of fez uses, so nothing here reads a key file lying on disk.
 */

const KEYCHAIN_SERVICE = "fez-keys";
const KEYCHAIN_ACCOUNT = "default";

function readStdin(): string {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return ""; // no stdin (a bare `git credential-fez get` by hand)
  }
}

function secretKey(): Uint8Array {
  const hex =
    process.env.FEZ_SECRET_KEY?.trim() ||
    (keychainFind(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) ?? "");
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("fez key is not 32 bytes of hex");
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}

function main(): void {
  // git invokes the helper as `get`, `store` or `erase`. Only get means
  // anything here: there is nothing to store (the key already exists)
  // and nothing to erase (no credential was cached).
  //
  // But stdin is DRAINED first regardless. git writes the credential to
  // the helper on `store`, and exiting without reading it leaves git
  // writing into a closed pipe — which it reports on every single push
  // as "failed to store: -1". Nothing was broken; the helper just hung
  // up mid-sentence.
  const input = readStdin();
  if (process.argv[2] !== "get") process.exit(0);

  const request = Object.fromEntries(
    input
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      })
  ) as Record<string, string>;

  const { protocol, host, path: reqPath } = request;
  if (!protocol || !host) process.exit(0); // not enough to sign for; git falls back
  if (!reqPath) {
    console.error("git-credential-fez: set credential.useHttpPath true — without it a token cannot name a repo");
    process.exit(1);
  }

  let header: string;
  try {
    // The URL is reduced to the REPOSITORY, because git signs once per
    // operation and reuses the token for the ref GET and the pack POST.
    // gitAuthUrl is the shared definition the relay verifies against.
    header = buildNip98Header(secretKey(), gitAuthUrl(protocol, host, `/${reqPath}`), "GET");
  } catch (err) {
    console.error(`git-credential-fez: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // authtype/credential, NOT username/password.
  //
  // A helper answering with a password makes git send HTTP BASIC auth —
  // `Authorization: Basic base64(user:pass)` — which is not what the
  // relay verifies and would fail with a confusing 401. git 2.46 added
  // `authtype` to the credential protocol precisely so a helper can name
  // its own scheme; this is the reason Buzz's README pins that version.
  //
  // username is still emitted for older gits, which ignore authtype and
  // fall back to Basic. Those will not authenticate, and the relay's
  // 401 says why — better than silently sending the wrong scheme.
  process.stdout.write(
    `capability[]=authtype\nauthtype=Nostr\ncredential=${header.replace(/^Nostr /, "")}\nusername=nostr\n`
  );
}

// Run only when INVOKED, not when imported. This file gets copied next
// to the workspace provider (the provider resolves it as a sibling), and
// the provider loader imports every .js it finds — a bin that executes
// at import time would run a credential exchange against an empty stdin
// and exit the host process.
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
// realpath BOTH sides: node resolves the main module through symlinks,
// so under `ln -s` or an npm bin shim import.meta.url is the real file
// while argv[1] is the link — a naive compare made the helper silently
// print nothing and every push die as an opaque 401 (review finding F9).
const invoked = (() => {
  try {
    return process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : undefined;
  } catch {
    return process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
  }
})();
if (invoked && import.meta.url === invoked) {
  main();
}
