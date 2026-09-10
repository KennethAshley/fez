import { beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDescriptors } from "../src/descriptors.js";
import { runMiner } from "../src/run.js";
import { readState, upsertMiner, writeState } from "../src/state.js";

const execFileAsync = promisify(execFile);
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

describe("bin entry", () => {
  // installBins copies dist/run.js to a canonical file RENAMED to the bin
  // key (no .js extension) and symlinks ~/.fez/bin to it — so the built
  // file is named "fez-mine-run" here, not "run.js". The executable
  // entry is separate from the runner library so bundling that library
  // into the CLI never starts a second main function.
  let binPath: string;

  beforeAll(async () => {
    const esbuild = await import("esbuild");
    const outDir = mkdtempSync(path.join(tmpdir(), "fez-mine-build-"));
    binPath = path.join(outDir, "fez-mine-run");
    await esbuild.build({
      entryPoints: [path.join(__dirname, "..", "src", "run-main.ts")],
      bundle: true,
      format: "esm",
      platform: "node",
      banner: { js: "import{createRequire as ___cr}from'module';const require=___cr(import.meta.url);" },
      outfile: binPath,
    });
  });

  it("shebang survives the build", async () => {
    const first = (await import("node:fs")).readFileSync(binPath, "utf8").split("\n")[0];
    expect(first).toBe("#!/usr/bin/env node");
  });

  it("exits 2 with a usage message when called with no args", async () => {
    await expect(execFileAsync("node", [binPath])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("usage: fez-mine-run"),
    });
  });

  it("invokes the runner when called with args, via the renamed (no-extension) file", async () => {
    const home = homeWithFixture();
    await writeState(home, upsertMiner({ miners: [], subnets: [], covered: [] }, {
      netuid: 9999,
      persona: "testp",
      hotkey: "5FAKE",
      desired: "running",
    }));
    const { stdout } = await execFileAsync("node", [binPath, "9999", "testp"], {
      env: { ...process.env, FEZ_MINE_HOME: home },
    });
    expect(stdout).toContain("beating");
    const wd = path.join(home, "mining", "9999-testp");
    expect(existsSync(path.join(wd, "heartbeat"))).toBe(true);
  });
});
