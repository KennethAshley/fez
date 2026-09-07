import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip98Authenticator } from "../../fez-git/src/auth.js";
import { gitServer } from "../../fez-git/src/serve.js";
import { prepareWorkspace, branchFor, remoteFor } from "../../fez-git/src/workspace.js";
import { startRelay, type RelayHandle } from "../../fez-relay/src/relay.js";

/**
 * A fleet of agents on one repo, each in its own disposable checkout.
 *
 * This is the keystone the whole GUI-fleet story rests on, so it runs
 * against a REAL relay and the REAL git binary — the interesting
 * failures here (a filter the server ignores, two agents contending for
 * a ref, a sparse cone that silently checks out everything) are all
 * invisible to a mocked test.
 */

// 7893/7894 belong to git-advertise (it starts a second relay on PORT+1).
const PORT = 7896;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fez-git/dist/credential.js");
const CLONE_BASE = `${ORIGIN}/git`;

const alice = generateSecretKey();
const bob = generateSecretKey();
const hex = (k: Uint8Array) => [...k].map((b) => b.toString(16).padStart(2, "0")).join("");
const allowed = new Set([getPublicKey(alice), getPublicKey(bob)]);

const run = promisify(execFile);
let relay: RelayHandle;
let root: string;
let gitRoot: string;

const spec = (key: Uint8Array, dir: string, branch: string, scope?: string[]) => ({
  repo: "fleet",
  cloneBase: CLONE_BASE,
  branch,
  dir,
  scope,
  secretKeyHex: hex(key),
  helper: HELPER,
});

/** Seed the repo so there is something to scope into. */
async function seed() {
  const w = path.join(root, "seed");
  const git = (args: string[]) =>
    run("git", ["-c", `credential.helper=${HELPER}`, "-c", "credential.useHttpPath=true", ...args], {
      cwd: w,
      env: { ...process.env, FEZ_SECRET_KEY: hex(alice), GIT_TERMINAL_PROMPT: "0" },
    });
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path.join(w, "api"), { recursive: true });
  mkdirSync(path.join(w, "ui"), { recursive: true });
  await git(["init", "--quiet", "--initial-branch=main"]);
  await git(["config", "user.email", "a@fez"]);
  await git(["config", "user.name", "alice"]);
  writeFileSync(path.join(w, "api", "server.ts"), "export const port = 1;\n");
  writeFileSync(path.join(w, "ui", "app.tsx"), "export const App = () => null;\n");
  writeFileSync(path.join(w, "README.md"), "# fleet\n");
  await git(["add", "."]);
  await git(["commit", "--quiet", "-m", "seed"]);
  await git(["remote", "add", "origin", remoteFor(CLONE_BASE, "fleet")]);
  await git(["push", "--quiet", "origin", "main"]);
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "fez-ws-"));
  gitRoot = path.join(root, "repos");
  relay = startRelay({
    port: PORT,
    log: () => {},
    httpHandlers: [
      gitServer({
        root: gitRoot,
        authenticate: nip98Authenticator({ origins: [ORIGIN] }),
        // pubkey is optional on the who — an unauthenticated request has
        // none, and "no pubkey" must read as denied rather than as a
        // lookup of undefined.
        access: {
          canRead: (_r, w) => !!w.pubkey && allowed.has(w.pubkey),
          canWrite: (_r, w) => !!w.pubkey && allowed.has(w.pubkey),
        },
      }),
    ],
  });
  await seed();
}, 60_000);

