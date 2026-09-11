import { afterEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerServiceCommands } from "../../../src/cli/cmd-services.js";

vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it.skipIf(process.platform !== "darwin").each([undefined, "fez-github"])(
  "installs automatic startup with extension selection %s", async selection => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fez-service & test-"));
    dirs.push(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command().exitOverride();
    registerServiceCommands(program);
    await program.parseAsync(["sentinel-install", ...(selection ? ["--extensions", ` ${selection} `] : [])], { from: "user" });
    const plistPath = path.join(home, "Library/LaunchAgents/com.fez.sentinel.plist");
    const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const plist = JSON.parse(real.execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath], { encoding: "utf8" }));
    expect(plist.ProgramArguments.slice(2)).toEqual(["sentinel", ...(selection ? ["--extensions", selection] : [])]);
    expect(plist.EnvironmentVariables.HOME).toBe(home);
    expect(plist.EnvironmentVariables).not.toHaveProperty("FEZ_RELAY");
    expect(plist.RunAtLoad).toBe(true);
    expect(plist.KeepAlive).toBe(true);
    const { execFileSync } = await import("node:child_process");
    expect(execFileSync).toHaveBeenCalledWith("launchctl", ["bootstrap", `gui/${process.getuid!()}`, plistPath]);
  }
);

it.skipIf(process.platform !== "darwin")("unloads the service before removing a plist under a home with spaces", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fez-service & remove-"));
  dirs.push(home);
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const plistPath = path.join(home, "Library/LaunchAgents/com.fez.sentinel.plist");
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, "installed");
  const { execFileSync } = await import("node:child_process");
  let existedWhenUnloaded = false;
  vi.mocked(execFileSync).mockImplementationOnce(() => {
    existedWhenUnloaded = fs.existsSync(plistPath);
    return Buffer.alloc(0);
  });
  const program = new Command().exitOverride();
  registerServiceCommands(program);
  await program.parseAsync(["sentinel-uninstall"], { from: "user" });
  expect(existedWhenUnloaded).toBe(true);
  expect(execFileSync).toHaveBeenCalledWith("launchctl", ["bootout", `gui/${process.getuid!()}`, plistPath], { stdio: "pipe" });
  expect(fs.existsSync(plistPath)).toBe(false);
});
