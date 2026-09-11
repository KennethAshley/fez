import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("accepts Gradients text layouts and rejects unsafe paths and invalid rewards", () => {
  const tests = fileURLToPath(new URL("../../fez-gradients/training/tests", import.meta.url));
  const result = spawnSync("python3", ["-m", "unittest", "discover", "-s", tests], { encoding: "utf8", timeout: 10_000 });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
});
