import { afterEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerServiceCommands } from "../../../src/cli/cmd-services.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each([undefined, ["fez-github"]])("starts the sentinel runtime with extension selection %j", async extensions => {
  const dir = mkdtempSync(path.join(tmpdir(), "fez-sentinel-cli-"));
  dirs.push(dir);
  const runtime = path.join(dir, "runtime.mjs");
  const result = path.join(dir, "started.json");
  writeFileSync(runtime, `import { writeFileSync } from "node:fs";
    export async function runSentinel(extensions) {
      writeFileSync(${JSON.stringify(result)}, JSON.stringify({ extensions }));
    }`);
  vi.stubEnv("FEZ_SENTINEL_RUNTIME", runtime);
  const program = new Command().exitOverride();
  registerServiceCommands(program);
  await program.parseAsync(["sentinel", ...(extensions ? ["--extensions", " fez-github "] : [])], { from: "user" });
  expect(JSON.parse(readFileSync(result, "utf8"))).toEqual(extensions ? { extensions } : {});
});
