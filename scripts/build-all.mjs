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
 * Order: the root first (packages import @fezchat/protocol from its dist),
 * then packages alphabetically, which happens to put every dependency
 * ahead of its dependents today (fez-client before fez-desktop). If that
 * ever stops being true, the failure is a loud missing-types error, not
 * a silent stale artifact — which is the property that matters.
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
run("core", "tsc && chmod +x dist/cli.js", ROOT);

const built = [];
for (const name of readdirSync(PACKAGES).sort()) {
  const manifest = join(PACKAGES, name, "package.json");
  if (!existsSync(manifest)) continue;
  let build;
  try {
    build = JSON.parse(readFileSync(manifest, "utf-8")).scripts?.build;
  } catch {
    console.error(`✗ ${name}/package.json is not readable JSON`);
    process.exit(1);
  }
  if (!build) continue; // fez-evals and claude-code have nothing to build
  run(name, "npm run build", join(PACKAGES, name));
  built.push(name);
}

console.log(`\n✓ core + ${built.length} packages\n`);
