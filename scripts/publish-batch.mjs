#!/usr/bin/env node
/**
 * Publish @fezchat/protocol + the installable extensions, in order.
 *
 *   node scripts/publish-batch.mjs --dry     # validate tarballs, publish nothing
 *   node scripts/publish-batch.mjs           # real publish (needs npm auth)
 *
 * For each package: rewrite `file:` @fezchat deps → a real range
 * (prepare-publish), drop `private` so npm will take it, publish public,
 * then `git checkout` the package.json back to its dev state. Protocol
 * goes first so the externalizers' ^range resolves.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DRY = process.argv.includes("--dry");
// npm requires 2FA to publish (E403 without it). --otp=123456 passes the
// authenticator code through to every publish in the run — the codes are
// good for ~30s and the whole batch takes a few, so one code covers it.
const OTP = process.argv.find((a) => a.startsWith("--otp="))?.slice("--otp=".length);
const ROOT = process.cwd();

// protocol is published from the repo root; the rest are package dirs.
// Infra libs first (extensions may externalize @fezchat/client etc.), then
// the installable extensions + agents.
const INFRA = [
  "packages/fez-client",
  "packages/fez-artifact-viewers",
  "packages/fez-relay",
  "packages/fez-tui",
  "packages/fez-theme-fez",
  "packages/fez-acp",
  "packages/fez-herdr",
  "packages/fez-sentinel",
  "packages/fez-orchestrator",
];
const EXTENSIONS = [
  ...INFRA,
  "packages/fez-git",
  "packages/fez-github",
  "packages/fez-kanban",
  "packages/fez-polls",
  "packages/fez-communities",
  "packages/fez-docs",
  "packages/fez-dms",
  "packages/fez-media",
  "packages/fez-moderation",
  "packages/fez-notifications",
  "packages/fez-live-blocks",
  "packages/fez-obsidian",
  "packages/fez-mcp",
  "packages/claude-code",
  // fez-bittensor (the chain-direct discovery skill) superseded the old
  // packages/bittensor miner extension on npm as of 0.2.0.
  "packages/fez-bittensor",
  "packages/fez-chutes",
  "packages/fez-hippius",
  "packages/fez-score-studio",
  "packages/fez-loom",
  "packages/fez-workflows",
  "packages/fez-memory",
  "packages/fez-elevenlabs",
  // Late arrivals the list missed — found by a local-vs-npm version audit
  // after a machine wipe: themes was already in the desktop CATALOG (its
  // gallery entry couldn't install), wallet/ridges shipped the bounty
  // rail. Wallet before ridges: ridges' file: dep rewrites to wallet's
  // published range.
  "packages/fez-themes",
  "packages/fez-wallet",
  "packages/fez-ridges",
];

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd: cwd ?? ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function stripPrivate(dir) {
  const p = path.join(dir, "package.json");
  const d = JSON.parse(readFileSync(p, "utf-8"));
  if (d.private) { delete d.private; writeFileSync(p, JSON.stringify(d, null, 2) + "\n"); }
}

function publishDir(dir, label) {
  // dist/ is already fresh from `npm run build`; --ignore-scripts skips the
  // per-package prepublishOnly rebuild (protocol's is a full build-all).
  const args = ["publish", "--access", "public", "--ignore-scripts"];
  if (OTP) args.push(`--otp=${OTP}`);
  if (DRY) args.push("--dry-run");
  try {
    const out = run("npm", args, dir);
    const name = /name:\s*(\S+)/.exec(out)?.[1] ?? label;
    const ver = /version:\s*(\S+)/.exec(out)?.[1] ?? "?";
    console.log(`  ✓ ${DRY ? "[dry] " : ""}${name}@${ver}`);
    return true;
  } catch (err) {
    const out = (err.stdout ?? "") + "\n" + (err.stderr ?? "");
    // Show the actual error, not the tarball notices that precede it.
    const errLines = out.split("\n").filter((l) => /npm error|npm ERR|forbidden|denied|EOTP|E4\d\d|EPUBLISH|cannot/i.test(l));
    const shown = (errLines.length ? errLines : out.split("\n").filter(Boolean).slice(-6)).slice(0, 8);
    console.error(`  ✗ ${label} FAILED:\n    ${shown.join("\n    ")}`);
    return false;
  }
}

function restore(dir) {
  try { run("git", ["checkout", "--", path.join(dir, "package.json")]); } catch {}
}

let ok = 0, fail = 0;

// Targeted mode: `node scripts/publish-batch.mjs [--dry] packages/fez-kanban …`
// publishes only the named dirs (a republish), skipping protocol + the
// full list. No args → the whole batch.
const targets = process.argv.slice(2).filter((a) => a !== "--dry" && !a.startsWith("--"));
const dirs = targets.length ? targets : EXTENSIONS;

// 1) protocol, from the root — only in a full run
if (!targets.length) {
  console.log(`\n${DRY ? "DRY-RUN" : "PUBLISH"} — @fezchat/protocol (root)`);
  if (publishDir(ROOT, "@fezchat/protocol")) ok++; else fail++;
}

// 2) the extensions (or just the targeted dirs)
console.log(`\n${DRY ? "DRY-RUN" : "PUBLISH"} — ${dirs.length} package(s)`);
for (const dir of dirs) {
  try {
    run("node", ["scripts/prepare-publish.mjs", dir]);
    stripPrivate(dir);
    if (publishDir(dir, dir)) ok++; else fail++;
  } catch (err) {
    console.error(`  ✗ ${dir} prep FAILED: ${err.message}`);
    fail++;
  } finally {
    restore(dir);
  }
}

console.log(`\n${DRY ? "DRY-RUN" : "PUBLISH"} done — ${ok} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
