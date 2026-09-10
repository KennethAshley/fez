import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { miningChannel } from "../../fez-mining/src/workspace.js";
import { ensureMinerThread } from "../../fez-mining/src/thread-store.js";
import { readState, writeState } from "../../fez-mining/src/state.js";
const homes:string[]=[];
afterEach(async()=>{await Promise.all(homes.splice(0).map(p=>fs.rm(p,{recursive:true,force:true})));});
async function fixture() {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"mining-workspace-"));homes.push(home);
  await writeState(home,{miners:[{netuid:155,persona:"scout",hotkey:"public",desired:"stopped",threadRootId:"legacy"}],subnets:[],covered:[]});
  return home;
}
describe("Mining workspace binding and threads",()=>{
  it("requires explicit binding, retains renamed ID, ignores archived bindings",()=>{
    expect(miningChannel([{id:"legacy",name:"mining",source:"mining"}])).toBeUndefined();
    const bound={id:"stable",name:"operations",meta:{miningWorkspace:"true"}};
    expect(miningChannel([{id:"other",name:"mining"},bound])).toEqual(bound);
    expect(miningChannel([{...bound,archived:true}])).toBeUndefined();
  });
  it("validates a legacy root against the target channel and reuses the recorded root",async()=>{
    const home=await fixture();
    const io={find:vi.fn(async()=>"legacy"),post:vi.fn(async()=>"new")};
    expect(await ensureMinerThread(home,155,"scout","channel",io)).toBe("legacy");
    expect(io.find).toHaveBeenCalledWith("scout","channel","⛏ mining · netuid 155 · persona scout","legacy");
    expect(io.post).not.toHaveBeenCalled();
    expect((await readState(home)).miners[0]).toMatchObject({desired:"stopped",threadChannelId:"channel",threadRootId:"legacy"});
    expect(await ensureMinerThread(home,155,"scout","channel",io)).toBe("legacy");
    expect(io.find).toHaveBeenCalledTimes(1);
  });
  it("posts as the persona and leaves state unchanged on transport failure",async()=>{
    const home=await fixture();
    const io={find:vi.fn(async()=>undefined),post:vi.fn(async()=>{throw Error("offline");})};
    await expect(ensureMinerThread(home,155,"scout","another",io)).rejects.toThrow("offline");
    expect((await readState(home)).miners[0].threadChannelId).toBeUndefined();
    const post=vi.fn(async()=>"new");
    expect(await ensureMinerThread(home,155,"scout","another",{find:io.find,post})).toBe("new");
    expect(post).toHaveBeenCalledWith("scout","another","⛏ mining · netuid 155 · persona scout");
  });
  it("does not reuse a same-named channel root from another workspace",async()=>{
    const home=await fixture();
    const find=vi.fn(async()=>undefined),post=vi.fn(async()=>"other-root");
    const io={find,post};
    await ensureMinerThread(home,155,"scout","same-id",io,"ws://127.0.0.1:7777");
    await ensureMinerThread(home,155,"scout","same-id",io,"ws://127.0.0.1:7778");
    expect(find).toHaveBeenLastCalledWith("scout","same-id","⛏ mining · netuid 155 · persona scout","other-root","ws://127.0.0.1:7778");
    expect(post).toHaveBeenLastCalledWith("scout","same-id","⛏ mining · netuid 155 · persona scout",{relays:["ws://127.0.0.1:7778"]});
    expect((await readState(home)).miners[0].threadRelay).toBe("ws://127.0.0.1:7778");
  });
  it.each([
    { label: "different channels", relayA: "ws://127.0.0.1:7777", channelA: "A", relayB: "ws://127.0.0.1:7777", channelB: "B" },
    { label: "the same channel ID on different relays", relayA: "ws://127.0.0.1:7777", channelA: "A", relayB: "ws://127.0.0.1:7778", channelB: "A" },
    { label: "a legacy default relay and an explicit relay", relayA: undefined, channelA: "A", relayB: "ws://127.0.0.1:7777", channelB: "A" },
  ])("reuses A → B → A across $label without history queries or posts on return", async ({ relayA, channelA, relayB, channelB }) => {
    const home = await fixture();
    const state = await readState(home);
    await writeState(home, { ...state, miners: [{ ...state.miners[0], threadRootId: "root-A", threadChannelId: channelA, threadRelay: relayA }] });
    const io = { find: vi.fn(async (): Promise<string | undefined> => undefined), post: vi.fn(async () => "root-B") };
    expect(await ensureMinerThread(home, 155, "scout", channelA, io, relayA)).toBe("root-A");
    expect(io.find).not.toHaveBeenCalled();
    expect(await ensureMinerThread(home, 155, "scout", channelB, io, relayB)).toBe("root-B");
    expect(io.post).toHaveBeenCalledTimes(1);
    const expectedRoots = {
      [JSON.stringify([relayA ?? null, channelA])]: "root-A",
      [JSON.stringify([relayB ?? null, channelB])]: "root-B",
    };
    // No relay recovery can help: this covers roots outside the latest 500
    // posts and proves reuse comes from persisted scope state.
    io.find.mockImplementation(async () => { throw Error("history unavailable"); });
    io.post.mockImplementation(async () => { throw Error("must not post another root"); });
    expect(await ensureMinerThread(home, 155, "scout", channelA, io, relayA)).toBe("root-A");
    const restored = (await readState(home)).miners[0];
    expect(restored).toMatchObject({ threadRootId: "root-A", threadChannelId: channelA, threadRoots: expectedRoots });
    expect(restored.threadRelay).toBe(relayA);
    expect(await ensureMinerThread(home, 155, "scout", channelB, io, relayB)).toBe("root-B");
    expect((await readState(home)).miners[0].threadRoots).toEqual(expectedRoots);
    expect(io.find).toHaveBeenCalledTimes(1);
    expect(io.post).toHaveBeenCalledTimes(1);
  });
  it("carries saved roots through the real start command using fixture wallet and runner binaries", async () => {
    const home = await fixture();
    const state = await readState(home);
    const threadRoots = { [JSON.stringify(["ws://127.0.0.1:7777", "A"])]: "root-A", [JSON.stringify(["ws://127.0.0.1:7778", "B"])]: "root-B" };
    await writeState(home, { ...state, miners: [{ ...state.miners[0], threadRootId: "root-B", threadChannelId: "B", threadRelay: "ws://127.0.0.1:7778", threadRoots }] });
    await fs.mkdir(path.join(home, "miners"));
    await fs.writeFile(path.join(home, "miners", "fixture.js"), "export default [{ netuid: 155, name: 'Fixture', network: 'test' }];");
    const wallet = path.join(home, "wallet");
    await fs.writeFile(wallet, `#!/usr/bin/env node
const cmd = process.argv[2];
if (cmd === 'network') console.log('network: test\\nendpoint: ws://127.0.0.1:1');
else if (cmd === 'cost') console.log(JSON.stringify({tao:'0'}));
else if (cmd === 'register') console.log(JSON.stringify({persona:'scout',netuid:155,uid:1,hotkey:'fixture-public'}));
else process.exit(1);
`, { mode: 0o700 });
    const runner = path.join(home, "runner");
    await fs.writeFile(runner, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const cli = path.join(home, "cli.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../../fez-mining/src/cli.ts", import.meta.url))], outfile: cli,
      bundle: true, format: "esm", platform: "node",
      banner: { js: "import{createRequire as ___threadFixtureRequire}from'node:module';const require=___threadFixtureRequire(import.meta.url);" },
    });
    const result = spawnSync(process.execPath, [cli, "start", "--netuid", "155", "--persona", "scout", "--json"], {
      env: { ...process.env, FEZ_MINE_HOME: home, FEZ_WALLET_BIN: wallet, FEZ_MINE_RUN_BIN: runner }, encoding: "utf8", timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect((await readState(home)).miners[0]).toMatchObject({ desired: "running", hotkey: "fixture-public", threadRoots, threadRootId: "root-B", threadChannelId: "B", threadRelay: "ws://127.0.0.1:7778" });
  });
  it("serializes GUI and background root creation",async()=>{
    const home=await fixture();
    let release!:()=>void;let began!:()=>void;
    const entered=new Promise<void>(r=>{began=r;});
    const hold=new Promise<void>(r=>{release=r;});
    const io={find:vi.fn(async()=>{began();await hold;return undefined;}),post:vi.fn(async()=>"only-root")};
    const first=ensureMinerThread(home,155,"scout","channel",io);
    await entered;
    await expect(ensureMinerThread(home,155,"scout","channel",io)).rejects.toThrow("being opened");
    release();await first;
    expect(io.post).toHaveBeenCalledTimes(1);
    expect(await ensureMinerThread(home,155,"scout","channel",io)).toBe("only-root");
  });
});
