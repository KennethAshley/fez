import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readState, writeState, upsertMiner, removeMiner, storageName, type MiningState } from "../src/state.js";

const home = () => mkdtempSync(path.join(tmpdir(), "fez-mine-"));

describe("mining state", () => {
  it("round-trips and upserts by (netuid, persona)", async () => {
    const h = home();
    let s = await readState(h);
    expect(s.miners).toEqual([]);
    s = upsertMiner(s, { netuid: 553, persona: "quill", hotkey: "5F...", desired: "running" });
    s = upsertMiner(s, { netuid: 553, persona: "quill", hotkey: "5F...", desired: "stopped" });
    expect(s.miners).toHaveLength(1);
    expect(s.miners[0].desired).toBe("stopped");
    await writeState(h, s);
    expect((await readState(h)).miners[0].netuid).toBe(553);
  });
  it("removes by key and leaves others", async () => {
    let s: MiningState = { miners: [], subnets: [], covered: [] };
    s = upsertMiner(s, { netuid: 1, persona: "a", hotkey: "x", desired: "running" });
    s = upsertMiner(s, { netuid: 2, persona: "a", hotkey: "x", desired: "running" });
    s = removeMiner(s, 1, "a");
    expect(s.miners.map((m) => m.netuid)).toEqual([2]);
  });
});

describe("storageName", () => {
  it("names by the installed package dir under ~/.fez/packages/", () => {
    expect(storageName("/Users/x/.fez/packages/mining/dist/cli.js")).toBe("mining");
  });
  it("names by the repo checkout's package dir when not installed", () => {
    expect(storageName("/Users/x/fez/packages/fez-mining/src/state.ts")).toBe("fez-mining");
    expect(storageName("/Users/x/fez/packages/fez-mining/dist/cli.js")).toBe("fez-mining");
  });
  it("falls back to fez-mining off any recognizable package dir", () => {
    expect(storageName("/tmp/some/random/file.js")).toBe("fez-mining");
  });
});
