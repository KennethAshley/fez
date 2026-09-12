import { expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { verifyEvent } from "nostr-tools/pure";
import { MiniRelay } from "./mini-relay.js";

const run = promisify(execFile);

it("packs the CLI's sibling runtimes and its advertised client export", () => {
  const root = resolve(import.meta.dirname, "../../..");
  const cache = mkdtempSync(join(tmpdir(), "fez-pack-cache-"));
  try {
    const output = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json", "--cache", cache], { cwd: root, encoding: "utf8" });
    const packed = JSON.parse(output) as { files: { path: string }[] }[];
    const files = new Set(packed[0].files.map(file => file.path));
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const file of [
      "packages/fez-client/dist/agent-input.js", "packages/fez-client/dist/channel-message.js",
      "packages/fez-tui/dist/index.js", "packages/fez-acp/dist/agent.js",
      "packages/fez-sentinel/dist/index.js", "packages/fez-orchestrator/dist/orchestrator.js",
      "packages/fez-mcp/dist/server.js", manifest.exports["./client"].import.slice(2),
      manifest.exports["./client"].types.slice(2),
    ]) expect(files.has(file), `npm tarball is missing ${file}`).toBe(true);
    expect([...files].some(file => /(^|\/)\.env(?:\.|$)/.test(file))).toBe(false);
  } finally { rmSync(cache, { recursive: true, force: true }); }
}, 15000);

it("runs the public work API from a clean npm install, including types and browser imports", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  // Outside the checkout: no monorepo aliases, sibling packages, or source imports.
  const directory = mkdtempSync(join(tmpdir(), "fez-npm-work-"));
  const relay = new MiniRelay();
  try {
    const { stdout } = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: root });
    const [{ filename }] = JSON.parse(stdout) as { filename: string }[];
    writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
    await run("npm", ["install", join(directory, filename), "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--package-lock=false", "--prefer-offline"], {
      cwd: directory, timeout: 120_000,
    });
    const env = { ...process.env, HOME: directory, NODE_PATH: "", NODE_OPTIONS: "" };
    // Root and browser consumers receive the very same functions at runtime.
    await run(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import * as core from '@fezchat/protocol';
      import * as client from '@fezchat/protocol/client';
      for (const name of ['completeWork', 'workResult', 'acceptWork']) {
        assert.equal(typeof core[name], 'function', name + ' must be publicly exported');
        assert.equal(core[name], client[name], name + ' must share one implementation');
      }
    `], { cwd: directory, env, timeout: 15_000 });
    copyFileSync(join(root, "examples/work-roundtrip.mjs"), join(directory, "work-roundtrip.mjs"));
    await relay.start();
    await run(process.execPath, ["work-roundtrip.mjs", relay.url], { cwd: directory, env, timeout: 20_000 });
    const [request, result, acceptance] = relay.events;
    expect(relay.events).toHaveLength(3);
    expect(relay.events.every(event => verifyEvent(event))).toBe(true);
    expect(result.content).toBe("PACKAGE ROUNDTRIP: MAKE THIS UPPERCASE.");
    expect(result.tags).toContainEqual(["result", request.id]);
    expect(result.tags).toContainEqual(["status", "success"]);
    expect(acceptance.kind).toBe(47007);
    expect(acceptance.pubkey).toBe(request.pubkey);
    expect(acceptance.tags).toContainEqual(["p", result.pubkey]);
    expect(acceptance.tags).toContainEqual(["e", result.id]);

    writeFileSync(join(directory, "consumer.ts"), `
      import * as core from '@fezchat/protocol';
      import * as client from '@fezchat/protocol/client';
      const complete: typeof core.completeWork = client.completeWork;
      const accept: typeof core.acceptWork = client.acceptWork;
      const check: typeof core.workResult = client.workResult;
      const request = { id: '', pubkey: '', content: '', tags: [] as string[][] };
      const result = { ...complete(request, '', { status: 'success', summary: 'done', capability: 'test', artifacts: [] }), id: '', pubkey: '' };
      const status: 'success' | 'error' | undefined = check(result, request);
      accept(result, request, '', 'Checked the output');
    `);
    await run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "consumer.ts"], {
      cwd: directory, env, timeout: 20_000,
    });
    await build({
      stdin: { contents: 'export { completeWork, workResult, acceptWork } from "@fezchat/protocol/client";', resolveDir: directory },
      bundle: true, platform: "browser", format: "esm", write: false,
    });
    const cli = await run(join(directory, "node_modules/.bin/fez"), ["--help"], { cwd: directory, env, timeout: 15_000 });
    expect(cli.stdout).toContain("Usage: fez");
  } finally {
    await relay.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
