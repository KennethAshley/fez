import { expect, it, vi } from "vitest";

vi.mock("@fezchat/protocol", async original => ({
  ...await original<typeof import("@fezchat/protocol")>(),
  loadSettings: () => ({ backgroundExtensions: ["fez-github"] }),
  getKey: () => { throw new Error("must reject before accessing identity"); },
}));

it("rejects a selected extension that is not enabled before starting the daemon", async () => {
  const { runSentinel } = await import("../../fez-sentinel/src/index.js");
  await expect(runSentinel(["fez-github", "disabled-extension"]))
    .rejects.toThrow('Background extension "disabled-extension" is not enabled');
});
