import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { nip98Authenticator } from "../../fez-git/src/auth.js";
import { gitServer, rosterAccess } from "../../fez-git/src/serve.js";
import { parseJournal } from "../../fez-git/src/journal.js";
import { planThreadPosts } from "../../fez-git/src/threads.js";
import { buildNip98Header } from "../../../src/protocol/nip98.js";
import { startRelay, type RelayHandle } from "../../fez-relay/src/relay.js";

/**
 * COLD START — the composition every new user hits, end to end.
 *
 * Every piece of this had a unit test and the whole still failed live,
 * five different ways, on the first fresh relay it met: a channel-first
 * repo that could not be cloned, an agent whose pushes had no
 * credentials, a roster that had never seen the agent. This file runs
 * the actual first-day sequence against a virgin relay:
 *
 *   owner claims workspace → /repo new (channel only, no repo) →
 *   agent spawns via the REAL installed provider → works in its
 *   checkout → a PLAIN `git push` births the repo → the journal
 *   records it → the thread plan opens the branch's thread →
 *   protection holds against the same agent.
 *
 * The only mocked part is the LLM. If this file is green, the demo
 * works.
 */

const PORT = 7845;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../fez-git/dist");

const owner = generateSecretKey();
const ownerPk = getPublicKey(owner);
const agent = generateSecretKey(); // the bundled-researcher stand-in
const agentPk = getPublicKey(agent);
const stranger = generateSecretKey();
const hex = (key: Uint8Array) => [...key].map((b) => b.toString(16).padStart(2, "0")).join("");

const run = promisify(execFile);
let relay: RelayHandle;
let root: string;

/** Publish a signed event over the real websocket, as a client would. */
function publish(secret: Uint8Array, tmpl: { kind: number; tags: string[][]; content: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const event = finalizeEvent({ ...tmpl, created_at: Math.floor(Date.now() / 1000) }, secret);
    const socket = new WebSocket(WS);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("publish timed out")); }, 5000);
    socket.on("open", () => socket.send(JSON.stringify(["EVENT", event])));
    socket.on("message", (data: Buffer) => {
      const [type, , okFlag, why] = JSON.parse(data.toString()) as [string, string, boolean, string];
      if (type !== "OK") return;
      clearTimeout(timer);
      socket.close();
      if (okFlag) resolve();
      else reject(new Error(`relay refused: ${why}`));
    });
    socket.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "fez-coldstart-"));
  relay = startRelay({
    port: PORT,
    workspace: { name: "fresh", owner: ownerPk },
    httpHandlers: [
      gitServer({
        root: path.join(root, "repos"),
        authenticate: nip98Authenticator({ origins: [ORIGIN] }),
        // The REAL access rule, reading the relay's own store — not a
        // test stand-in. The roster below is what admits the agent.
        access: rosterAccess((filter) => relay.query(filter), ownerPk),
      }),
    ],
  });
  relay.advertise("fez_git", { clone_base: `${ORIGIN}/git` });

  // Day one, step one: the owner opens the repo's channel (protect is
  // the default main) and puts the agent on the roster as a bot.
  await publish(owner, {
    kind: 47101,
    tags: [["d", "chan-newborn"]],
    content: JSON.stringify({ name: "newborn", visibility: "open", source: "fez-git", meta: { repo: "newborn", clone: `${ORIGIN}/git/newborn.git`, protect: "main" } }),
  });
  await publish(owner, { kind: 47102, tags: [["d", "roster"], ["p", agentPk, "bot"]], content: "" });

  // The provider exactly as installed: the built bundle in a providers dir.
  const providers = path.join(root, "providers");
  mkdirSync(providers, { recursive: true });
  copyFileSync(path.join(DIST, "workspace-part.js"), path.join(providers, "fez-git.js"));
  process.env.FEZ_WORKSPACE_PROVIDERS = providers;
}, 30_000);

afterAll(() => {
  delete process.env.FEZ_WORKSPACE_PROVIDERS;
  relay?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("a fresh workspace's first agent", () => {
  const checkout = () => path.join(root, "agent-checkout");

  it("gets a working checkout of a repo that does not exist yet", { timeout: 60_000 }, async () => {
    const { resolveWorkspace } = await import("../../fez-acp/src/workspaces.js");
    const ws = await resolveWorkspace({
      repo: "newborn",
      branch: "researcher/work",
      dir: checkout(),
      relayUrl: WS,
      secretKeyHex: hex(agent),
    });
    expect(ws).toBeDefined();
    expect(ws!.empty).toBe(true); // never pushed — the agent makes the first commit
    expect(ws!.branch).toBe("researcher/work");
  });

  it("pushes with a PLAIN git push, and the push births the repo", { timeout: 60_000 }, async () => {
    // No -c flags, no wrapper: this is the agent running `git push` in
    // its own shell, which is what actually happens on turn two. The
    // auth lives in the checkout; the key rides the process env.
    const git = (args: string[]) =>
      run("git", args, { cwd: checkout(), encoding: "utf-8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", FEZ_SECRET_KEY: hex(agent) } });
    await git(["config", "user.email", "researcher@fez"]);
    await git(["config", "user.name", "researcher"]);
    writeFileSync(path.join(checkout(), "README.md"), "born cold\n");
    await git(["add", "."]);
    await git(["commit", "--quiet", "-m", "first commit from the fleet"]);
    await git(["push", "--quiet", "origin", "researcher/work"]);
    expect(existsSync(path.join(root, "repos", "newborn.git"))).toBe(true);
  });

  it("cannot move main, even now", { timeout: 60_000 }, async () => {
    const git = (args: string[]) =>
      run("git", args, { cwd: checkout(), encoding: "utf-8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", FEZ_SECRET_KEY: hex(agent) } });
    await expect(git(["push", "origin", "researcher/work:main"])).rejects.toThrow(/protected/);
  });

  it("is journaled, and the journal plans the branch's thread", { timeout: 30_000 }, async () => {
    const url = `${ORIGIN}/git/newborn.git/fez-push-journal`;
    const res = await fetch(url, { headers: { Authorization: buildNip98Header(owner, url, "GET") } });
    expect(res.status).toBe(200);
    const entries = parseJournal(await res.text());
    expect(entries).toHaveLength(1);
    expect(entries[0].pusher).toBe(agentPk);
    expect(entries[0].ref).toBe("refs/heads/researcher/work");

    const posts = planThreadPosts(entries, [], () => "researcher");
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain("⑂ `researcher/work`");
  });

  it("stays closed to keys the roster never admitted", { timeout: 30_000 }, async () => {
    const url = `${ORIGIN}/git/newborn.git/fez-push-journal`;
    expect((await fetch(url, { headers: { Authorization: buildNip98Header(stranger, url, "GET") } })).status).toBe(403);
  });
});
