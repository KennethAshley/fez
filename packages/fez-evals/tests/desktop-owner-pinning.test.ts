import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserWire } from "../../fez-desktop/src/wire.js";

const owner = "a".repeat(64), stranger = "b".repeat(64);
afterEach(() => vi.unstubAllGlobals());

it("uses the desktop's existing pin and refuses different metadata or a conflicting concurrent first writer", async () => {
  let stored: string | null = owner;
  let competing = false;
  vi.stubGlobal("isTauri", true);
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke: async (_name: string, args: { id: string; value?: string }) => {
    if (stored === null && args.value) stored = competing ? stranger : args.value;
    return stored;
  } } });
  const wire = new BrowserWire(["wss://relay.example"], "1".repeat(64));
  await expect(wire.pinWorkspaceOwner("wss://relay.example", undefined)).resolves.toBe(owner);
  await expect(wire.pinWorkspaceOwner("wss://relay.example", stranger)).rejects.toThrow(/owner/i);
  stored = null; competing = true;
  await expect(wire.pinWorkspaceOwner("wss://relay.example", owner)).rejects.toThrow(/owner/i);
});

it("native pin storage keeps the first complete value and rejects invalid paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-pin-rust-"));
  try {
    const binary = path.join(dir, "pin-test");
    const source = fileURLToPath(new URL("../../fez-desktop/src-tauri/src/workspace_pins.rs", import.meta.url));
    execFileSync("rustc", ["--edition=2021", "--test", source, "-o", binary], { timeout: 30_000, stdio: "pipe" });
    execFileSync(binary, [], { timeout: 15_000, stdio: "pipe" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 45_000);
