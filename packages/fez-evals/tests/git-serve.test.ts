import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip98Authenticator } from "../../fez-git/src/auth.js";
import { gitServer } from "../../fez-git/src/serve.js";
import { startRelay, type RelayHandle } from "../../fez-relay/src/relay.js";

/**
 * The whole point, end to end: a key clones and pushes, a key that is
 * not allowed does neither, and the commit still says who wrote it.
 *
 * This drives the REAL git binary through the REAL credential helper.
 * Unit tests prove the URL reduction and the signature checks; only this
 * proves git itself accepts what fez serves — the protocol is the part
 * nobody can verify by reading.
 *
 * Two things this had to learn the hard way:
 *
 * 1. git is driven ASYNCHRONOUSLY. The relay runs in this process, so
 *    execFileSync would block the event loop and the server could never
 *    answer the request git was making. A bare node server reproduces
 *    that deadlock in four lines.
 * 2. git's FIRST request is always unauthenticated. It expects a 401 and
 *    only then asks the credential helper — so a "no Authorization
 *    header" denial in the log is the handshake working, not a failure.
 */

const PORT = 7892;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fez-git/dist/credential.js");

const member = generateSecretKey();
const memberPk = getPublicKey(member);
const stranger = generateSecretKey();
const hex = (key: Uint8Array) => [...key].map((b) => b.toString(16).padStart(2, "0")).join("");

const run = promisify(execFile);
let relay: RelayHandle;
let root: string;
let gitRoot: string;

/** git, wired to the fez credential helper, signing as `key`. */
function gitAs(key: Uint8Array) {
  return (args: string[], cwd: string): Promise<string> =>
    run("git", ["-c", `credential.helper=${HELPER}`, "-c", "credential.useHttpPath=true", ...args], {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", FEZ_SECRET_KEY: hex(key) },
    }).then(({ stdout }) => stdout);
}

/** No helper at all — what a stranger with a git client has. */
const gitBare = (args: string[], cwd: string): Promise<string> =>
  run("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).then(
    ({ stdout }) => stdout
  );

const git = gitAs(member);

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "fez-git-"));
  gitRoot = path.join(root, "repos");
  relay = startRelay({
    port: PORT,
    // The relay takes HANDLERS and does not know what git is. In
    // production this list is filled by installed relay extensions.
    httpHandlers: [
      gitServer({
        root: gitRoot,
        authenticate: nip98Authenticator({ origins: [ORIGIN] }),
        // rosterAccess is fez's real rule; this test is about the
        // transport, so membership is stated directly.
        access: {
          canRead: (_repo, who) => who.pubkey === memberPk,
          canWrite: (_repo, who) => who.pubkey === memberPk,
        },
      }),
    ],
  });
});

afterAll(() => {
  relay?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("a relay that serves git", () => {
  const remote = `${ORIGIN}/git/thing.git`;

  it("takes a push from a member, creating the repo", { timeout: 30_000 }, async () => {
    const work = path.join(root, "work");
    mkdirSync(work, { recursive: true });
    await git(["init", "--quiet", "--initial-branch=main"], work);
    await git(["config", "user.email", "agent@fez"], work);
    await git(["config", "user.name", "researcher"], work);
    writeFileSync(path.join(work, "hello.txt"), "written by an agent\n");
    await git(["add", "."], work);
    await git(["commit", "--quiet", "-m", "first"], work);
    await git(["remote", "add", "origin", remote], work);
    await git(["push", "--quiet", "origin", "main"], work);

    // The bare repo exists because somebody who may write pushed to it —
    // there is no separate create API to design or authorize.
    expect(existsSync(path.join(gitRoot, "thing.git"))).toBe(true);
  });

  it("serves that push back to a clone", { timeout: 30_000 }, async () => {
    const clone = path.join(root, "clone");
    await git(["clone", "--quiet", remote, clone], root);
    expect(readFileSync(path.join(clone, "hello.txt"), "utf-8")).toBe("written by an agent\n");
  });

  it("keeps the author, which is the entire point", { timeout: 30_000 }, async () => {
    // The commit says who wrote it, independent of whose credential
    // moved it. That is what makes an agent an author rather than a
    // ghostwriter — and what would let a mirror push to GitHub without
    // collapsing every agent into one bot.
    const clone = path.join(root, "clone");
    expect((await git(["log", "-1", "--format=%an"], clone)).trim()).toBe("researcher");
  });

  it("refuses a stranger's push", { timeout: 30_000 }, async () => {
    const work = path.join(root, "work");
    await expect(gitAs(stranger)(["push", "--quiet", "origin", "main", "--force"], work)).rejects.toThrow();
  });

  it("refuses a client with no key at all", { timeout: 30_000 }, async () => {
    await expect(gitBare(["clone", "--quiet", remote, path.join(root, "nope")], root)).rejects.toThrow();
  });

  it("does not serve a repo nobody pushed", { timeout: 30_000 }, async () => {
    const absent = `${ORIGIN}/git/absent.git`;
    await expect(git(["clone", "--quiet", absent, path.join(root, "absent")], root)).rejects.toThrow();
  });
});
