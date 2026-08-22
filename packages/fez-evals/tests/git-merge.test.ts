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
import { mergeViaRelay } from "../../fez-git/src/headless.js";
import { buildNip98Header } from "../../../src/nip98.js";
import { startRelay, type RelayHandle } from "../../fez-relay/src/relay.js";
import { finalizeEvent } from "nostr-tools/pure";
import WebSocket from "ws";

/**
 * The merge endpoint, through the whole stack: NIP-98 auth, the roster,
 * and the SAME protection the pre-receive hook applies — because merge
 * semantics live in exactly one place (ops.ts) and this proves the one
 * place behaves. Edges that matter: ff succeeds, non-ff refuses with a
 * reason, an unborn line is created at the branch, an AGENT may move an
 * unprotected line but not main, and the owner may move main.
 */

const PORT = 7846;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.resolve(HERE, "../../fez-git/dist/credential.js");

const owner = generateSecretKey();
const ownerPk = getPublicKey(owner);
const agent = generateSecretKey();
const agentPk = getPublicKey(agent);
const hex = (key: Uint8Array) => [...key].map((b) => b.toString(16).padStart(2, "0")).join("");

const run = promisify(execFile);
let relay: RelayHandle;
let root: string;
let work: string;

const gitAs = (key: Uint8Array) => (args: string[], cwd: string) =>
  run("git", ["-c", `credential.helper=${HELPER}`, "-c", "credential.useHttpPath=true", ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", FEZ_SECRET_KEY: hex(key) },
  });
const asOwner = gitAs(owner);
const asAgent = gitAs(agent);

function publish(secret: Uint8Array, tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    const event = finalizeEvent({ created_at: Math.floor(Date.now() / 1000), ...tmpl }, secret);
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
    socket.on("open", () => socket.send(JSON.stringify(["EVENT", event])));
    socket.on("message", (d: Buffer) => {
      const [type, , okFlag] = JSON.parse(d.toString()) as [string, string, boolean];
      if (type !== "OK") return;
      socket.close();
      if (okFlag) resolve();
      else reject(new Error("refused"));
    });
    socket.on("error", reject);
  });
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "fez-merge-"));
  relay = startRelay({
    port: PORT,
    workspace: { name: "merge-test", owner: ownerPk },
    httpHandlers: [
      gitServer({
        root: path.join(root, "repos"),
        authenticate: nip98Authenticator({ origins: [ORIGIN] }),
        access: rosterAccess((filter) => relay.query(filter), ownerPk),
      }),
    ],
  });
  await publish(owner, { kind: 47102, tags: [["d", "roster"], ["p", agentPk, "bot"]], content: "" });

  // Owner lays down main; agent cuts a branch and adds a commit.
  work = path.join(root, "work");
  mkdirSync(work, { recursive: true });
  await asOwner(["init", "--quiet", "--initial-branch=main"], work);
  await asOwner(["config", "user.email", "o@fez"], work);
  await asOwner(["config", "user.name", "owner"], work);
  writeFileSync(path.join(work, "a.txt"), "one\n");
  await asOwner(["add", "."], work);
  await asOwner(["commit", "--quiet", "-m", "trunk"], work);
  await asOwner(["remote", "add", "origin", `${ORIGIN}/git/m.git`], work);
  await asOwner(["push", "--quiet", "origin", "main"], work);

  const agentDir = path.join(root, "agent");
  await asAgent(["clone", "--quiet", `${ORIGIN}/git/m.git`, agentDir], root);
  await asAgent(["config", "user.email", "a@fez"], agentDir);
  await asAgent(["config", "user.name", "agent"], agentDir);
  await asAgent(["checkout", "--quiet", "-b", "agent/feat"], agentDir);
  writeFileSync(path.join(agentDir, "b.txt"), "two\n");
  await asAgent(["add", "."], agentDir);
  await asAgent(["commit", "--quiet", "-m", "work"], agentDir);
  await asAgent(["push", "--quiet", "origin", "agent/feat"], agentDir);
}, 60_000);

afterAll(() => {
  relay?.close();
  rmSync(root, { recursive: true, force: true });
});

/** The signed knock, exactly as the headless part and the GUI make it. */
import { finalizeEvent as fe } from "nostr-tools/pure";
const mergeAs = (key: Uint8Array) => (branch: string, into?: string) =>
  mergeViaRelay(
    {
      pubkey: getPublicKey(key),
      signEvent: (tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }) =>
        fe({ kind: tmpl.kind, tags: tmpl.tags, content: tmpl.content, created_at: tmpl.created_at ?? Math.floor(Date.now() / 1000) }, key),
    } as never,
    `${ORIGIN}/git`,
    "m",
    branch,
    into
  );
const mergeAsOwner = mergeAs(owner);
const mergeAsAgent = mergeAs(agent);

