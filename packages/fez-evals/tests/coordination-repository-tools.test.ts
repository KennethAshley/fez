import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepositoryTools, repositoryWritablePaths } from "../../../dev/experiments/coordination/repository-tools.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fez-repository-tools-")); roots.push(root);
  const checkout = join(root, "checkout"); await mkdir(checkout);
  for (const path of [...repositoryWritablePaths, "packages/fez-acp/src/agent.ts"]) {
    await mkdir(join(checkout, path, ".."), { recursive: true });
    await writeFile(join(checkout, path), "first\nsecond\n");
  }
  execFileSync("git", ["init", checkout], { stdio: "pipe" });
  execFileSync("git", ["-C", checkout, "add", "."], { stdio: "pipe" });
  const tools = await createRepositoryTools(checkout, join(root, "evidence"));
  return { root, checkout, tools };
}

async function sandboxFixture(source: string) {
  const f = await fixture();
  const module = "packages/fez-evals/node_modules/vitest/dist/node.js";
  const esbuild = `packages/fez-evals/node_modules/@esbuild/darwin-${process.arch}/bin/esbuild`;
  for (const path of [module, esbuild]) await mkdir(join(f.checkout, path, ".."), { recursive: true });
  await writeFile(join(f.checkout, "package.json"), '{"type":"module"}');
  await writeFile(join(f.checkout, module), `export async function startVitest(){${source}}`);
  await writeFile(join(f.checkout, esbuild), "unused fixture executable");
  return f;
}

const sandboxAvailable = process.platform === "darwin" && Number(process.versions.node.split(".")[0]) >= 24;
it.skipIf(!sandboxAvailable)("denies host/evaluator/other-checkout access and network in parent and child processes", async () => {
  const f = await sandboxFixture(`
    const fs = await import('node:fs'); const assert = (await import('node:assert/strict')).default;
    const {execFileSync} = await import('node:child_process');
    const repo = process.cwd(), outside = repo + '/../canary';
    for (const path of [outside, repo+'/../other-checkout/source.ts', repo+'/../evidence/tools.json']) {
      assert.throws(()=>fs.readFileSync(path), {code:'EPERM'});
      assert.throws(()=>fs.writeFileSync(path,'changed'), {code:'EPERM'});
    }
    assert.throws(()=>fs.writeFileSync(repo+'/packages/fez-acp/src/hire-delivery.ts','changed'), {code:'EPERM'});
    assert.equal(process.env.FEZ_COORDINATION_API_KEY, undefined);
    assert.equal(process.env.FEZ_REPOSITORY_DUMMY_SECRET, undefined);
    execFileSync(process.execPath,['-e', "require('node:assert/strict').throws(()=>require('node:fs').readFileSync("+JSON.stringify(outside)+"),{code:'EPERM'})"]);
    const {createConnection} = await import('node:net');
    const error = await new Promise(resolve=>{const s=createConnection({host:'127.0.0.1',port:9});s.on('error',e=>{s.destroy();resolve(e)});s.on('connect',()=>{s.destroy();resolve(null)})});
    assert.equal(error.code,'EPERM');
    fs.writeFileSync(process.env.TMPDIR+'/allowed','scratch works');
    console.log('isolation controls passed');
  `);
  await writeFile(join(f.root, "canary"), "dummy host data");
  await mkdir(join(f.root, "other-checkout"));
  await writeFile(join(f.root, "other-checkout/source.ts"), "dummy sibling source");
  process.env.FEZ_REPOSITORY_DUMMY_SECRET = "never inherit this";
  try {
    const result = await f.tools.execute({ name: "check", check: "delivery-tests" });
    expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 0, accepted: null, stdout: "isolation controls passed\n" });
    expect(await readFile(join(f.root, "canary"), "utf8")).toBe("dummy host data");
  } finally { delete process.env.FEZ_REPOSITORY_DUMMY_SECRET; }
});

