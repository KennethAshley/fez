#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapabilityClient,
  RelayConnection,
  getKey,
  resolveRelays,
  makeChannels,
  type NostrAccess,
} from "@fez/protocol";
import { REPO_NAME, cloneBase, cloneUrl, repoDoc } from "./repo-name.js";

/**
 * `fez-adopt` — put the repo you are STANDING IN onto the relay.
 *
 * The other flows start from nothing: /repo new opens a channel and the
 * first push creates the repository. But the common real case is the
 * opposite — the code already exists, locally, with history, and what's
 * missing is the relay half. This closes that gap in one command run
 * from inside the repo:
 *
 *   1. opens the repo's channel (owner-signed, protect=main)
 *   2. adds a `fez` remote pointing at the relay's advertised git base
 *   3. pushes the current branch, authenticating as you
 *
 * The directory supplies the context: the repo name is the directory
 * name unless you say otherwise, and the branch pushed is the one you
 * are on. Adoption is not migration — origin, GitHub, everything else
 * about the repo is left exactly as it was; fez is one more remote.
 *
 * Owner-only, and honestly so: the channel is what makes a repo exist
 * in fez, channels are owner-signed, and the push that lays down `main`
 * must clear its own branch protection — which the owner does and a
 * member does not. A member who wants a repo adopted asks the owner;
 * the error says exactly that instead of half-succeeding.
 */

function usage(): never {
  console.log(
    "usage: fez-adopt [name | git-url] [--branch <b>] [--relay <url>]\n\n" +
      "Adopts a repository into the fez workspace: opens its channel, adds a\n" +
      "`fez` remote, pushes the current branch.\n\n" +
      "Run inside a git repository, or give a URL to clone first:\n" +
      "  fez-adopt                                  adopt the repo you are in\n" +
      "  fez-adopt myname                           same, under a chosen name\n" +
      "  fez-adopt https://github.com/a/b           clone into ./b, then adopt it\n\n" +
      "  --branch   branch to push (default: the one you are on)\n" +
      "  --relay    relay url (default: your configured fez relay)"
  );
  process.exit(0);
}

