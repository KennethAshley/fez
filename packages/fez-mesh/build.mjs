import { build } from "esbuild";
import { chmod } from "node:fs/promises";
await build({ entryPoints: ["src/cli.ts"], outfile: "dist/cli.mjs", bundle: true, platform: "node", format: "esm",
  banner: { js: 'import { createRequire as meshRequire } from "node:module"; const require = meshRequire(import.meta.url);' } });
await chmod("dist/cli.mjs", 0o755);
await build({ entryPoints: ["src/gui.ts"], outfile: "dist/gui.js", bundle: true, platform: "browser", format: "iife", globalName: "__fezExt" });
// Use Fez's actual evaluation runtime, including its persona/model selection, without a second agent implementation.
await build({ entryPoints: ["../fez-acp/src/agent.ts"], outfile: "dist/evaluate.mjs", bundle: true, platform: "node", format: "esm",
  banner: { js: 'import { createRequire as meshRequire } from "node:module"; const require = meshRequire(import.meta.url);' } });