afterAll(() => {
  relay?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("branch naming", () => {
  it("namespaces by agent so two agents never contend for a ref", () => {
    expect(branchFor("alice", "Fix the login bug")).toBe("alice/fix-the-login-bug");
    expect(branchFor("bob", "Fix the login bug")).toBe("bob/fix-the-login-bug");
  });

  it("survives prose a human typed", () => {
    expect(branchFor("agent-9", "Refactor: the AUTH layer!! (urgent)")).toMatch(/^agent-9\/[a-z0-9-]+$/);
  });
});

describe("a repo the relay created", () => {
  it("allows partial clone, so a fleet's checkouts stay small", { timeout: 30_000 }, async () => {
    // Off by default in git, and the failure is SILENT: the client warns
    // "filtering not recognized by server, ignoring" and downloads
    // everything anyway. Nobody notices until the disk fills, so the
    // config is asserted rather than assumed.
    const { stdout } = await run("git", ["-C", path.join(gitRoot, "fleet.git"), "config", "uploadpack.allowFilter"]);
    expect(stdout.trim()).toBe("true");
  });

  it("clones without git falling back to a full transfer", { timeout: 60_000 }, async () => {
    const { stderr } = await run(
      "git",
      ["-c", `credential.helper=${HELPER}`, "-c", "credential.useHttpPath=true",
       "clone", "--filter=blob:none", "--quiet", remoteFor(CLONE_BASE, "fleet"), path.join(root, "filtercheck")],
      { env: { ...process.env, FEZ_SECRET_KEY: hex(alice), GIT_TERMINAL_PROMPT: "0" } }
    );
    expect(stderr).not.toContain("filtering not recognized");
  });
});

describe("a fleet sharing one repo", () => {
  it("gives an agent a checkout on its own branch", { timeout: 60_000 }, async () => {
    const ws = await prepareWorkspace(spec(alice, path.join(root, "alice"), "alice/task"));
    expect(ws.empty).toBe(false);
    expect(existsSync(path.join(ws.dir, "README.md"))).toBe(true);
    const { stdout } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ws.dir });
    expect(stdout.trim()).toBe("alice/task");
  });

  it("scopes the working tree to the agent's assignment", { timeout: 60_000 }, async () => {
    const ws = await prepareWorkspace(spec(bob, path.join(root, "bob"), "bob/task", ["api"]));
    // The cone IS the assignment: ui/ is not in bob's tree, so bob
    // cannot edit it by accident.
    expect(existsSync(path.join(ws.dir, "api", "server.ts"))).toBe(true);
    expect(existsSync(path.join(ws.dir, "ui", "app.tsx"))).toBe(false);
  });

  it("lets two agents push concurrently without colliding", { timeout: 90_000 }, async () => {
    const push = async (key: Uint8Array, dir: string, branch: string, file: string) => {
      const ws = await prepareWorkspace(spec(key, dir, branch));
      const git = (args: string[]) =>
        run("git", ["-c", `credential.helper=${HELPER}`, "-c", "credential.useHttpPath=true", ...args], {
          cwd: ws.dir,
          env: { ...process.env, FEZ_SECRET_KEY: hex(key), GIT_TERMINAL_PROMPT: "0" },
        });
      await git(["config", "user.email", `${branch}@fez`]);
      await git(["config", "user.name", branch.split("/")[0]]);
      writeFileSync(path.join(ws.dir, file), "work\n");
      await git(["add", "."]);
      await git(["commit", "--quiet", "-m", `work by ${branch}`]);
      await git(["push", "--quiet", "origin", branch]);
      return ws;
    };
    // Concurrently, on purpose — this is the fleet case.
    await Promise.all([
      push(alice, path.join(root, "a2"), "alice/feature", "a.txt"),
      push(bob, path.join(root, "b2"), "bob/feature", "b.txt"),
    ]);
    const { stdout } = await run("git", ["branch", "--list"], { cwd: path.join(gitRoot, "fleet.git") });
    expect(stdout).toContain("alice/feature");
    expect(stdout).toContain("bob/feature");
  });

  it("resumes a branch an agent already pushed, rather than orphaning it", { timeout: 60_000 }, async () => {
    // An agent that died mid-task comes back to its own work.
    const ws = await prepareWorkspace(spec(alice, path.join(root, "a3"), "alice/feature"));
    expect(existsSync(path.join(ws.dir, "a.txt"))).toBe(true);
  });

  it("disposes the checkout — the body is not precious", { timeout: 60_000 }, async () => {
    const dir = path.join(root, "throwaway");
    const ws = await prepareWorkspace(spec(alice, dir, "alice/tmp"));
    expect(existsSync(dir)).toBe(true);
    ws.dispose();
    expect(existsSync(dir)).toBe(false);
  });

  it("rebuilds over a wrecked checkout instead of trusting it", { timeout: 60_000 }, async () => {
    const dir = path.join(root, "wrecked");
    await prepareWorkspace(spec(alice, dir, "alice/tmp2"));
    // Simulate a crashed agent: stale lock, junk in the tree.
    writeFileSync(path.join(dir, ".git", "index.lock"), "");
    writeFileSync(path.join(dir, "junk.txt"), "should not survive");
    const ws = await prepareWorkspace(spec(alice, dir, "alice/tmp2"));
    expect(existsSync(path.join(ws.dir, "junk.txt"))).toBe(false);
    expect(readdirSync(ws.dir)).toContain("README.md");
  });
});

