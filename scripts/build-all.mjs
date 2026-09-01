#!/usr/bin/env node
/**
 * Build everything, by discovery rather than by memory.
 *
 * The root build used to name two packages — fez-tui and fez-relay —
 * while 25 have build scripts. Every other one was an opt-in script
 * (acp:build, herdr:build, …) that you had to remember to run. So
 * `npm run build` could pass, tests could pass, and the agents kept
 * loading a dist from hours earlier: a mention fix lived in source,
 * shipped in a commit, and was dead in the running system for an entire
 * afternoon before an end-to-end test caught it.
 *
 * A list you maintain by hand is a list that goes stale the first time
 * someone adds a package. This walks packages/ instead, so a new package
 * is built the moment it has a build script — nobody has to add it here.
 *
 * Order: a short bootstrap list (the dists core's own tsc reads), then
 * core, then every remaining package in DEPENDENCY order — derived from
 * the `file:` @fezchat/* deps each package.json already declares, not
 * from a list anyone maintains.
 *
 * It used to be alphabetical, on the reasoning that alphabetical "happens
 * to put every dependency ahead of its dependents today" and that a
 * regression would surface as a loud error. It did go stale, twice at
 * once (fez-elevenlabs → fez-media, fez-ridges → fez-wallet), and the
 * error was loud but only on a CLEAN tree: any machine with a stale dist/
 * from a previous build resolved the import and passed, so the break was
 * invisible exactly where people work and fatal exactly where releases
 * are cut. Sorting by the declared graph removes the coincidence.
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGES = join(ROOT, "packages");

function run(label, command, cwd) {
  process.stdout.write(`  ${label.padEnd(22)}`);
  const started = Date.now();
  try {
    execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    // The whole point is that a failure here is impossible to miss.
    process.stdout.write("FAILED\n\n");
    process.stderr.write(String(err.stdout ?? "") + String(err.stderr ?? "") + "\n");
    process.stderr.write(`✗ ${label} failed — nothing downstream was built.\n`);
    process.exit(1);
  }
  process.stdout.write(`ok ${Date.now() - started}ms\n`);
}

console.log("\nbuilding fez\n");

// Bootstrap order, the part alphabetical discovery can't know: the root
// tsc type-checks src that imports these packages' dists (src/cli/tui.ts
// → fez-client, fez-tui), so on a fresh clone "core first" deadlocks —
// core needs dists that only exist after the packages build. This list
// used to live only in ci.yml's Build step, which meant GitHub's runners
// could build from nothing and a fresh local checkout could not. One
// recipe, both places: ci.yml now just runs this script.
// fez-tailwind-preset and fez-ui are core-independent tsc builds with no
// dependency on the pair above, but fez-desktop (which sorts before both
// alphabetically) now depends on their dists, so they must build first too.
// fez-relay is deliberately NOT here: it is a dependENT, not a dependency.
// Core imports nothing from it (only comments name it), while its
// scheduler imports parseSealed from @fezchat/protocol — which resolves
// through the file: symlink to the ROOT package.json, whose types point
// at a dist/ that does not exist until core builds. Listing it here made
// every from-nothing build fail at TS2307 while incremental rebuilds on a
// machine with a stale dist/ passed, so the break only ever showed up on
// a clean runner. It builds in the alphabetical pass below, after core.
const BOOTSTRAP = ["fez-tui", "fez-client", "fez-tailwind-preset", "fez-ui"];
const built = [];
for (const name of BOOTSTRAP) {
  run(name, "npm run build", join(PACKAGES, name));
  built.push(name);
}

run("core", "tsc && chmod +x dist/cli.js", ROOT);

// The remaining packages, in dependency order. The graph is the one each
// package.json already declares: `"@fezchat/media": "file:../fez-media"`
// names the directory outright, so nothing here has to guess a directory
// from a scope name. Edges to core (`file:../..`) and to BOOTSTRAP names
// are dropped — those are already built.
const buildable = new Map(); // dir name -> set of package dirs it needs
for (const name of readdirSync(PACKAGES).sort()) {
  if (BOOTSTRAP.includes(name)) continue; // built above, ahead of core
  const manifest = join(PACKAGES, name, "package.json");
  if (!existsSync(manifest)) continue;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifest, "utf-8"));
  } catch {
    console.error(`✗ ${name}/package.json is not readable JSON`);
    process.exit(1);
  }
  if (!pkg.scripts?.build) continue; // fez-evals and claude-code have nothing to build
  buildable.set(name, pkg);
}

function fezDeps(pkg) {
  const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const needs = new Set();
  for (const [dep, spec] of Object.entries(all)) {
    if (!dep.startsWith("@fezchat/") || typeof spec !== "string") continue;
    if (!spec.startsWith("file:")) continue;
    const dir = spec.slice("file:".length).replace(/\/+$/, "").split("/").pop();
    // `file:../..` → the root package (core), already built.
    if (!dir || dir === ".." || !buildable.has(dir)) continue;
    needs.add(dir);
  }
  return needs;
}

const pending = new Map([...buildable].map(([name, pkg]) => [name, fezDeps(pkg)]));
const done = new Set();
while (pending.size > 0) {
  // Alphabetical within each ready batch, so the order stays deterministic
  // and diffable rather than depending on Map insertion accidents.
  const ready = [...pending.keys()].filter((n) => [...pending.get(n)].every((d) => done.has(d))).sort();
  if (ready.length === 0) {
    // A cycle can't be built in any order — say which packages, loudly,
    // instead of picking one arbitrarily and failing further downstream.
    const stuck = [...pending.keys()].sort().join(", ");
    console.error(`\n✗ dependency cycle among: ${stuck}`);
    process.exit(1);
  }
  for (const name of ready) {
    run(name, "npm run build", join(PACKAGES, name));
    built.push(name);
    done.add(name);
    pending.delete(name);
  }
}

console.log(`\n✓ core + ${built.length} packages\n`);
