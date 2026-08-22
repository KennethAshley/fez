import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip98Authenticator } from "../../fez-git/src/auth.js";
import { gitServer, rosterAccess, type StoredEvent } from "../../fez-git/src/serve.js";
import { parseProtect, qualifyRef, resolveProtect, roleOf } from "../../fez-git/src/protect.js";
import { startRelay, type RelayHandle } from "../../fez-relay/src/relay.js";

/**
 * A fleet on one repo — the thing branch protection exists for.
 *
 * fez already gave every agent its own clone and its own branch, so this
 * is not testing that pushes to different refs don't collide (git does
 * that). It is testing the case the convention could not cover: an agent
 * that pushes to `main` anyway. Before this, that was accepted and
 * overwrote the line every other agent had branched from.
 *
 * The concurrency test runs the two agents through the REAL git binary
 * at the same time, because "they don't overwrite each other" is a claim
 * about two processes and cannot be checked by running one twice.
 */

const PORT = 7841;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fez-git/dist/credential.js");

const owner = generateSecretKey();
const ownerPk = getPublicKey(owner);
const alice = generateSecretKey(); // an agent: on the roster, role `bot`
const alicePk = getPublicKey(alice);
const bob = generateSecretKey(); // another agent
const bobPk = getPublicKey(bob);

const hex = (key: Uint8Array) => [...key].map((b) => b.toString(16).padStart(2, "0")).join("");
const run = promisify(execFile);

let relay: RelayHandle;
let root: string;

function gitAs(key: Uint8Array) {
  return (args: string[], cwd: string): Promise<string> =>
    run("git", ["-c", `credential.helper=${HELPER}`, "-c", "credential.useHttpPath=true", ...args], {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", FEZ_SECRET_KEY: hex(key) },
    }).then(({ stdout }) => stdout);
}

const asOwner = gitAs(owner);
const asAlice = gitAs(alice);
const asBob = gitAs(bob);

const remote = `${ORIGIN}/git/fleet.git`;

/** A checkout with one commit on `branch`, ready to push. */
async function checkout(git: ReturnType<typeof gitAs>, name: string, branch: string, file: string) {
  const dir = path.join(root, name);
  await git(["clone", "--quiet", remote, dir], root);
  await git(["config", "user.email", `${name}@fez`], dir);
  await git(["config", "user.name", name], dir);
  await git(["checkout", "--quiet", "-b", branch], dir);
  writeFileSync(path.join(dir, file), `${name} was here\n`);
  await git(["add", "."], dir);
  await git(["commit", "--quiet", "-m", `${name}: work`], dir);
  return dir;
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "fez-protect-"));
  relay = startRelay({
    port: PORT,
    httpHandlers: [
      gitServer({
        root: path.join(root, "repos"),
        authenticate: nip98Authenticator({ origins: [ORIGIN] }),
        access: {
          canRead: (_repo, who) => !!who.pubkey,
          canWrite: (_repo, who) => who.pubkey === ownerPk || who.pubkey === alicePk || who.pubkey === bobPk,
          // Stated directly, as git-serve.test.ts states membership: this
          // file is about what the HOOK does with a policy. Where the
          // policy comes from is the rosterAccess unit test below.
          refPolicy: (_repo, who) => ({
            protect: [qualifyRef("main")],
            privileged: who.pubkey === ownerPk,
          }),
        },
      }),
    ],
  });
});

