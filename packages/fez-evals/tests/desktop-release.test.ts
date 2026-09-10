import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

const desktop = path.resolve(import.meta.dirname, "../../fez-desktop");

test("release cache selects the exact runtime version so overlapping releases cannot replace it", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fez-release-cache-"));
  try {
    const workflow = fs.readFileSync(path.resolve(desktop, "../../.github/workflows/release.yml"), "utf8");
    const run = workflow.match(/- name: Seed bundled agent from cache release[\s\S]*?run: \|\n([\s\S]*?)\n {6}- name:/)![1].replace(/^ {10}/gm, "");
    const prepare = fs.readFileSync(path.join(desktop, "scripts/prepare-pi-agent.mjs"), "utf8");
    const pi = prepare.match(/const PI_VERSION = "([^"]+)"/)![1];
    const version = `${pi}+${prepare.match(/PI_VERSION\}\+(svc\d+)/)![1]}`;
    const scripts = path.join(tmp, "packages/fez-desktop/scripts");
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, "prepare-pi-agent.mjs"), prepare);
    fs.mkdirSync(path.join(tmp, "packages/fez-desktop/src-tauri"));
    const seed = path.join(tmp, "pi-agent"); fs.mkdirSync(seed);
    fs.writeFileSync(path.join(seed, "VERSION"), version);
    for (const name of ["pi", "fez-relay"]) fs.writeFileSync(path.join(seed, name), "#!/bin/sh\n", { mode: 0o755 });
    const archive = path.join(tmp, "seed.tar.gz");
    expect(spawnSync("tar", ["-czf", archive, "-C", tmp, "pi-agent"]).status).toBe(0);
    const bin = path.join(tmp, "bin"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "gh"), `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
if (args[2] !== ${JSON.stringify(`pi-agent-v${pi}`)} || args[args.indexOf('--pattern') + 1] !== ${JSON.stringify(`pi-agent-macos-arm64-${version}.tar.gz`)}) process.exit(1);
fs.copyFileSync(${JSON.stringify(archive)}, args[args.indexOf('--output') + 1]);
`, { mode: 0o755 });
    const result = spawnSync("bash", ["-e", "-c", run.replaceAll("/tmp/pi-agent.tar.gz", path.join(tmp, "download.tar.gz"))], {
      cwd: tmp, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8", timeout: 10_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(tmp, "packages/fez-desktop/src-tauri/pi-agent/VERSION"), "utf8")).toBe(version);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

function release(visibility = "PUBLIC", failUpload = false) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fez-public-release-"));
  const scripts = path.join(tmp, "scripts");
  fs.mkdirSync(scripts);
  fs.mkdirSync(path.join(tmp, "src-tauri"));
  fs.copyFileSync(path.join(desktop, "scripts/release.sh"), path.join(scripts, "release.sh"));
  const config = JSON.parse(fs.readFileSync(path.join(desktop, "src-tauri/tauri.conf.json"), "utf8"));
  fs.writeFileSync(path.join(tmp, "src-tauri/tauri.conf.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(scripts, "build-signed.sh"), 'touch "$FIXTURE/build-ran"\n');
  const bundle = path.join(tmp, "src-tauri/target/release/bundle");
  // A private destination must be refused before a build produces any artifacts.
  if (visibility === "PUBLIC") {
    fs.mkdirSync(path.join(bundle, "dmg"), { recursive: true });
    fs.mkdirSync(path.join(bundle, "macos"));
    fs.writeFileSync(path.join(bundle, "dmg", `fez_${config.version}_aarch64.dmg`), "signed dmg");
    fs.writeFileSync(path.join(bundle, "macos/fez.app.tar.gz"), "signed updater");
    fs.writeFileSync(path.join(bundle, "macos/fez.app.tar.gz.sig"), "fixture-signature\n");
  }
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  // GitHub and the signed build are external boundaries; run the real packaging script.
  fs.writeFileSync(path.join(bin, "gh"), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), root = process.env.FIXTURE;
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(args) + '\\n');
if (args[0] === 'repo') console.log(process.env.VISIBILITY);
if (args[0] === 'release' && args[1] === 'create') {
  if (process.env.FAIL_UPLOAD === '1') process.exit(1);
  fs.mkdirSync(path.join(root, 'uploaded'));
  for (const arg of args) if (fs.existsSync(arg) && fs.statSync(arg).isFile()) {
    fs.copyFileSync(arg, path.join(root, 'uploaded', path.basename(arg)));
  }
}
if (args[0] === 'release' && args[1] === 'view') console.log('https://github.com/KennethAshley/fez-releases/releases/tag/v' + ${JSON.stringify(config.version)});
`, { mode: 0o755 });
  const result = spawnSync("bash", [path.join(scripts, "release.sh")], {
    env: { PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`, HOME: tmp, TMPDIR: tmp,
      FIXTURE: tmp, VISIBILITY: visibility, FAIL_UPLOAD: failUpload ? "1" : "0" },
    encoding: "utf8", timeout: 10_000,
  });
  const callsFile = path.join(tmp, "calls.jsonl");
  const calls: string[][] = fs.existsSync(callsFile)
    ? fs.readFileSync(callsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { tmp, result, calls, version: config.version };
}

test("refuses a private download destination before building or publishing", () => {
  const { tmp, result, calls } = release("PRIVATE");
  try {
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/must be public/i);
    expect(fs.existsSync(path.join(tmp, "build-ran"))).toBe(false);
    expect(calls.some((args) => args[0] === "release")).toBe(false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("publishes only app artifacts with public updater URLs after all uploads succeed", () => {
  const { tmp, result, calls, version } = release();
  try {
    expect(result.status, result.stderr).toBe(0);
    const create = calls.find((args) => args[0] === "release" && args[1] === "create")!;
    expect(create.slice(create.indexOf("--repo"), create.indexOf("--repo") + 2))
      .toEqual(["--repo", "KennethAshley/fez-releases"]);
    expect(create).not.toContain("--draft");
    expect(create).toContain("--latest");
    expect(create).not.toContain("--generate-notes");
    expect(calls.some((args) => args[1] === "edit")).toBe(false);
    expect(fs.readdirSync(path.join(tmp, "uploaded")).sort()).toEqual([
      "fez-macos-arm64.dmg", `fez_${version}_aarch64.app.tar.gz`, `fez_${version}_aarch64.dmg`, "latest.json",
    ].sort());
    const feed = JSON.parse(fs.readFileSync(path.join(tmp, "uploaded/latest.json"), "utf8"));
    expect(feed.platforms["darwin-aarch64"]).toEqual({
      signature: "fixture-signature",
      url: `https://github.com/KennethAshley/fez-releases/releases/download/v${version}/fez_${version}_aarch64.app.tar.gz`,
    });
    expect(feed.notes).toBe(`https://github.com/KennethAshley/fez-releases/releases/tag/v${version}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("a failed upload never publishes an incomplete update", () => {
  const { tmp, result, calls } = release("PUBLIC", true);
  try {
    expect(result.status).not.toBe(0);
    expect(calls.some((args) => args[1] === "edit")).toBe(false);
    expect(calls.some((args) => args[0] === "release" && args[1] === "view")).toBe(false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
