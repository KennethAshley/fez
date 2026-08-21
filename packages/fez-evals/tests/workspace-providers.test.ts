import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip98Authenticator } from "../../fez-git/src/auth.js";
import { gitServer } from "../../fez-git/src/serve.js";
import { resolveWorkspace, defaultBranchFor } from "../../fez-acp/src/workspaces.js";
import { startRelay, type RelayHandle } from "../../fez-relay/src/relay.js";

/**
 * The seam between "an agent needs somewhere to work" and "git".
 *
 * fez-acp must not know what git is: `~/.fez/workspace-providers` is a
 * place, and `fez install @fez/git` drops a provider in it. This proves
 * both halves — the loader's contract, and that the REAL fez-git bundle
 * satisfies it against a live relay.
 */

const PORT = 7897;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../fez-git/dist");

const owner = generateSecretKey();
const ownerPk = getPublicKey(owner);
const hex = (k: Uint8Array) => [...k].map((b) => b.toString(16).padStart(2, "0")).join("");

const run = promisify(execFile);
let relay: RelayHandle;
let root: string;
let providers: string;

async function seedRepo() {
  const w = path.join(root, "seed");
  mkdirSync(w, { recursive: true });
  const git = (args: string[]) =>
    run("git", ["-c", `credential.helper=${path.join(DIST, "credential.js")}`, "-c", "credential.useHttpPath=true", ...args], {
      cwd: w,
      env: { ...process.env, FEZ_SECRET_KEY: hex(owner), GIT_TERMINAL_PROMPT: "0" },
    });
  await git(["init", "--quiet", "--initial-branch=main"]);
  await git(["config", "user.email", "o@fez"]);
  await git(["config", "user.name", "owner"]);
  writeFileSync(path.join(w, "README.md"), "# provided\n");
  await git(["add", "."]);
  await git(["commit", "--quiet", "-m", "seed"]);
  await git(["remote", "add", "origin", `${ORIGIN}/git/provided.git`]);
  await git(["push", "--quiet", "origin", "main"]);
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "fez-prov-"));
  providers = path.join(root, "providers");
  mkdirSync(providers, { recursive: true });
  process.env.FEZ_WORKSPACE_PROVIDERS = providers;
  relay = startRelay({
    port: PORT,
    log: () => {},
    httpHandlers: [
      gitServer({
        root: path.join(root, "repos"),
        authenticate: nip98Authenticator({ origins: [ORIGIN] }),
        // The relay advertises its git base; the provider must READ that
        // rather than deriving it from the websocket URL.
        access: { canRead: (_r, w) => w.pubkey === ownerPk, canWrite: (_r, w) => w.pubkey === ownerPk },
      }),
    ],
  });
  relay.advertise("fez_git", { clone_base: `${ORIGIN}/git` });
  await seedRepo();
}, 60_000);

afterAll(() => {
  relay?.close();
  delete process.env.FEZ_WORKSPACE_PROVIDERS;
  rmSync(root, { recursive: true, force: true });
});

const request = (over: Partial<Parameters<typeof resolveWorkspace>[0]> = {}) => ({
  repo: "provided",
  branch: "researcher/work",
  dir: path.join(root, "agentwork"),
  relayUrl: `ws://127.0.0.1:${PORT}`,
  secretKeyHex: hex(owner),
  ...over,
});

/**
 * A FRESH directory per test.
 *
 * resolveWorkspace loads providers with `await import()`, and ESM caches
 * by resolved path — so rewriting the same filename silently re-runs the
 * FIRST version. (That is also true in production, and correct there: an
 * installed provider changing on disk takes effect on restart, exactly
 * like a relay extension.) Unique paths keep each case honest.
 */
let caseId = 0;
function providerDir(files: Record<string, string>): string {
  const dir = path.join(providers, `case-${++caseId}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  process.env.FEZ_WORKSPACE_PROVIDERS = dir;
  return dir;
}

describe("the provider contract", () => {
  it("uses the first provider that claims the request", async () => {
    providerDir({
      "00-a.js": "export default async () => undefined;\n",
      "01-b.js": "export default async (r) => ({ dir: r.dir + '-b', branch: r.branch, empty: false });\n",
    });
    const ws = await resolveWorkspace(request());
    expect(ws?.dir).toMatch(/-b$/);
  });

  it("returns undefined when nothing claims it, so a plain scratch dir is used", async () => {
    providerDir({ "00-a.js": "export default async () => undefined;\n" });
    expect(await resolveWorkspace(request())).toBeUndefined();
  });

  it("propagates a provider's failure instead of falling through", async () => {
    // The dangerous case: an agent told to work on a repo, quietly given
    // an empty folder, running a full turn and reporting success.
    providerDir({ "00-a.js": "export default async () => { throw new Error('clone refused'); };\n" });
    await expect(resolveWorkspace(request())).rejects.toThrow("clone refused");
  });

  it("skips a provider that will not load rather than dying", async () => {
    providerDir({
      "broken.js": "this is not javascript {{{\n",
      "zz-good.js": "export default async (r) => ({ dir: r.dir, branch: r.branch, empty: false });\n",
    });
    const ws = await resolveWorkspace(request());
    expect(ws).toBeDefined();
  });
});

describe("the real fez-git provider, installed", () => {
  it("clones from the relay the NIP-11 document points at", { timeout: 90_000 }, async () => {
    // Exactly what `fez install @fez/git` does: the built bundle, plus
    // the credential helper beside it.
    const dir = providerDir({});
    copyFileSync(path.join(DIST, "workspace-part.js"), path.join(dir, "fez-git.js"));
    copyFileSync(path.join(DIST, "credential.js"), path.join(dir, "credential.js"));

    const ws = await resolveWorkspace(request({ dir: path.join(root, "real") }));
    expect(ws).toBeDefined();
    expect(ws!.branch).toBe("researcher/work");
    expect(existsSync(path.join(ws!.dir, "README.md"))).toBe(true);
  });

  it("refuses clearly when the relay serves no git", { timeout: 60_000 }, async () => {
    // A relay with no fez_git in its NIP-11. The provider must say so,
    // not invent a URL from the websocket address.
    const dir = providerDir({});
    copyFileSync(path.join(DIST, "workspace-part.js"), path.join(dir, "fez-git.js"));
    copyFileSync(path.join(DIST, "credential.js"), path.join(dir, "credential.js"));
    const bare = startRelay({ port: PORT + 1, log: () => {} });
    try {
      await expect(
        resolveWorkspace(request({ relayUrl: `ws://127.0.0.1:${PORT + 1}`, dir: path.join(root, "nogit") }))
      ).rejects.toThrow(/does not advertise a git server/);
    } finally {
      bare.close();
    }
  });
});

describe("default branch naming", () => {
  it("gives each agent its own line so a fleet never races", () => {
    expect(defaultBranchFor("researcher")).toBe("researcher/work");
    expect(defaultBranchFor("Code Reviewer!")).toBe("code-reviewer/work");
  });
});
