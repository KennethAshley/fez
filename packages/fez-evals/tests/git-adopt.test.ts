import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip98Authenticator } from "../../fez-git/src/auth.js";
import { gitServer, rosterAccess } from "../../fez-git/src/serve.js";
import { startRelay, type RelayHandle } from "../../fez-relay/src/relay.js";

/**
 * `fez-adopt`, driven as SHIPPED: the bundled bin, a real local repo
 * with history, a live relay serving git.
 *
 * This is the "existing project" flow — the one the whole feature
 * exists for. The other paths start from nothing; this one starts from
 * a directory full of code and must end with: channel open, `fez`
 * remote added, current branch on the relay, and nothing else about
 * the repo touched (origin stays whatever it was).
 */

const PORT = 7844;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADOPT = path.resolve(HERE, "../../fez-git/dist/adopt.js");

const owner = generateSecretKey();
const ownerPk = getPublicKey(owner);
const stranger = generateSecretKey();
const hex = (key: Uint8Array) => [...key].map((b) => b.toString(16).padStart(2, "0")).join("");

const run = promisify(execFile);
let relay: RelayHandle;
let root: string;
let work: string;

const adoptAs = (key: Uint8Array, args: string[] = [], cwd = work) =>
  run("node", [ADOPT, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, FEZ_SECRET_KEY: hex(key), FEZ_RELAY: `ws://127.0.0.1:${PORT}`, GIT_TERMINAL_PROMPT: "0" },
  });

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "fez-adopt-"));
  relay = startRelay({
    port: PORT,
    workspace: { name: "test", owner: ownerPk },
    httpHandlers: [
      gitServer({
        root: path.join(root, "repos"),
        authenticate: nip98Authenticator({ origins: [ORIGIN] }),
        // The REAL rule: the roster decides, the owner is implicit.
        access: rosterAccess(() => [], ownerPk),
      }),
    ],
  });
  relay.advertise("fez_git", { clone_base: `${ORIGIN}/git` });

  // A project with history, the thing being adopted.
  work = path.join(root, "myproject");
  mkdirSync(work, { recursive: true });
  const git = (args: string[]) => run("git", args, { cwd: work, encoding: "utf-8" });
  await git(["init", "--quiet", "--initial-branch=main"]);
  await git(["config", "user.email", "o@fez"]);
  await git(["config", "user.name", "owner"]);
  await git(["remote", "add", "origin", "https://github.com/example/myproject.git"]);
  writeFileSync(path.join(work, "README.md"), "an existing project\n");
  await git(["add", "."]);
  await git(["commit", "--quiet", "-m", "history"]);
}, 60_000);

afterAll(() => {
  relay?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("adopting an existing local repo", () => {
  it("opens the channel, adds the remote, pushes the branch", { timeout: 30_000 }, async () => {
    const { stdout } = await adoptAs(owner);
    expect(stdout).toContain("#myproject is open");
    expect(stdout).toContain("remote added: fez");
    expect(stdout).toContain("adopted");

    // The channel is real and owner-signed, with the policy written in.
    const channels = relay.query({ kinds: [47101] });
    const parsed = channels.map((e) => JSON.parse(e.content) as { name: string; source?: string; meta?: Record<string, string> });
    const chan = parsed.find((c) => c.name === "myproject");
    expect(chan?.source).toBe("fez-git");
    expect(chan?.meta?.protect).toBe("main");
    expect(chan?.meta?.clone).toBe(`${ORIGIN}/git/myproject.git`);

    // The history is on the relay.
    const { stdout: refs } = await run("git", ["ls-remote", "--heads", `${ORIGIN}/git/myproject.git`], {
      cwd: work,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: path.resolve(HERE, "../../fez-git/dist/credential.js"),
        GIT_CONFIG_KEY_1: "credential.useHttpPath",
        GIT_CONFIG_VALUE_1: "true",
        FEZ_SECRET_KEY: hex(owner),
      },
    });
    expect(refs).toContain("refs/heads/main");

    // Adoption is not migration: origin untouched.
    const { stdout: origin } = await run("git", ["remote", "get-url", "origin"], { cwd: work, encoding: "utf-8" });
    expect(origin.trim()).toBe("https://github.com/example/myproject.git");
  });

  it("is idempotent — running it again is a fast no-op, not a duplicate", { timeout: 30_000 }, async () => {
    await adoptAs(owner);
    const names = relay.query({ kinds: [47101] }).map((e) => (JSON.parse(e.content) as { name: string }).name);
    // ensure() matched by name and meta was unchanged, so still ONE channel event for it.
    expect(names.filter((n) => n === "myproject")).toHaveLength(1);
  });

  it("refuses a non-owner, and says who to ask", { timeout: 30_000 }, async () => {
    await expect(adoptAs(stranger)).rejects.toThrow(/workspace owner/);
  });

  it("adopts straight from a URL — clone, channel, remote, push, one command", { timeout: 30_000 }, async () => {
    // A local bare repo stands in for GitHub: the URL form's contract is
    // "go get it, then it is the directory case", so any git URL proves it.
    const upstreamDir = path.join(root, "upstream", "gitfolio.git");
    mkdirSync(path.dirname(upstreamDir), { recursive: true });
    await run("git", ["init", "--bare", "--quiet", upstreamDir], { encoding: "utf-8" });
    const seed = path.join(root, "seed");
    mkdirSync(seed, { recursive: true });
    const git = (args: string[], cwd = seed) => run("git", args, { cwd, encoding: "utf-8" });
    await git(["init", "--quiet", "--initial-branch=main"]);
    await git(["config", "user.email", "o@fez"]);
    await git(["config", "user.name", "owner"]);
    writeFileSync(path.join(seed, "app.js"), "hello\n");
    await git(["add", "."]);
    await git(["commit", "--quiet", "-m", "upstream history"]);
    await git(["push", "--quiet", upstreamDir, "main"]);

    const where = path.join(root, "adopt-from-url");
    mkdirSync(where, { recursive: true });
    const { stdout } = await adoptAs(owner, [`file://${upstreamDir}`], where);
    expect(stdout).toContain("cloning");
    expect(stdout).toContain("#gitfolio is open");
    expect(stdout).toContain("adopted");
    // The sync story is stated, because the URL form is exactly the
    // "work on a GitHub repo" flow and the user must know who publishes.
    expect(stdout).toContain("git push origin main");

    // Where it came from is recorded on the channel.
    const chan = relay
      .query({ kinds: [47101] })
      .map((e) => JSON.parse(e.content) as { name: string; meta?: Record<string, string> })
      .find((c) => c.name === "gitfolio");
    expect(chan?.meta?.upstream).toBe(`file://${upstreamDir}`);

    // And the code is on the relay.
    const { stdout: refs } = await run("git", ["ls-remote", "--heads", `${ORIGIN}/git/gitfolio.git`], {
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: path.resolve(HERE, "../../fez-git/dist/credential.js"),
        GIT_CONFIG_KEY_1: "credential.useHttpPath",
        GIT_CONFIG_VALUE_1: "true",
        FEZ_SECRET_KEY: hex(owner),
      },
    });
    expect(refs).toContain("refs/heads/main");
  });

  it("refuses outside a git repository", { timeout: 30_000 }, async () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), "fez-nogit-"));
    try {
      await expect(adoptAs(owner, [], elsewhere)).rejects.toThrow(/not inside a git repository/);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