afterAll(() => {
  relay?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("a repo a fleet shares", () => {
  it("lets the owner lay down main", { timeout: 30_000 }, async () => {
    const work = path.join(root, "seed");
    mkdirSync(work, { recursive: true });
    await asOwner(["init", "--quiet", "--initial-branch=main"], work);
    await asOwner(["config", "user.email", "owner@fez"], work);
    await asOwner(["config", "user.name", "owner"], work);
    writeFileSync(path.join(work, "README.md"), "the line everyone branches from\n");
    await asOwner(["add", "."], work);
    await asOwner(["commit", "--quiet", "-m", "seed"], work);
    await asOwner(["remote", "add", "origin", remote], work);
    await asOwner(["push", "--quiet", "origin", "main"], work);
  });

  it("takes two agents' branches at the same time", { timeout: 60_000 }, async () => {
    const aliceDir = await checkout(asAlice, "alice", "alice/work", "alice.txt");
    const bobDir = await checkout(asBob, "bob", "bob/work", "bob.txt");

    // Concurrently, on purpose. Different refs, so both must land.
    await Promise.all([
      asAlice(["push", "--quiet", "origin", "alice/work"], aliceDir),
      asBob(["push", "--quiet", "origin", "bob/work"], bobDir),
    ]);

    const refs = await asOwner(["ls-remote", "--heads", remote], root);
    expect(refs).toContain("refs/heads/alice/work");
    expect(refs).toContain("refs/heads/bob/work");
    expect(refs).toContain("refs/heads/main");
  });

  it("refuses an agent that pushes to main", { timeout: 30_000 }, async () => {
    const dir = path.join(root, "alice");
    await asAlice(["checkout", "--quiet", "-B", "main", "origin/main"], dir);
    writeFileSync(path.join(dir, "README.md"), "alice rewrote the shared line\n");
    await asAlice(["commit", "--quiet", "-am", "alice: on main"], dir);
    await expect(asAlice(["push", "origin", "main"], dir)).rejects.toThrow(/protected/);
  });

  it("leaves main where the owner put it", { timeout: 30_000 }, async () => {
    const dir = path.join(root, "verify");
    await asOwner(["clone", "--quiet", "--branch", "main", remote, dir], root);
    expect(await asOwner(["show", "-s", "--format=%s", "HEAD"], dir)).toContain("seed");
  });

  it("refuses to let an agent delete main", { timeout: 30_000 }, async () => {
    const dir = path.join(root, "alice");
    await expect(asAlice(["push", "origin", ":main"], dir)).rejects.toThrow(/protected/);
  });

  it("refuses a force-push to main even from the owner", { timeout: 30_000 }, async () => {
    // Privilege is permission to MOVE the ref, not to rewrite history
    // under everyone. This is the half that protects the fleet from its
    // operator having a bad afternoon.
    const dir = path.join(root, "seed");
    await asOwner(["commit", "--quiet", "--amend", "-m", "seed, rewritten"], dir);
    await expect(asOwner(["push", "--force", "origin", "main"], dir)).rejects.toThrow(/fast-forward/);
  });

  it("takes a fast-forward to main from the owner", { timeout: 30_000 }, async () => {
    const dir = path.join(root, "merge");
    await asOwner(["clone", "--quiet", "--branch", "main", remote, dir], root);
    await asOwner(["config", "user.email", "owner@fez"], dir);
    await asOwner(["config", "user.name", "owner"], dir);
    await asOwner(["fetch", "--quiet", "origin", "alice/work"], dir);
    await asOwner(["merge", "--quiet", "--ff-only", "FETCH_HEAD"], dir).catch(async () => {
      // alice branched from main, so this is a fast-forward; if git
      // disagrees the test should say so rather than paper over it.
      throw new Error("alice/work was not a fast-forward of main");
    });
    await asOwner(["push", "--quiet", "origin", "main"], dir);
    expect(await asOwner(["show", "-s", "--format=%s", "HEAD"], dir)).toContain("alice: work");
  });
});

/**
 * Where the policy comes from: the repo's channel and the roster's roles.
 *
 * Driven by a fake `query` rather than a live relay — this is a pure
 * function of the events, and the events are the part worth pinning.
 */
describe("rosterAccess resolves policy from what the owner signed", () => {
  const channel = (meta: Record<string, string>): StoredEvent => ({
    id: "c",
    kind: 47101,
    pubkey: ownerPk,
    created_at: 100,
    content: JSON.stringify({ name: "fleet", source: "fez-git", meta }),
    tags: [["d", "chan"]],
  });
  const roster = (...people: string[][]): StoredEvent => ({
    id: "r",
    kind: 47102,
    pubkey: ownerPk,
    created_at: 100,
    content: "",
    tags: [["d", "roster"], ...people.map((p) => ["p", ...p])],
  });

  const accessWith = (events: StoredEvent[]) =>
    rosterAccess((filter) => {
      const kinds = (filter.kinds as number[]) ?? [];
      return events.filter((e) => kinds.includes(e.kind));
    }, ownerPk);

  it("reads the protected refs off the repo's channel", async () => {
    const access = accessWith([channel({ repo: "fleet", protect: "main, release/*" }), roster()]);
    expect(await access.refPolicy?.("fleet", { pubkey: ownerPk })).toEqual({
      protect: ["refs/heads/main", "refs/heads/release/*"],
      privileged: true,
    });
  });

  it("protects main when the channel never said", async () => {
    // The one rule fez asserts rather than reads. A repo made before this
    // existed must not look configured while being wide open.
    const access = accessWith([channel({ repo: "fleet" }), roster()]);
    expect((await access.refPolicy?.("fleet", { pubkey: ownerPk }))?.protect).toEqual(["refs/heads/main"]);
  });

  it("honours `none` as a real answer", async () => {
    const access = accessWith([channel({ repo: "fleet", protect: "none" }), roster()]);
    expect((await access.refPolicy?.("fleet", { pubkey: ownerPk }))?.protect).toEqual([]);
  });

  it("gives admins the privilege and bots none", async () => {
    const access = accessWith([
      channel({ repo: "fleet", protect: "main" }),
      roster([alicePk, "admin"], [bobPk, "bot"]),
    ]);
    expect((await access.refPolicy?.("fleet", { pubkey: alicePk }))?.privileged).toBe(true);
    expect((await access.refPolicy?.("fleet", { pubkey: bobPk }))?.privileged).toBe(false);
  });

  it("does not confuse another repo's channel for this one", async () => {
    const access = accessWith([
      channel({ repo: "other", protect: "none" }),
      roster(),
    ]);
    // "other" says none; "fleet" has no channel, so it falls to the default.
    expect((await access.refPolicy?.("fleet", { pubkey: ownerPk }))?.protect).toEqual(["refs/heads/main"]);
  });
});

describe("ref patterns", () => {
  it("qualifies a branch name and leaves a full ref alone", () => {
    expect(qualifyRef("main")).toBe("refs/heads/main");
    expect(qualifyRef("refs/tags/*")).toBe("refs/tags/*");
  });

  it("tells `never set` from `set to nothing`", () => {
    expect(parseProtect(undefined)).toBeUndefined();
    expect(parseProtect("none")).toEqual([]);
    expect(resolveProtect(undefined)).toEqual(["refs/heads/main"]);
  });

  it("defaults a roster entry with no role to member", () => {
    expect(roleOf([["p", alicePk]], alicePk)).toBe("member");
    expect(roleOf([["p", alicePk, "admin"]], alicePk)).toBe("admin");
    expect(roleOf([["p", alicePk, "admin"]], bobPk)).toBeUndefined();
  });
});

/**
 * Turning it off has to actually turn it off.
 *
 * The hook refuses a push whose policy env is missing, which is correct
 * while the relay is installing it and ruinous the moment it stops: an
 * operator who swaps in their own GitAccess would find every push to
 * every repo rejected by a rule they never wrote and cannot find. Same
 * root, same repo, two relays — the second one has no refPolicy.
 */
describe("an operator who brings their own GitAccess", () => {
  const PORT_B = 7842;
  const ORIGIN_B = `http://127.0.0.1:${PORT_B}`;
  let dir: string;
  let repos: string;

  const serverFor = (withPolicy: boolean) =>
    gitServer({
      root: repos,
      authenticate: nip98Authenticator({ origins: [ORIGIN_B] }),
      access: {
        canRead: () => true,
        canWrite: (_repo, who) => !!who.pubkey,
        ...(withPolicy
          ? { refPolicy: () => ({ protect: [qualifyRef("main")], privileged: false }) }
          : {}),
      },
    });

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "fez-unprotect-"));
    repos = path.join(dir, "repos");
    const work = path.join(dir, "work");
    mkdirSync(work, { recursive: true });
    await asOwner(["init", "--quiet", "--initial-branch=main"], work);
    await asOwner(["config", "user.email", "owner@fez"], work);
    await asOwner(["config", "user.name", "owner"], work);
    writeFileSync(path.join(work, "a.txt"), "one\n");
    await asOwner(["add", "."], work);
    await asOwner(["commit", "--quiet", "-m", "one"], work);
    await asOwner(["remote", "add", "origin", `${ORIGIN_B}/git/swap.git`], work);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("is refused while the policy is in force", { timeout: 30_000 }, async () => {
    const relayB = startRelay({ port: PORT_B, httpHandlers: [serverFor(true)] });
    try {
      // The repo does not exist yet, so this push both creates it and
      // trips the rule — nobody is privileged under this policy.
      await expect(asOwner(["push", "origin", "main"], path.join(dir, "work"))).rejects.toThrow(/protected/);
    } finally {
      relayB.close();
    }
  });

  it("pushes once the policy is gone, rather than failing closed forever", { timeout: 30_000 }, async () => {
    const relayB = startRelay({ port: PORT_B, httpHandlers: [serverFor(false)] });
    try {
      await asOwner(["push", "--quiet", "origin", "main"], path.join(dir, "work"));
    } finally {
      relayB.close();
    }
  });
});
