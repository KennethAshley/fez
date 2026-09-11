import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deliverHire } from "../../fez-acp/src/hire-delivery.js";

let root: string, work: string, remote: string, config: string;
const git = (args: string[], cwd = work) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "fez-delivery-test-"));
  work = path.join(root, "work"); remote = path.join(root, "remote.git"); config = path.join(root, "gitconfig");
  vi.stubEnv("GIT_CONFIG_GLOBAL", config); vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  fs.writeFileSync(config, "");
  git(["init", "--bare", remote], root);
  git(["clone", remote, work], root);
  fs.writeFileSync(path.join(work, "invoice.txt"), "before\n");
  git(["add", "."]);
  git(["-c", "user.name=owner", "-c", "user.email=owner@example.test", "commit", "-m", "seed"]);
  git(["branch", "-M", "main"]); git(["push", "origin", "main"]);
  git(["checkout", "-b", "lebron/hire-test"]);
  fs.writeFileSync(path.join(work, "invoice.txt"), "fixed\n");
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

const deliver = () => deliverHire({ dir: work, branch: "lebron/hire-test", personaId: "lebron", message: "Fix invoice", authHeader: () => "Authorization: Nostr test-credential" });

it("delivers agent work despite the owner's interactive commit and push signing settings", () => {
  git(["config", "--global", "commit.gpgsign", "true"]);
  git(["config", "--global", "push.gpgsign", "true"]);
  git(["config", "--global", "gpg.program", path.join(root, "unavailable-interactive-signer")]);
  const before = fs.readFileSync(config, "utf8");
  deliver();
  expect(git(["show", "lebron/hire-test:invoice.txt"], remote)).toBe("fixed");
  expect(git(["show", "main:invoice.txt"], remote)).toBe("before");
  expect(git(["show", "-s", "--format=%an <%ae>", "lebron/hire-test"], remote)).toBe("lebron <lebron@fez>");
  expect(fs.readFileSync(config, "utf8")).toBe(before);
  expect(fs.existsSync(work)).toBe(false);
});

it("preserves the completed commit when the server rejects its push and supports delivery-only recovery", () => {
  const hook = path.join(remote, "hooks", "pre-receive");
  fs.writeFileSync(hook, "#!/bin/sh\necho 'private-server-detail' >&2\nexit 1\n", { mode: 0o755 });
  let error: unknown;
  try { deliver(); } catch (e) { error = e; }
  expect(String(error)).toMatch(/push.*failed/i);
  expect(String(error)).toContain(work);
  expect(String(error)).not.toMatch(/test-credential|private-server-detail/);
  expect(fs.existsSync(work)).toBe(true);
  expect(git(["show", "HEAD:invoice.txt"])).toBe("fixed");
  const head = git(["rev-parse", "HEAD"]);
  fs.unlinkSync(hook);
  // Retry only delivery; the engine need not run or be paid again.
  git(["-c", "push.gpgsign=false", "push", "origin", "lebron/hire-test"]);
  expect(git(["rev-parse", "lebron/hire-test"], remote)).toBe(head);
});

it("preserves staged edits when a commit hook fails and names the failed step", () => {
  fs.writeFileSync(path.join(work, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  expect(deliver).toThrow(/commit.*failed/i);
  expect(fs.readFileSync(path.join(work, "invoice.txt"), "utf8")).toBe("fixed\n");
  expect(git(["diff", "--cached", "--name-only"])).toBe("invoice.txt");
});


it("reports delivered work even when local cleanup fails", () => {
  const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw new Error("cleanup denied"); });
  try {
    expect(deliver).not.toThrow();
    expect(git(["show", "lebron/hire-test:invoice.txt"], remote)).toBe("fixed");
  } finally { remove.mockRestore(); }
});
