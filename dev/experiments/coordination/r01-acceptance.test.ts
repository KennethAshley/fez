// Evaluator-owned source, loaded read-only in place of candidate tests after submission.
// Relative imports resolve from packages/fez-evals/tests in the frozen checkout.
import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { deliverHire } from "../../../packages/fez-acp/src/hire-delivery.js";

const roots: string[] = [];
const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, encoding: "utf8", stdio: "pipe", timeout: 5000 }).trim();
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r01-case-")); roots.push(root);
  const work = path.join(root, "work"), remote = path.join(root, "remote.git"), config = path.join(root, "gitconfig"), branch = "worker/r01";
  fs.writeFileSync(config, ""); vi.stubEnv("GIT_CONFIG_GLOBAL", config); vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  git(root, ["init", "--bare", remote]); git(root, ["clone", remote, work]);
  fs.writeFileSync(path.join(work, "invoice.txt"), "before\n");
  git(work, ["add", "."]); git(work, ["-c", "commit.gpgsign=false", "-c", "user.name=owner", "-c", "user.email=owner@example.test", "commit", "-m", "seed"]);
  git(work, ["branch", "-M", "main"]); git(work, ["push", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  const seed = git(work, ["rev-parse", "HEAD"]);
  git(work, ["checkout", "-b", branch]); fs.writeFileSync(path.join(work, "invoice.txt"), "fixed\n");
  let authCalls = 0;
  const authHeader = () => `Authorization: Nostr dummy-auth-${++authCalls}`;
  return { root, work, remote, config, branch, seed, authCalls: () => authCalls,
    deliver: () => deliverHire({ dir: work, branch, personaId: "worker", message: "Repair invoice", authHeader }) };
}
type Fixture = ReturnType<typeof fixture>;
function rejectPush(f: Fixture) {
  const hook = path.join(f.remote, "hooks/pre-receive");
  fs.writeFileSync(hook, "#!/bin/sh\necho private-remote-detail >&2\nexit 1\n", { mode: 0o755 });
  return hook;
}
function expectFailure(f: Fixture, stage: string) {
  let caught: unknown;
  try { f.deliver(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  const message = String(caught);
  expect(message).toMatch(new RegExp(stage, "i"));
  expect(message).toContain(f.work); expect(message).toContain(f.branch);
  expect(message).not.toMatch(/dummy-auth|private-remote-detail|private-commit-detail/);
  expect(fs.existsSync(f.work)).toBe(true);
}
const remoteBranches = (f: Fixture) => git(f.remote, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);

it("C1 commits changed work as the persona, pushes only the branch, and preserves signing configuration", () => {
  const f = fixture();
  git(f.work, ["config", "--global", "commit.gpgsign", "true"]); git(f.work, ["config", "--global", "push.gpgsign", "true"]);
  git(f.work, ["config", "--global", "gpg.program", path.join(f.root, "unavailable-signer")]);
  const config = fs.readFileSync(f.config, "utf8");
  expect(f.deliver()).toBeUndefined();
  expect(git(f.remote, ["show", `${f.branch}:invoice.txt`])).toBe("fixed");
  expect(git(f.remote, ["rev-parse", "main"])).toBe(f.seed);
  expect(git(f.remote, ["show", "-s", "--format=%an <%ae>", f.branch])).toBe("worker <worker@fez>");
  expect(remoteBranches(f)).toBe(`main\n${f.branch}`);
  expect(fs.readFileSync(f.config, "utf8")).toBe(config);
  expect(fs.existsSync(f.work)).toBe(false);
});

it("C2 retains the completed commit and reports a sanitized push failure", () => {
  const f = fixture(); rejectPush(f); expectFailure(f, "push");
  expect(git(f.work, ["show", "HEAD:invoice.txt"])).toBe("fixed");
  expect(git(f.work, ["rev-parse", "HEAD^"])).toBe(f.seed);
  expect(git(f.work, ["status", "--porcelain"])).toBe("");
  expect(remoteBranches(f)).toBe("main");
});

it("C3 retries the same helper after rejected push without replacing the saved commit", () => {
  const f = fixture(), hook = rejectPush(f); expectFailure(f, "push");
  const saved = git(f.work, ["rev-parse", "HEAD"]); fs.unlinkSync(hook);
  expect(f.deliver()).toBeUndefined();
  expect(git(f.remote, ["rev-parse", f.branch])).toBe(saved);
  expect(git(f.remote, ["rev-list", "--count", f.branch])).toBe("2");
  expect(fs.existsSync(f.work)).toBe(false);
});

it("C4 preserves staged work after commit rejection and delivers after the blocker is removed", () => {
  const f = fixture(), hook = path.join(f.work, ".git/hooks/pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\necho private-commit-detail >&2\nexit 1\n", { mode: 0o755 });
  expectFailure(f, "commit");
  expect(git(f.work, ["diff", "--cached", "--name-only"])).toBe("invoice.txt");
  expect(git(f.work, ["rev-parse", "HEAD"])).toBe(f.seed);
  expect(fs.readFileSync(path.join(f.work, "invoice.txt"), "utf8")).toBe("fixed\n");
  expect(remoteBranches(f)).toBe("main");
  fs.unlinkSync(hook); expect(f.deliver()).toBeUndefined();
  expect(git(f.remote, ["show", `${f.branch}:invoice.txt`])).toBe("fixed");
  expect(fs.existsSync(f.work)).toBe(false);
});

it("C5 reports success on cleanup failure and can clean unchanged delivered work without another commit", () => {
  const f = fixture(), remove = fs.rmSync;
  const cleanup = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
    if (target === f.work) throw new Error("cleanup denied");
    return remove(target, options);
  });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(f.deliver()).toBeUndefined();
  expect(warning.mock.calls.flat().join(" ")).toMatch(/cleanup/i);
  expect(warning.mock.calls.flat().join(" ")).not.toMatch(/dummy-auth/);
  const saved = git(f.remote, ["rev-parse", f.branch]);
  expect(git(f.work, ["rev-parse", "HEAD"])).toBe(saved);
  expect(git(f.remote, ["show", `${f.branch}:invoice.txt`])).toBe("fixed");
  cleanup.mockRestore(); expect(f.deliver()).toBeUndefined();
  expect(git(f.remote, ["rev-parse", f.branch])).toBe(saved);
  expect(fs.existsSync(f.work)).toBe(false);
});

it("C6 refuses a different branch and detached HEAD before mutating or deleting work", () => {
  for (const mode of ["other", "detached"]) {
    const f = fixture(); git(f.work, mode === "other" ? ["checkout", "-b", "other"] : ["checkout", "--detach"]);
    const before = { head: git(f.work, ["rev-parse", "HEAD"]), status: git(f.work, ["status", "--porcelain"]), index: git(f.work, ["write-tree"]), refs: remoteBranches(f) };
    expect(() => f.deliver()).toThrow();
    expect(fs.existsSync(f.work)).toBe(true);
    expect({ head: git(f.work, ["rev-parse", "HEAD"]), status: git(f.work, ["status", "--porcelain"]), index: git(f.work, ["write-tree"]), refs: remoteBranches(f) }).toEqual(before);
    expect(fs.readFileSync(path.join(f.work, "invoice.txt"), "utf8")).toBe("fixed\n");
  }
});

it("C7 preserves divergent remote work and the failed local commit without force or reset", () => {
  const f = fixture(); git(f.work, ["push", "origin", f.branch]);
  const other = path.join(f.root, "other"); git(f.root, ["clone", f.remote, other]); git(other, ["checkout", f.branch]);
  fs.writeFileSync(path.join(other, "remote-work.txt"), "keep me\n"); git(other, ["add", "."]);
  git(other, ["-c", "commit.gpgsign=false", "-c", "user.name=other", "-c", "user.email=other@example.test", "commit", "-m", "remote work"]);
  git(other, ["push", "origin", f.branch]); const remoteHead = git(f.remote, ["rev-parse", f.branch]);
  expectFailure(f, "push");
  expect(git(f.remote, ["rev-parse", f.branch])).toBe(remoteHead);
  expect(git(f.remote, ["show", `${f.branch}:remote-work.txt`])).toBe("keep me");
  expect(git(f.work, ["rev-parse", "HEAD^"])).toBe(f.seed);
  expect(git(f.work, ["show", "HEAD:invoice.txt"])).toBe("fixed");
  expect(git(f.remote, ["rev-parse", "main"])).toBe(f.seed);
});

it("C8 obtains and uses fresh authorization on each push attempt", () => {
  const f = fixture(), hook = rejectPush(f), bin = path.join(f.root, "bin"), log = path.join(f.root, "auth-log");
  fs.mkdirSync(bin);
  // File transport strips HTTP configuration at the remote. Observe effective local Git config instead.
  fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process');
const git='/Library/Developer/CommandLineTools/usr/bin/git',args=process.argv.slice(2),push=args.indexOf('push');
if(push>=0){let header=null;try{header=cp.execFileSync(git,[...args.slice(0,push),'config','--get-all','http.extraHeader'],{encoding:'utf8',stdio:'pipe'}).trim()}catch{}
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(header)+'\\n')}
const child=cp.spawnSync(git,args,{stdio:'inherit'});process.exit(child.status===null?1:child.status);
`, { mode: 0o755 });
  vi.stubEnv("PATH", bin + path.delimiter + process.env.PATH);
  expectFailure(f, "push"); const firstCalls = f.authCalls();
  fs.unlinkSync(hook); expect(f.deliver()).toBeUndefined();
  expect(firstCalls).toBeGreaterThan(0); expect(f.authCalls()).toBeGreaterThan(firstCalls);
  const headers = fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(headers).toHaveLength(2);
  expect(Array.from({ length: firstCalls }, (_, i) => `Authorization: Nostr dummy-auth-${i + 1}`)).toContain(headers[0]);
  expect(Array.from({ length: f.authCalls() - firstCalls }, (_, i) => `Authorization: Nostr dummy-auth-${firstCalls + i + 1}`)).toContain(headers[1]);
  expect(fs.existsSync(f.work)).toBe(false);
});
