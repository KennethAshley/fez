import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../../..");
function link(pkgDir: string, home: string) {
  return spawnSync(process.execPath, [path.join(repo, "dist/cli.js"), "link", pkgDir, "--no-build"], {
    cwd: repo,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir() },
    encoding: "utf8",
    timeout: 20_000,
  });
}

test("relinking a legacy installation refuses before creating a second identity", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fez-link-legacy-"));
  try {
    const home = path.join(tmp, "home");
    const root = path.join(home, ".fez");
    const pkgDir = path.join(tmp, "fez-wallet");
    const manifest = { name: "@fezchat/wallet", fez: { parts: { skill: { command: "node", args: [] } } } };
    fs.mkdirSync(pkgDir);
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(manifest));
    const installed = path.join(root, "packages", "fez-wallet");
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify(manifest));
    const settings = JSON.stringify({ mcpServers: { "fez-wallet": { command: "node", env: { KEEP: "existing" } } } });
    fs.writeFileSync(path.join(root, "settings.json"), settings);
    fs.mkdirSync(path.join(root, "extension-data"));
    const mirror = '{"prefs":{"network":"testnet"}}';
    fs.writeFileSync(path.join(root, "extension-data", "fez-wallet.json"), mirror);

    const result = link(pkgDir, home);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/already installed as fez-wallet.*consolidate.*wallet/i);
    expect(fs.readdirSync(path.join(root, "packages"))).toEqual(["fez-wallet"]);
    expect(fs.readFileSync(path.join(root, "settings.json"), "utf8")).toBe(settings);
    expect(fs.readdirSync(path.join(root, "extension-data"))).toEqual(["fez-wallet.json"]);
    expect(fs.readFileSync(path.join(root, "extension-data", "fez-wallet.json"), "utf8")).toBe(mirror);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("linking a development checkout reuses the installed package's name on every surface", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fez-link-name-"));
  try {
    const home = path.join(tmp, "home");
    const root = path.join(home, ".fez");
    const pkgDir = path.join(tmp, "fez-wallet");
    const manifest = {
      name: "@fezchat/wallet", version: "0.1.13", type: "module",
      bin: { "fez-wallet": "dist/cli.js" },
      fez: {
        permissions: ["ui", "processes"],
        parts: {
          gui: "dist/gui.js", headless: "dist/headless.js", relay: "dist/relay.js",
          workspace: "dist/workspace.js", miner: "dist/miner.js", background: true,
          skill: { command: "node", args: ["dist/mcp.js"] },
        },
      },
    };
    fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(manifest));
    for (const file of ["gui", "headless", "relay", "workspace", "miner", "mcp", "cli"]) {
      fs.writeFileSync(path.join(pkgDir, "dist", file + ".js"), "export default () => {};\n");
    }
    fs.mkdirSync(path.join(root, "packages", "wallet", "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages", "wallet", "package.json"), JSON.stringify(manifest));
    fs.writeFileSync(path.join(root, "packages", "wallet", "dist", "gui.js"), "// installed GUI\n");
    fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({
      mcpServers: { wallet: { command: "node", args: ["installed.js"], env: { KEEP: "existing" } } },
      extensionPermissions: { wallet: ["ui", "processes"] }, backgroundExtensions: ["wallet"],
    }));

    const result = link(pkgDir, home);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readdirSync(path.join(root, "packages"))).toEqual(["wallet"]);
    expect(fs.readFileSync(path.join(root, "packages", "wallet", "dist", "gui.js"), "utf8"))
      .toBe("export default () => {};\n");
    const settings = JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8"));
    expect(Object.keys(settings.mcpServers)).toEqual(["wallet"]);
    expect(settings.mcpServers.wallet.args).toEqual([path.join(pkgDir, "dist", "mcp.js")]);
    expect(settings.mcpServers.wallet.env).toEqual({ KEEP: "existing" });
    expect(Object.keys(settings.extensionPermissions)).toEqual(["wallet"]);
    expect(settings.backgroundExtensions).toEqual(["wallet"]);
    for (const dir of ["extensions", "relay-extensions", "workspace-providers", "miners"]) {
      expect(fs.readdirSync(path.join(root, dir))).toEqual(["wallet.js"]);
    }
    expect(fs.realpathSync(path.join(root, "bin", "fez-wallet"))).toBe(fs.realpathSync(path.join(pkgDir, "dist", "cli.js")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test.each(["../../escape", "@fezchat/../escape"])("link refuses unsafe manifest name %s before writing settings or packages", (name) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fez-link-invalid-name-"));
  try {
    const home = path.join(tmp, "home");
    const pkgDir = path.join(tmp, "safe-folder");
    fs.mkdirSync(pkgDir);
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({
      name, fez: { parts: { skill: { command: "node", args: [] } } },
    }));
    const result = link(pkgDir, home);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/invalid.*package name/i);
    expect(fs.existsSync(path.join(home, ".fez"))).toBe(false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
