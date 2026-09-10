import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

// Real Rust code and child processes, on macOS and Linux; no Tauri/GUI build.
it.skipIf(process.platform === "win32")("desktop commands bound pipe capture, output and process lifetime", async () => {
  await promisify(execFile)("cargo", [
    "test", "--manifest-path",
    fileURLToPath(new URL("./fixtures/bounded-command/Cargo.toml", import.meta.url)), "--lib",
  ], { timeout: 110_000, maxBuffer: 1024 * 1024 });
}, 120_000);
