import { it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

it.skipIf(process.platform !== "darwin")("Always On holds only idle sleep, restores its preference, and releases on off or shutdown", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fez-always-on-eval-"));
  try {
    const binary = path.join(dir, "always-on-test");
    const source = fileURLToPath(new URL("../../fez-desktop/src-tauri/src/always_on.rs", import.meta.url));
    execFileSync("rustc", ["--edition=2021", "--test", source, "-o", binary], { timeout: 30_000, stdio: "pipe" });
    execFileSync(binary, ["--nocapture"], { timeout: 15_000, stdio: "pipe" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 45_000);
