import { describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDescriptors } from "../src/descriptors.js";
import { runMiner } from "../src/run.js";
import { readState } from "../src/state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function homeWithFixture(): string {
  const home = mkdtempSync(path.join(tmpdir(), "fez-mine-"));
  mkdirSync(path.join(home, "miners"), { recursive: true });
  cpSync(path.join(__dirname, "fixtures", "heartbeat-miner.js"), path.join(home, "miners", "heartbeat.js"));
  return home;
}

describe("runner", () => {
  it("loads descriptors from the miners dir", async () => {
    const ds = await loadDescriptors(homeWithFixture());
    expect(ds.map((d) => d.netuid)).toEqual([9999]);
  });
  it("install → register-once → start, with state and workdir evidence", async () => {
    const home = homeWithFixture();
    const code = await runMiner(9999, "testp", home, { hotkey: "5FAKE" });
    expect(code).toBe(0);
    const wd = path.join(home, "mining", "9999-testp");
    expect(existsSync(path.join(wd, "installed"))).toBe(true);
    expect(existsSync(path.join(wd, "enrolled"))).toBe(true);
    expect(existsSync(path.join(wd, "heartbeat"))).toBe(true);
    const s = await readState(home);
    expect(s.miners[0].lastExit).toContain("exit 0");
    // register() must not run twice
    await runMiner(9999, "testp", home, { hotkey: "5FAKE" });
    expect((await import("node:fs")).readFileSync(path.join(wd, "enrolled"), "utf8")).toBe("5FAKE");
  });
});