function git(args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { encoding: "utf-8", env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fail(message: string): never {
  console.error(`⑂ ${message}`);
  process.exit(1);
}

/** The bundled credential helper, sitting next to this file. */
function helperPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const name of ["credential.js", "git-credential-fez"]) {
    const candidate = path.join(here, name);
    if (existsSync(candidate)) return candidate;
  }
  fail("credential helper not found beside fez-adopt — reinstall @fez/git");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) usage();
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at !== -1 ? args[at + 1] : undefined;
  };
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1]?.startsWith("--") !== true);

  // ── a URL means "go get it first". Everything after this point is
  //    identical to adopting a directory, because after the clone it IS
  //    one — the URL form is sugar, not a second code path.
  const arg = positional[0];
  const isUrl = !!arg && (/^[a-z+]+:\/\//i.test(arg) || /^git@/.test(arg));
  if (isUrl) {
    const cloneName = path.basename(arg.replace(/\/+$/, "")).replace(/\.git$/, "");
    if (existsSync(cloneName)) fail(`./${cloneName} already exists — cd into it and run fez-adopt there`);
    console.log(`⑂ cloning ${arg}…`);
    execFileSync("git", ["clone", arg, cloneName], { stdio: "inherit", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    process.chdir(cloneName);
  }

  // ── the repo you are (now) standing in
  let top: string;
  try {
    top = git(["rev-parse", "--show-toplevel"]);
  } catch {
    fail("not inside a git repository — cd into the project you want to adopt, or pass its URL");
  }
  const name = (isUrl ? undefined : arg) ?? path.basename(top);
  if (!REPO_NAME.test(name)) fail(`"${name}" is not a repo name — letters, digits, dot, dash, underscore (or pass one: fez-adopt <name>)`);
  const branch = flag("--branch") ?? git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD") fail("detached HEAD — check out a branch first, or pass --branch");

  // ── who you are, where the relay is
  const keyHex = process.env.FEZ_SECRET_KEY?.trim() || getKey("default");
  if (!keyHex) fail("no fez identity — run `fez keygen` first");
  const relays = resolveRelays(flag("--relay"));
  const client = new CapabilityClient({ relay: relays, privateKey: keyHex });
  const myPubkey = client.getPubkey();

  // ── what the relay advertises. NOT derived from the ws URL — the
  //    relay states its public git base in NIP-11, and absence means
  //    there is nothing to adopt into.
  const http = relays[0].replace(/^ws(s?):\/\//i, "http$1://").replace(/\/+$/, "");
  let info: Record<string, unknown> | undefined;
  try {
    const res = await fetch(http, { headers: { Accept: "application/nostr+json" } });
    if (res.ok) info = (await res.json()) as Record<string, unknown>;
  } catch { /* reported below */ }
  if (!info) fail(`could not reach ${relays[0]} for its NIP-11 document`);
  const base = cloneBase(info);
  if (!base) {
    fail(
      `${relays[0]} does not advertise a git server.\n` +
        "  Install @fez/git on the relay and start it with --extensions --origin <public-url>."
    );
  }
  const owner = typeof info.pubkey === "string" ? info.pubkey : undefined;
  if (!owner) fail(`${relays[0]} is unclaimed (no owner in NIP-11) — nobody can open a channel there`);
  if (owner !== myPubkey) {
    fail(
      "adopting needs the workspace owner: the channel is owner-signed and the first push\n" +
        "  lays down a protected `main`. Ask the owner to run this, or to /repo new it for you."
    );
  }

  // ── channel (idempotent: re-adopting an already-adopted repo is a no-op)
  const relay = new RelayConnection({ urls: relays, authSigner: client.authSigner });
  await relay.connect();
  try {
    // Only the slice makeChannels actually reads. Structural typing is
    // the contract here, same as every extension mirror: this package
    // must not grow a dependency on the full client to publish one
    // channel event.
    const nostr = {
      pubkey: myPubkey,
      publish: async (tmpl: { kind: number; tags: string[][]; content: string }) => {
        const event = client.signEvent(tmpl);
        await relay.publish(event);
        return event;
      },
      query: (filters: Record<string, unknown>[]) => relay.query(filters as never),
    } as unknown as NostrAccess;

    // Where this repo CAME from, recorded as a fact on the channel.
    // Nothing acts on it today — the GitHub bridge stays awareness-only
    // — but the channel showing "from github.com/…" and any future
    // mirror both need the fact, and adoption is the moment it is known.
    const upstream = (() => {
      try {
        return git(["remote", "get-url", "origin"]);
      } catch {
        return undefined;
      }
    })();

    const url = cloneUrl(base, name);
    const channels = makeChannels(nostr, owner);
    const channelId = await channels.ensure({
      name: name.toLowerCase(),
      source: "fez-git",
      meta: { repo: name, clone: url, protect: "main", ...(upstream ? { upstream } : {}) },
    });
    if (!channelId) fail("could not open the channel (relay refused the event)");
    console.log(`⑂ #${name.toLowerCase()} is open on ${relays[0]}`);

    // Front-page doc, once: same guard as /repo new — re-adopting must
    // never clobber a doc the room has been editing.
    const hasDoc = ((await nostr.query([{ kinds: [40100], "#h": [channelId], limit: 1 }])) as unknown[]).length > 0;
    if (!hasDoc) await nostr.publish({ kind: 40100, tags: [["h", channelId]], content: repoDoc(name, url, upstream) });

    // ── remote: `fez`, added or corrected. origin is not touched.
    const existing = (() => {
      try {
        return git(["remote", "get-url", "fez"]);
      } catch {
        return undefined;
      }
    })();
    if (existing === undefined) {
      git(["remote", "add", "fez", url]);
      console.log(`⑂ remote added: fez → ${url}`);
    } else if (existing !== url) {
      git(["remote", "set-url", "fez", url]);
      console.log(`⑂ remote updated: fez → ${url} (was ${existing})`);
    }

    // ── push, self-contained: the bundled helper and your key, scoped
    //    to this one invocation. Nothing global is configured or needed.
    console.log(`⑂ pushing ${branch}…`);
    execFileSync(
      "git",
      ["-c", `credential.helper=${helperPath()}`, "-c", "credential.useHttpPath=true", "push", "fez", branch],
      { stdio: "inherit", env: { ...process.env, FEZ_SECRET_KEY: keyHex, GIT_TERMINAL_PROMPT: "0" } }
    );

    console.log(
      `\n⑂ adopted. Agents can work on it now — put this in a persona:\n\n` +
        `  repo: ${name}\n\n` +
        `Each agent gets its own clone on its own branch; \`main\` is protected\n` +
        `(owners and admins, fast-forward only) and every branch becomes a thread in #${name.toLowerCase()}.` +
        (upstream
          ? `\n\nfez is the working copy; ${upstream} is a window.\n` +
            `  publish there when ready:   git push origin main\n` +
            `  bring upstream changes in:  git pull origin main && git push fez main`
          : "")
    );
  } finally {
    relay.disconnect();
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