describe("an agent cut onto a line", () => {
  it("starts from the line's tip, not the default branch", { timeout: 60_000 }, async () => {
    // Build a line on the relay: main has one commit, feat-auth has a
    // second. An agent based on feat-auth must see BOTH.
    const seed = path.join(root, "line-seed");
    mkdirSync(seed, { recursive: true });
    const git = (args: string[], cwd = seed) =>
      run("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", FEZ_SECRET_KEY: hex(alice) } });
    await git(["init", "--quiet", "--initial-branch=main"]);
    await git(["config", "user.email", "a@fez"]);
    await git(["config", "user.name", "alice"]);
    writeFileSync(path.join(seed, "base.txt"), "trunk\n");
    await git(["add", "."]);
    await git(["commit", "--quiet", "-m", "trunk"]);
    await git(["remote", "add", "origin", `${ORIGIN}/git/lined.git`]);
    await git(["-c", `credential.helper=${HELPER}`, "-c", "credential.useHttpPath=true", "push", "--quiet", "origin", "main"]);
    await git(["checkout", "--quiet", "-b", "feat-auth"]);
    writeFileSync(path.join(seed, "auth.txt"), "line work\n");
    await git(["add", "."]);
    await git(["commit", "--quiet", "-m", "line"]);
    await git(["-c", `credential.helper=${HELPER}`, "-c", "credential.useHttpPath=true", "push", "--quiet", "origin", "feat-auth"]);

    const ws = await prepareWorkspace({
      ...spec(alice, path.join(root, "lined-agent"), "reviewer/feat-auth"),
      repo: "lined",
      base: "feat-auth",
    });
    expect(ws.branch).toBe("reviewer/feat-auth");
    expect(existsSync(path.join(ws.dir, "auth.txt"))).toBe(true); // the line's commit is present
  });

  it("joins an unborn line that already has LANES — tail-match trap", { timeout: 60_000 }, async () => {
    // The killer case: researcher pushed `researcher/feat-empty`, the
    // line `feat-empty` itself has no ref, and NOW reviewer joins.
    // `ls-remote origin feat-empty` tail-matches the sibling lane, so a
    // sloppy existence check fetches a ghost and the spawn dies.
    const first = await prepareWorkspace({
      ...spec(alice, path.join(root, "lane-one"), "researcher/feat-empty"),
      repo: "lined",
      base: "feat-empty",
    });
    const git = (args: string[]) =>
      run("git", args, { cwd: first.dir, encoding: "utf-8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", FEZ_SECRET_KEY: hex(alice) } });
    await git(["config", "user.email", "a@fez"]);
    await git(["config", "user.name", "alice"]);
    writeFileSync(path.join(first.dir, "lane.txt"), "first lane\n");
    await git(["add", "."]);
    await git(["commit", "--quiet", "-m", "lane work"]);
    await git(["push", "--quiet", "origin", "researcher/feat-empty"]);

    // Second agent joins the same (still unborn) line: must fall back
    // to trunk, and must NOT see the sibling's work.
    const second = await prepareWorkspace({
      ...spec(alice, path.join(root, "lane-two"), "reviewer/feat-empty"),
      repo: "lined",
      base: "feat-empty",
    });
    expect(second.branch).toBe("reviewer/feat-empty");
    expect(existsSync(path.join(second.dir, "base.txt"))).toBe(true);
    expect(existsSync(path.join(second.dir, "lane.txt"))).toBe(false);
  });

  it("falls back to the default branch when the line has no commits yet", { timeout: 60_000 }, async () => {
    // /repo branch DECLARES a line; the ref appears on first push. An
    // agent pointed at a declared-but-empty line starts from trunk.
    const ws = await prepareWorkspace({
      ...spec(alice, path.join(root, "lined-agent2"), "researcher/feat-empty"),
      repo: "lined",
      base: "feat-empty",
    });
    expect(ws.branch).toBe("researcher/feat-empty");
    expect(existsSync(path.join(ws.dir, "base.txt"))).toBe(true);
    expect(existsSync(path.join(ws.dir, "auth.txt"))).toBe(false); // NOT the other line's work
  });
});

describe("a repo nobody has pushed to yet", () => {
  it("is a valid starting state, not an error", { timeout: 60_000 }, async () => {
    // `/repo new` opens the channel; the repo exists only after a push.
    // An agent told to start one must not treat emptiness as failure.
    const empty = path.join(gitRoot, "blank.git");
    await run("git", ["init", "--bare", "--quiet", "--initial-branch=main", empty]);
    const ws = await prepareWorkspace({
      ...spec(alice, path.join(root, "blank"), "alice/first"),
      repo: "blank",
    });
    expect(ws.empty).toBe(true);
    expect(ws.branch).toBe("alice/first");
  });

  it("handles a repo that does not even EXIST on the relay yet", { timeout: 60_000 }, async () => {
    // The channel-first flow: /repo new opened #unborn, no push has
    // created the bare repo, and the agent is the one meant to make the
    // first commit. Clone 404s — the provider inits locally instead,
    // and this agent's first push brings the repo into being.
    const dir = path.join(root, "unborn");
    const ws = await prepareWorkspace({
      ...spec(alice, dir, "alice/first"),
      repo: "unborn",
    });
    expect(ws.empty).toBe(true);

    // The remote is wired: a commit + push must CREATE the repo.
    const git = (args: string[]) =>
      run("git", args, { cwd: dir, encoding: "utf-8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", FEZ_SECRET_KEY: hex(alice) } });
    await git(["config", "user.email", "a@fez"]);
    await git(["config", "user.name", "alice"]);
    writeFileSync(path.join(dir, "README.md"), "born from an agent\n");
    await git(["add", "."]);
    await git(["commit", "--quiet", "-m", "first"]);
    // A PLAIN push — no -c flags. The auth must live in the clone's own
    // config, because the AGENT pushes from its shell, not through our
    // wrapper. Passing flags here would test the wrapper and ship the
    // spelunking-through-Bitwarden failure it papered over.
    await git(["push", "--quiet", "origin", "alice/first"]);
    expect(existsSync(path.join(gitRoot, "unborn.git"))).toBe(true);
  });
});
