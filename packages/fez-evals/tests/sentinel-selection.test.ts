import { expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@fezchat/protocol", async original => ({
  ...await original<typeof import("@fezchat/protocol")>(),
  loadSettings: () => ({ backgroundExtensions: ["fez-github"] }),
  getKey: () => { throw new Error("must reject before accessing identity"); },
}));

it("rejects a selected extension that is not enabled before starting the daemon", async () => {
  // A running desktop on the developer's machine must not affect this fixture.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fez-sentinel-selection-"));
  const homedir = vi.spyOn(os, "homedir").mockReturnValue(home);
  try {
    const { runSentinel } = await import("../../fez-sentinel/src/index.js");
    await expect(runSentinel(["fez-github", "disabled-extension"]))
      .rejects.toThrow('Background extension "disabled-extension" is not enabled');
  } finally {
    homedir.mockRestore();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
