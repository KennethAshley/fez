import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const run = promisify(execFile);
const core = new URL("../../../dist/index.js", import.meta.url).href;

test.each(["invoke", "openSession"])("%s rejects a missing adapter without crashing its host", async (method) => {
  // Exercise a real ENOENT in a child process: an unhandled spawn error must
  // fail this check, without taking down the rest of the eval runner.
  const script = `
    import cp from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    const spawn = cp.spawn;
    cp.spawn = () => spawn("/nonexistent-fez-test-adapter", [], { stdio: ["pipe", "pipe", "pipe"] });
    syncBuiltinESMExports();
    const { registerBuiltinHarnesses, findHarness } = await import(${JSON.stringify(core)});
    registerBuiltinHarnesses();
    try {
      await findHarness("pi")[${JSON.stringify(method)}]("test");
      process.exitCode = 2;
    } catch (error) {
      if (!/ENOENT/.test(String(error))) throw error;
      console.log("caught missing adapter");
    }
  `;
  const result = await run(process.execPath, ["--input-type=module", "-e", script], { timeout: 5000 });
  expect(result.stdout).toContain("caught missing adapter");
});
