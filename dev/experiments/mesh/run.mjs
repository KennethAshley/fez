#!/usr/bin/env node
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "fez-mesh-run-"));
try {
  const outfile = join(directory, "demo.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("demo.ts", import.meta.url))], outfile,
    bundle: true, platform: "node", format: "esm", logLevel: "silent",
    banner: { js: 'import { createRequire as meshRequire } from "node:module"; const require = meshRequire(import.meta.url);' } });
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
} finally { await rm(directory, { recursive: true, force: true }); }
