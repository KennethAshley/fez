import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readState, writeState, upsertMiner, removeMiner } from "../src/state.js";

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
    let s = { miners: [], subnets: [], covered: [] as number[] };
    s = upsertMiner(s, { netuid: 1, persona: "a", hotkey: "x", desired: "running" });
    s = upsertMiner(s, { netuid: 2, persona: "a", hotkey: "x", desired: "running" });
    s = removeMiner(s, 1, "a");
    expect(s.miners.map((m) => m.netuid)).toEqual([2]);
  });
});
