import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip98Authenticator } from "../../fez-git/src/auth.js";
import { gitServer } from "../../fez-git/src/serve.js";
import { parseJournal } from "../../fez-git/src/journal.js";
import { buildNip98Header } from "../../../src/nip98.js";
import { startRelay, type RelayHandle } from "../../fez-relay/src/relay.js";

/**
 * The push journal, end to end: real pushes leave transport-truth
 * records, and reading them is gated exactly like cloning.
 *
 * This is the ground the branch-threads feature stands on — if the
 * journal lies about who pushed, the threads lie; if it is readable
 * without membership, the repo's activity leaks to strangers.
 */

const PORT = 7843;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fez-git/dist/credential.js");

const owner = generateSecretKey();
const ownerPk = getPublicKey(owner);
const alice = generateSecretKey();
const alicePk = getPublicKey(alice);
const stranger = generateSecretKey();

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

const remote = `${ORIGIN}/git/journal.git`;
const journalUrl = `${ORIGIN}/git/journal.git/fez-push-journal`;

const journalAs = async (key: Uint8Array) =>
  fetch(journalUrl, { headers: { Authorization: buildNip98Header(key, journalUrl, "GET") } });

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "fez-journal-"));
  relay = startRelay({
    port: PORT,
    httpHandlers: [
      gitServer({
        root: path.join(root, "repos"),
        authenticate: nip98Authenticator({ origins: [ORIGIN] }),
        access: {
          canRead: (_r, who) => who.pubkey === ownerPk || who.pubkey === alicePk,
          canWrite: (_r, who) => who.pubkey === ownerPk || who.pubkey === alicePk,
        },
      }),
    ],
  });

  const work = path.join(root, "work");
  mkdirSync(work, { recursive: true });
  await asOwner(["init", "--quiet", "--initial-branch=main"], work);
  await asOwner(["config", "user.email", "o@fez"], work);
  await asOwner(["config", "user.name", "owner"], work);
  writeFileSync(path.join(work, "a.txt"), "one\n");
  await asOwner(["add", "."], work);
  await asOwner(["commit", "--quiet", "-m", "one"], work);
  await asOwner(["remote", "add", "origin", remote], work);
  await asOwner(["push", "--quiet", "origin", "main"], work);
}, 60_000);

afterAll(() => {
  relay?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the push journal", () => {
  it("records who pushed which ref where", { timeout: 30_000 }, async () => {
    const dir = path.join(root, "alice");
    await asAlice(["clone", "--quiet", remote, dir], root);
    await asAlice(["config", "user.email", "a@fez"], dir);
    await asAlice(["config", "user.name", "alice"], dir);
    await asAlice(["checkout", "--quiet", "-b", "alice/work"], dir);
    writeFileSync(path.join(dir, "b.txt"), "two\n");
    await asAlice(["add", "."], dir);
    await asAlice(["commit", "--quiet", "-m", "two"], dir);
    await asAlice(["push", "--quiet", "origin", "alice/work"], dir);

    const res = await journalAs(owner);
    expect(res.status).toBe(200);
    const entries = parseJournal(await res.text());
    expect(entries).toHaveLength(2);

    // The owner's push created the repo, so it is entry zero.
    expect(entries[0].pusher).toBe(ownerPk);
    expect(entries[0].ref).toBe("refs/heads/main");
    expect(entries[0].old).toBe("0".repeat(40));

    // Alice's entry says ALICE — commit authorship aside, the transport
    // knows whose key moved the ref, and that is what threads report.
    expect(entries[1].pusher).toBe(alicePk);
    expect(entries[1].ref).toBe("refs/heads/alice/work");
    expect(entries[1].new).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is read-gated exactly like clone", { timeout: 30_000 }, async () => {
    expect((await journalAs(stranger)).status).toBe(403);
    expect((await fetch(journalUrl)).status).toBe(401);
  });

  it("answers a browser preflight and stamps CORS — the webview reads this", { timeout: 30_000 }, async () => {
    // The lane board fetches with an Authorization header, which makes
    // the browser preflight. No 204 + headers here = a silently empty
    // board with the journal sitting right there (it happened).
    const pre = await fetch(journalUrl, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
    const real = await journalAs(owner);
    expect(real.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("404s for a repo that does not exist", { timeout: 30_000 }, async () => {
    const absent = `${ORIGIN}/git/absent.git/fez-push-journal`;
    const res = await fetch(absent, { headers: { Authorization: buildNip98Header(owner, absent, "GET") } });
    expect(res.status).toBe(404);
  });
});

/**
 * The whole loop: the shipped headless task reads that journal through
 * a signEvent-minted NIP-98 header and posts branch threads.
 *
 * This is the part that cannot be proven by units — that the header the
 * extension builds (key behind the seam) is the header the relay's
 * verifier accepts, and that a second tick against its own output goes
 * quiet.
 */
import { finalizeEvent } from "nostr-tools/pure";
import fezGit from "../../fez-git/src/headless.js";
import type { FezExtensionAPI, ScheduledTaskContext } from "../../fez-git/src/api-types.js";

describe("the branch-threads task against a live relay", () => {
  it("posts a thread per branch, then goes quiet", { timeout: 30_000 }, async () => {
    let task: ((ctx: ScheduledTaskContext) => void | Promise<void>) | undefined;
    const said: { channelId: string; text: string; threadRoot?: string }[] = [];
    /** What the fake relay "stores" — fed back to the next tick's query. */
    const stored: { id: string; content: string; tags: string[][] }[] = [];

    const nostr = {
      pubkey: ownerPk,
      publish: async () => ({ id: "", kind: 0, pubkey: "", created_at: 0, content: "", tags: [] }),
      signEvent: (tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }) =>
        finalizeEvent({ kind: tmpl.kind, tags: tmpl.tags, content: tmpl.content, created_at: tmpl.created_at ?? 0 }, owner),
      query: async (filters: Record<string, unknown>[]) =>
        (filters[0]?.kinds as number[])?.includes(47103) ? stored : [],
      subscribe: () => () => {},
      encrypt: () => "",
      decrypt: () => "",
    };
    const channels = {
      list: async () => [{ id: "chan-1", name: "journal", source: "fez-git", meta: { repo: "journal" } }],
      ensure: async () => "chan-1",
      say: async (channelId: string, text: string, opts?: { threadRoot?: string }) => {
        said.push({ channelId, text, threadRoot: opts?.threadRoot });
        const id = `msg-${stored.length}`;
        stored.push({ id, content: text, tags: opts?.threadRoot ? [["e", opts.threadRoot, "", "root"]] : [] });
        return id;
      },
    };

    const api = {
      registerCommand: () => {},
      registerScheduledTask: (_n: string, _ms: number, run: typeof task) => (task = run),
      nostr,
      channels,
      workspace: { info: { fez_git: { clone_base: `${ORIGIN}/git` } } },
    } as unknown as FezExtensionAPI;

    fezGit(api);
    expect(task).toBeDefined();

    const ctx = { nostr, ownerPubkey: ownerPk, channels, missedWindow: false } as unknown as ScheduledTaskContext;

    // Tick one: both branches from the pushes above become threads.
    await task!(ctx);
    expect(said.map((s) => s.text).join("\n")).toContain("⑂ `main`");
    expect(said.map((s) => s.text).join("\n")).toContain("⑂ `alice/work`");
    expect(said).toHaveLength(2);

    // Tick two: the channel already shows everything. Silence.
    await task!(ctx);
    expect(said).toHaveLength(2);
  });
});
