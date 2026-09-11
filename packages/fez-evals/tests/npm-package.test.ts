import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
