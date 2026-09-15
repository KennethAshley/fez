#!/usr/bin/env node
// Real packaged-runtime smoke: public npm deps, packed starter, native WKWebView.
// Requires macOS, Rust/Xcode tools and the repo's installed build dependencies.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw Error("This smoke test requires macOS's native isolated GUI runner.");
const repo = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "fez-gui-starter-"));
const source = join(temp, "starter-probe");
function run(command, args, cwd = repo, capture = false) {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    env: { ...process.env, npm_config_cache: join(temp, "npm-cache") },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal})`);
  return result.stdout;
}

try {
  run("npm", ["run", "build:core"]);
  run(process.execPath, [join(repo, "dist/cli.js"), "create", "starter-probe", "--gui", "--dir", source]);
  // No workspace links: this is what an author outside the private repo installs.
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], source);
  run("npm", ["run", "check"], source);
  run("npm", ["run", "build"], source);
  const [packed] = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json"], source, true));
  const extracted = join(temp, "packed");
  mkdirSync(extracted);
  run("tar", ["-xzf", join(source, packed.filename), "-C", extracted]);
  const desktop = join(repo, "packages/fez-desktop");
  run("npm", ["run", "build"], desktop);
  run("cargo", ["run", "--example", "isolated-custom-probe", "--features", "tauri/custom-protocol", "--", join(extracted, "package")], join(desktop, "src-tauri"));
  console.log("GUI starter PASS: public dependencies, typecheck, npm tarball, native isolated mount and theme CSS.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