it.skipIf(!sandboxAvailable)("bounds output and aborts a running check without reporting acceptance", async () => {
  const flood = await sandboxFixture("process.stdout.write('x'.repeat(1_000_000)); await new Promise(()=>{});");
  const result = await flood.tools.execute({ name: "check", check: "delivery-tests" });
  expect(result).toMatchObject({ outputLimitExceeded: true, accepted: null });
  expect(Buffer.byteLength(String(result.stdout))).toBeLessThanOrEqual(131_072);
  const loop = await sandboxFixture("while(true){}");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    expect(await loop.tools.execute({ name: "check", check: "delivery-tests" }, controller.signal)).toMatchObject({ aborted: true, signal: "SIGKILL", accepted: null });
  } finally { clearTimeout(timer); }
}, 10_000);

it("reads tracked source and edits only task files with a matching prior hash", async () => {
  const { checkout, tools } = await fixture();
  const path = repositoryWritablePaths[0];
  const before = await tools.execute({ name: "read", path, startLine: 2, lineCount: 1 });
  expect(before).toMatchObject({ content: "second", totalLines: 3 });
  await expect(tools.execute({ name: "write", path, sha256: "0".repeat(64), content: "changed\n" })).rejects.toThrow(/changed/);
  const after = await tools.execute({ name: "write", path, sha256: before.sha256, content: "changed\n" });
  expect(after.sha256).not.toBe(before.sha256);
  expect(await readFile(join(checkout, path), "utf8")).toBe("changed\n");
  await expect(tools.execute({ name: "write", path: "packages/fez-acp/src/agent.ts", sha256: before.sha256, content: "bad" })).rejects.toThrow(/writable/);
  expect(await tools.snapshot()).toHaveProperty(path, "changed\n");
});

it("rejects escapes, untracked files, links, malformed requests and overlapping calls", async () => {
  const { root, checkout, tools } = await fixture();
  await writeFile(join(root, "secret"), "dummy");
  await writeFile(join(checkout, "untracked.md"), "dummy");
  for (const path of ["../secret", "/etc/passwd", ".git/config", "untracked.md", "packages/../secret", "node_modules/x"]) {
    await expect(tools.execute({ name: "read", path })).rejects.toThrow();
  }
  await expect(tools.execute({ name: "check", nameOverride: "sh", command: "echo bad" })).rejects.toThrow();
  await expect(tools.execute({ name: "read", path: repositoryWritablePaths[0], lineCount: Infinity })).rejects.toThrow();
  const path = repositoryWritablePaths[0];
  const pending = tools.execute({ name: "read", path });
  await expect(tools.execute({ name: "read", path })).rejects.toThrow(/in progress/);
  await pending;
  await rm(join(checkout, path)); await symlink(join(root, "secret"), join(checkout, path));
  await expect(tools.execute({ name: "read", path })).rejects.toThrow(/regular|symlink/);
  await rm(join(checkout, path)); await link(join(root, "secret"), join(checkout, path));
  await expect(tools.execute({ name: "read", path })).rejects.toThrow(/regular|link/);
});

// The real Vitest/Git integration runs against a prepared, disposable R01 checkout.
// Keeping it opt-in avoids cloning 2.7 GB of dependencies in the ordinary eval gate.
it.skipIf(!process.env.FEZ_R01_TOOL_CHECKOUT)("runs actual Git delivery tests and TypeScript inside the repository sandbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "fez-repository-sandbox-")); roots.push(root);
  const tools = await createRepositoryTools(process.env.FEZ_R01_TOOL_CHECKOUT!, join(root, "evidence"));
  const before = await tools.snapshot();
  for (const check of ["delivery-tests", "types"]) {
    const result = await tools.execute({ name: "check", check });
    expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 0, timedOut: false, outputLimitExceeded: false });
  }
  expect(await tools.snapshot()).toEqual(before);
}, 90_000);
