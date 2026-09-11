import { it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

it.skipIf(process.platform !== "darwin").each([
  "isolated_panel::tests",
  "package_install::tests::gui_parts_preserves_runtime_selection_and_marks_invalid_declarations",
])("isolated panel native boundary: %s", async filter => {
  await promisify(execFile)("cargo", [
    "test", "--manifest-path", fileURLToPath(new URL("../../fez-desktop/src-tauri/Cargo.toml", import.meta.url)),
    "--lib", filter,
  ], { timeout: 110_000, maxBuffer: 1024 * 1024 });
}, 120_000);