describe("merging a branch into its line", () => {
  it("creates the line AT the branch when the line was never pushed", { timeout: 30_000 }, async () => {
    const result = await mergeAsOwner("agent/feat"); // into defaults to "feat" by naming
    expect(result.merged).toBe(true);
    const { stdout } = await asOwner(["ls-remote", "--heads", `${ORIGIN}/git/m.git`, "feat"], work);
    expect(stdout).toContain("refs/heads/feat");
  });

  it("fast-forwards main as the owner — through the same hook that refuses agents", { timeout: 30_000 }, async () => {
    const result = await mergeAsOwner("agent/feat", "main");
    expect(result.merged).toBe(true);
    const { stdout } = await asOwner(["ls-remote", "--heads", `${ORIGIN}/git/m.git`, "main"], work);
    expect(stdout.slice(0, 8)).toBe(result.sha?.slice(0, 8));
  });

  it("is idempotent — merging again reports up to date", { timeout: 30_000 }, async () => {
    const result = await mergeAsOwner("agent/feat", "main");
    expect(result.merged).toBe(true);
    expect(result.reason).toContain("up to date");
  });

  it("refuses a non-fast-forward with the reason, not a merge commit", { timeout: 30_000 }, async () => {
    // Move main past the branch: sync to the merged tip FIRST, then a
    // new commit — now agent/feat is strictly behind main.
    await asOwner(["pull", "--quiet", "--ff-only", "origin", "main"], work);
    writeFileSync(path.join(work, "c.txt"), "three\n");
    await asOwner(["add", "."], work);
    await asOwner(["commit", "--quiet", "-m", "trunk moves on"], work);
    await asOwner(["push", "--quiet", "origin", "main"], work);
    const result = await mergeAsOwner("agent/feat", "main");
    expect(result.merged).toBe(false);
    expect(result.reason).toContain("not a fast-forward");
  });

  it("lets an AGENT move an unprotected line, but never main", { timeout: 30_000 }, async () => {
    // Lines are open, trunk is guarded — zero policy beyond the default.
    const open = await mergeAsAgent("agent/feat", "feat");
    expect(open.merged).toBe(true);
    const guarded = await mergeAsAgent("agent/feat", "main");
    expect(guarded.merged).toBe(false);
    expect(guarded.reason).toContain("protected");
  });

  it("journals the merge, so the thread task announces it", { timeout: 30_000 }, async () => {
    const url = `${ORIGIN}/git/m.git/fez-push-journal`;
    const res = await fetch(url, { headers: { Authorization: buildNip98Header(owner, url, "GET") } });
    const journal = await res.text();
    expect(journal).toContain("refs/heads/feat"); // the endpoint's update-ref left a line
  });

  it("serves the review diff, read-gated", { timeout: 30_000 }, async () => {
    // By now main has moved PAST agent/feat (the non-ff test), so the
    // review question with teeth is "what does main have that the branch
    // doesn't": three-dot from the branch shows exactly trunk's new
    // commit and nothing the branch already has.
    const path_ = `${ORIGIN}/git/m.git/fez-diff`;
    const url = `${path_}?from=agent/feat&to=main`;
    const res = await fetch(url, { headers: { Authorization: buildNip98Header(owner, path_, "GET") } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("c.txt"); // trunk's new commit
    expect(body).not.toContain("b.txt"); // already shared history
    expect((await fetch(url)).status).toBe(401); // no key, no diff
  });

  it("publishes a branch to the recorded upstream — authors intact", { timeout: 30_000 }, async () => {
    // A bare repo stands in for GitHub; `upstream` is recorded on the
    // channel exactly as fez-adopt records it, and read back through
    // rosterAccess.upstreamOf — the same seam production uses.
    const upstreamDir = path.join(root, "shop-window.git");
    await run("git", ["init", "--bare", "--quiet", upstreamDir], { encoding: "utf-8" });
    await publish(owner, {
      kind: 47101,
      tags: [["d", "chan-m"]],
      content: JSON.stringify({
        name: "m",
        visibility: "open",
        source: "fez-git",
        meta: { repo: "m", clone: `${ORIGIN}/git/m.git`, protect: "main", upstream: `file://${upstreamDir}` },
      }),
    });

    const syncUrl = `${ORIGIN}/git/m.git/fez-sync`;
    const res = await fetch(`${syncUrl}?ref=agent/feat`, {
      method: "POST",
      headers: { Authorization: buildNip98Header(owner, syncUrl, "POST") },
    });
    expect(res.status).toBe(200);
    const { stdout } = await run("git", ["-C", upstreamDir, "log", "-1", "--format=%an", "agent/feat"], { encoding: "utf-8" });
    expect(stdout.trim()).toBe("agent"); // author preserved through the mirror push
  });

  it("refuses to publish for a non-privileged key", { timeout: 30_000 }, async () => {
    const syncUrl = `${ORIGIN}/git/m.git/fez-sync`;
    const res = await fetch(`${syncUrl}?ref=agent/feat`, {
      method: "POST",
      headers: { Authorization: buildNip98Header(agent, syncUrl, "POST") },
    });
    expect(res.status).toBe(403);
  });

  it("says plainly when a repo has no upstream", { timeout: 30_000 }, async () => {
    // Overwrite the channel meta without upstream — latest event wins.
    await publish(owner, {
      kind: 47101,
      tags: [["d", "chan-m"]],
      // Strictly newer than the upstream-bearing event: same-second
      // edits tie and resolve by id, which this test must not depend on.
      created_at: Math.floor(Date.now() / 1000) + 5,
      content: JSON.stringify({
        name: "m",
        visibility: "open",
        source: "fez-git",
        meta: { repo: "m", clone: `${ORIGIN}/git/m.git`, protect: "main" },
      }),
    });
    const syncUrl = `${ORIGIN}/git/m.git/fez-sync`;
    const res = await fetch(`${syncUrl}?ref=agent/feat`, {
      method: "POST",
      headers: { Authorization: buildNip98Header(owner, syncUrl, "POST") },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toContain("no upstream");
  });

  it("says so for a branch that does not exist", { timeout: 30_000 }, async () => {
    const result = await mergeAsOwner("ghost/nope");
    expect(result.merged).toBe(false);
    expect(result.reason).toContain("no branch");
  });
});
