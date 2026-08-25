#!/usr/bin/env node
/**
 * Produce the bundled Built-in agent (pi + pi-acp + assets) into
 * src-tauri/pi-agent/ so `tauri build` bundles it as a resource and the
 * desktop copies it to ~/.fez/bin on launch (see the bundled-pi-agent
 * memory). Runs for the CURRENT host: in CI, a per-OS matrix runs this so
 * each platform's app carries its own binaries (more reliable than one-host
 * cross-compile, which trips over pi's native deps).
 *
 * Steps: build `pi` from pinned source with `bun --compile`, compile the
 * `pi-acp` adapter from its pinned npm package, compile `fez-relay` from
 * the monorepo (the local-workspace relay — cold-start spec), copy pi's
 * required runtime assets (theme JSONs, image wasm), stamp VERSION. Version-gated: a no-op
 * once pi-agent/VERSION already matches (FORCE=1 to rebuild).
 *
 * Graceful when bun is absent (a plain dev machine): it still creates
 * pi-agent/ with a VERSION marker so the tauri resource path resolves, just
 * without binaries — the app then falls back to a system `pi` if present.
 * Set REQUIRE_PI_AGENT=1 (CI release builds) to hard-fail instead.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Versions we ship. Bump together with a tested pair.
const PI_VERSION = "0.84.2"; // @earendil-works/pi-coding-agent
const PI_ACP_VERSION = "0.0.33"; // pi-acp (the ACP↔pi-rpc bridge)
const CLAUDE_ACP_VERSION = "0.70.0"; // @agentclientprotocol/claude-agent-acp (the ACP↔claude-cli bridge)
// The bundle's identity: any shipped binary changing must change this
// string, or installed apps skip the recopy.
const BUNDLE_VERSION = `${PI_VERSION}+claude-acp${CLAUDE_ACP_VERSION}`;
const PI_REPO = "https://github.com/earendil-works/pi.git";
// Pin a tag or commit SHA for reproducibility. Defaults to the release
// tag matching PI_VERSION (the version check below still guards a tag
// that lies); override with PI_REF for a branch/SHA build.
const PI_REF = process.env.PI_REF || `v${PI_VERSION}`;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "..", "src-tauri", "pi-agent");
const WORK = path.join(os.tmpdir(), "fez-pi-agent-build");
const EXE = process.platform === "win32" ? ".exe" : "";

const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit" });
const hasBun = () => {
  try {
    execSync("bun --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const copyExec = (src, dst) => {
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o755);
};

fs.mkdirSync(OUT, { recursive: true });
const marker = path.join(OUT, "VERSION");

// Version gate. fez-relay's existence is part of the gate: a build made
// before the relay joined the bundle must not skip past adding it.
if (
  !process.env.FORCE &&
  fs.existsSync(path.join(OUT, `pi${EXE}`)) &&
  fs.existsSync(path.join(OUT, `fez-relay${EXE}`)) &&
  fs.existsSync(path.join(OUT, `claude-agent-acp${EXE}`)) &&
  fs.readFileSync(marker, "utf8").trim() === BUNDLE_VERSION
) {
  console.log(`pi-agent already at ${BUNDLE_VERSION} — skipping (FORCE=1 to rebuild)`);
  process.exit(0);
}

if (!hasBun()) {
  const msg = "bun not found — cannot build the bundled agent (install: curl -fsSL https://bun.sh/install | bash)";
  if (process.env.REQUIRE_PI_AGENT) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  // Leave a marker so the tauri resource path still resolves; the app
  // falls back to a system pi at runtime.
  fs.writeFileSync(marker, "none\n");
  console.warn(`⚠ ${msg} — building WITHOUT a bundled agent (falls back to system pi).`);
  process.exit(0);
}

fs.mkdirSync(WORK, { recursive: true });

// Per-artifact reuse: a binary already in OUT is kept unless FORCE_ALL.
// Upstream pi ships no lockfile, so a fresh-cache source build can drift
// and fail — adding one NEW binary to the bundle must not require
// rebuilding the three that already work. FORCE=1 re-runs the assembly;
// FORCE_ALL=1 rebuilds every binary from scratch.
const reuse = (name) => !process.env.FORCE_ALL && fs.existsSync(path.join(OUT, `${name}${EXE}`));

// 1. pi — build from pinned source (bun --compile, host target).
let codingAgent;
if (reuse("pi")) {
  console.log(`\n▶ pi: reusing existing binary (FORCE_ALL=1 to rebuild)`);
} else {
  console.log(`\n▶ building pi ${PI_VERSION} from source…`);
  const piSrc = path.join(WORK, "pi");
  if (!fs.existsSync(piSrc)) run(`git clone --depth 1 ${PI_REF ? `--branch ${PI_REF} ` : ""}${PI_REPO} pi`, WORK);
  codingAgent = path.join(piSrc, "packages", "coding-agent");
  const got = JSON.parse(fs.readFileSync(path.join(codingAgent, "package.json"), "utf8")).version;
  if (got !== PI_VERSION) throw new Error(`pi source is ${got}, expected ${PI_VERSION} — set PI_REF to a matching tag/SHA`);
  run("bun install", piSrc);
  run("npm run build:binary", codingAgent); // → dist/pi (+ copy-binary-assets)
}

// 2. pi-acp — compile the pinned npm package's bundle.
if (reuse("pi-acp")) {
  console.log(`\n▶ pi-acp: reusing existing binary`);
} else {
  console.log(`\n▶ compiling pi-acp ${PI_ACP_VERSION}…`);
  const acpPkg = path.join(WORK, "pi-acp-pkg");
  fs.mkdirSync(acpPkg, { recursive: true });
  fs.writeFileSync(path.join(acpPkg, "package.json"), JSON.stringify({ name: "fez-pi-acp-build", private: true }));
  run(`npm install pi-acp@${PI_ACP_VERSION} --no-save --no-fund --no-audit`, acpPkg);
  const acpEntry = path.join(acpPkg, "node_modules", "pi-acp", "dist", "index.js");
  run(`bun build --compile ${JSON.stringify(acpEntry)} --outfile ${JSON.stringify(path.join(WORK, "pi-acp"))}`, WORK);
}

// 2b. claude-agent-acp — the ACP↔claude-CLI bridge, compiled the same
// way. Bundling it collapses Buzz's two-axis problem (CLI × adapter) to
// one honest question: is the \`claude\` CLI on this machine? A user who
// installed Claude Code should never be told "not detected" because an
// npm package THEY'VE never heard of is missing — the adapter is fez's
// plumbing, so fez ships it.
console.log(`\n▶ compiling claude-agent-acp ${CLAUDE_ACP_VERSION}…`);
if (!reuse("claude-agent-acp")) {
  const clacpPkg = path.join(WORK, "claude-acp-pkg");
  fs.mkdirSync(clacpPkg, { recursive: true });
  fs.writeFileSync(path.join(clacpPkg, "package.json"), JSON.stringify({ name: "fez-claude-acp-build", private: true }));
  run(`npm install @agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_VERSION} --no-save --no-fund --no-audit`, clacpPkg);
  const clacpEntry = path.join(clacpPkg, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
  run(`bun build --compile ${JSON.stringify(clacpEntry)} --outfile ${JSON.stringify(path.join(WORK, "claude-agent-acp"))}`, WORK);
} else {
  console.log("  (reusing existing binary)");
}

// 3. fez-relay — the local-workspace relay, compiled from the monorepo
// source (ws + nostr-tools only, no native deps) so the DMG can spawn a
// user-owned workspace with no install. See the cold-start spec.
console.log(`\n▶ compiling fez-relay…`);
if (!reuse("fez-relay")) {
  const relayPkg = path.resolve(HERE, "..", "..", "fez-relay");
  run(
    `bun build --compile ${JSON.stringify(path.join(relayPkg, "src", "cli.ts"))} --outfile ${JSON.stringify(path.join(WORK, `fez-relay${EXE}`))}`,
    relayPkg
  );
} else {
  console.log("  (reusing existing binary)");
}

// 4. Assemble pi-agent/ — binaries + required assets + VERSION.
console.log(`\n▶ assembling ${path.relative(path.resolve(HERE, "..", ".."), OUT)}…`);
const stage = path.join(WORK, "stage");
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, "theme"), { recursive: true });
const from = (name) => (reuse(name) ? path.join(OUT, `${name}${EXE}`) : undefined);
copyExec(from("pi") ?? path.join(codingAgent, "dist", `pi${EXE}`), path.join(stage, `pi${EXE}`));
copyExec(from("pi-acp") ?? path.join(WORK, `pi-acp${EXE}`), path.join(stage, `pi-acp${EXE}`));
copyExec(from("fez-relay") ?? path.join(WORK, `fez-relay${EXE}`), path.join(stage, `fez-relay${EXE}`));
copyExec(from("claude-agent-acp") ?? path.join(WORK, `claude-agent-acp${EXE}`), path.join(stage, `claude-agent-acp${EXE}`));
const themeSrc = codingAgent ? path.join(codingAgent, "dist", "theme") : path.join(OUT, "theme");
for (const f of fs.readdirSync(themeSrc)) fs.copyFileSync(path.join(themeSrc, f), path.join(stage, "theme", f));
const wasmSrc = codingAgent ? path.join(codingAgent, "dist", "photon_rs_bg.wasm") : path.join(OUT, "photon_rs_bg.wasm");
if (fs.existsSync(wasmSrc)) fs.copyFileSync(wasmSrc, path.join(stage, "photon_rs_bg.wasm"));
fs.rmSync(OUT, { recursive: true, force: true });
fs.renameSync(stage, OUT);
fs.writeFileSync(marker, `${BUNDLE_VERSION}\n`);

console.log(`\n✓ pi-agent ${PI_VERSION} ready (${(fs.statSync(path.join(OUT, `pi${EXE}`)).size / 1e6).toFixed(0)}MB pi + pi-acp + fez-relay)`);
