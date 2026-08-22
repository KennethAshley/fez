#!/usr/bin/env node
// Rewrite `@fezchat/protocol: file:../..` to a real version range for ONE
// package, in-place, right before `npm publish`. Local dev keeps file:
// (no workspaces here); the published package.json carries the range so
// `npm install` resolves @fezchat/protocol from the registry.
//
//   node scripts/prepare-publish.mjs packages/fez-mcp
//
// Idempotent, and only touches @fezchat/* file: deps. Run `git checkout` on
// the package.json afterward (or let the publish flow restore it).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const pkgDir = process.argv[2];
if (!pkgDir) { console.error("usage: prepare-publish.mjs <package-dir>"); process.exit(1); }

const protoVer = JSON.parse(readFileSync("package.json", "utf-8")).version;
const p = path.join(pkgDir, "package.json");
const d = JSON.parse(readFileSync(p, "utf-8"));

let changed = 0;
for (const field of ["dependencies", "devDependencies"]) {
  const deps = d[field];
  if (!deps) continue;
  for (const [name, spec] of Object.entries(deps)) {
    if (name.startsWith("@fezchat/") && String(spec).startsWith("file:")) {
      deps[name] = `^${protoVer}`;
      changed++;
    }
  }
}
writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
console.log(`${pkgDir}: rewrote ${changed} @fezchat/* file: dep(s) → ^${protoVer}`);
