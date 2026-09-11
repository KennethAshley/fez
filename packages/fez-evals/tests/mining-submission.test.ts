import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submissionCommand } from "../../fez-mining/src/submission.js";
import { readState, writeState } from "../../fez-mining/src/state.js";
import { planRemote } from "../../fez-mining/src/reconcile.js";
import { lifecycleMessage } from "../../fez-mining/src/lifecycle.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const homes: string[] = [];
afterEach(() => homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })));
function fixture(network = "test") {
  const home = mkdtempSync(join(tmpdir(), "submission-")); homes.push(home);
  mkdirSync(join(home, "miners"));
  writeFileSync(join(home, "miners/job.js"), `export default [{netuid:155,network:'test',name:'Job',submission:{
    status:async ctx=>({hotkey:'5public',phase:'pending',versions:[{id:'v1',name:'baseline',version:0,createdAt:'2026-09-10T00:00:00Z',activatedAt:null}],checkedAt:'2026-09-10T01:00:00Z',detail:'Awaiting activation'}),
    test:async()=>({sha256:'a'.repeat(64),prediction:0.5,detail:'ok'}),
    submit:async()=>{throw Error('do not upload in this test')}
  }}];`);
  const wallet = join(home, "wallet");
  writeFileSync(wallet, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(join(home,"calls"))},JSON.stringify(process.argv.slice(2))+'\\n');console.log('network: ${network}\\nendpoint: wss://test.finney.opentensor.ai:443');`, {mode:0o700});
  return {home,wallet};
}

it("adopts an existing submission without starting a runner, preserving other miners and the thread", async () => {
  const {home,wallet} = fixture();
  const other = {netuid:241,persona:'drift',hotkey:'5other',desired:'running' as const,pid:123};
  await writeState(home,{miners:[other,{netuid:155,persona:'drift',hotkey:'5public',desired:'stopped',threadRootId:'root'}],subnets:[],covered:[]});
  await submissionCommand('status',155,'drift',{},home,wallet);
  const miners=(await readState(home)).miners;
  expect(miners.find(m=>m.netuid===241)).toEqual(other);
  const job=miners.find(m=>m.netuid===155)!;
  expect(job).toMatchObject({mode:'submission',desired:'stopped',threadRootId:'root',submission:{phase:'pending'}});
  expect(job.pid).toBeUndefined();
  // Even corrupted legacy desired-running state must not cause a rental/runner.
  expect(planRemote([{...job,desired:'running'}],()=>false,()=>false,Date.now())).toEqual([]);
  expect(lifecycleMessage(undefined,job)).toContain('Awaiting activation');
  expect(lifecycleMessage(job,job)).toBeNull();
  expect(readFileSync(join(home,'calls'),'utf8')).toBe('["network"]\n');
});

it("rejects mainnet and unsafe persona paths before touching keys or adapter", async () => {
  const {home,wallet}=fixture('finney');
  await expect(submissionCommand('status',155,'drift',{},home,wallet)).rejects.toThrow(/network test/);
  expect(readFileSync(join(home,'calls'),'utf8')).toBe('["network"]\n');
  await expect(submissionCommand('test',155,'../drift',{file:'/tmp/source.py'},home,wallet)).rejects.toThrow(/persona/);
});

it("requires an explicit file and tested content hash before submitting", async () => {
  const {home,wallet}=fixture();
  await expect(submissionCommand('submit',155,'drift',{},home,wallet)).rejects.toThrow(/file/);
  await expect(submissionCommand('submit',155,'drift',{file:'/tmp/agent.py'},home,wallet)).rejects.toThrow(/sha256/);
});

it("the installed CLI refuses start and stop instead of giving submission miners process semantics", () => {
  const {home,wallet}=fixture();
  for (const verb of ['start','stop']) {
    const r=spawnSync(process.execPath,[fileURLToPath(new URL('../../fez-mining/dist/cli.js',import.meta.url)),verb,'--netuid','155','--persona','drift'],{
      env:{...process.env,FEZ_MINE_HOME:home,FEZ_WALLET_BIN:wallet},encoding:'utf8',timeout:10_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/submission|submitted code/);
  }
  expect(() => readFileSync(join(home,'calls'),'utf8')).toThrow();
});

it("explicit registration records the public identity but never key material or a runner", async () => {
  const {home,wallet}=fixture();
  writeFileSync(wallet,`#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(home,'calls'))},JSON.stringify(a)+'\\n');
if(a[0]==='network') console.log('network: test\\nendpoint: wss://test.finney.opentensor.ai:443');
else if(a[0]==='export-hotkey') console.log(JSON.stringify({ss58Address:'5public',keyfile:{secretPhrase:'never-store-this'}}));
else if(a[0]==='register') console.log(JSON.stringify({uid:76,hotkey:'5public'}));
else process.exit(2);`,{mode:0o700});
  await submissionCommand('register',155,'drift',{},home,wallet);
  const s=await readState(home);
  expect(s.miners[0]).toMatchObject({mode:'submission',uid:76,hotkey:'5public',desired:'stopped'});
  expect(JSON.stringify(s)).not.toMatch(/secretPhrase|never-store-this/);
  const calls=readFileSync(join(home,'calls'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
  expect(calls).toEqual([
    ['network'],['export-hotkey','drift','--json'],
    ['register','drift','--netuid','155','--hotkey','5public','--json'],
  ]);
});

it("concurrent adoptions of different personas both persist", async () => {
  const {home,wallet}=fixture();
  await Promise.all(['drift','quill'].map(persona=>submissionCommand('status',155,persona,{},home,wallet)));
  expect((await readState(home)).miners.map(m=>m.persona).sort()).toEqual(['drift','quill']);
});

it("a failed direct refresh retains the successful snapshot and marks it stale", async () => {
  const {home,wallet}=fixture('finney');
  const old={hotkey:'5public',phase:'pending' as const,versions:[],checkedAt:'2026-09-10T00:00:00Z',detail:'saved'};
  await writeState(home,{miners:[{netuid:155,persona:'drift',hotkey:'5public',desired:'stopped',mode:'submission',submission:old}],subnets:[],covered:[]});
  await expect(submissionCommand('status',155,'drift',{},home,wallet)).rejects.toThrow(/network test/);
  const entry=(await readState(home)).miners[0];
  expect(entry.submission).toEqual(old);
  expect(entry.submissionError).toMatch(/network test/);
});

it("CLI consumes file/hash options before positional verbs and rejects missing option values", () => {
  const {home,wallet}=fixture();
  const cli=fileURLToPath(new URL('../../fez-mining/dist/cli.js',import.meta.url));
  const call=(args:string[])=>spawnSync(process.execPath,[cli,...args,'--netuid','155','--persona','drift'],{
    env:{...process.env,FEZ_MINE_HOME:home,FEZ_WALLET_BIN:wallet},encoding:'utf8',timeout:10_000,
  });
  const test=call(['submission','--file','/tmp/candidate.py','test']);
  expect(test.status,test.stderr).toBe(0);
  expect(JSON.parse(test.stdout).sha256).toBe('a'.repeat(64));
  const invalid=call(['submission','submit','--file','--sha256','a'.repeat(64)]);
  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toContain('--file needs one value');
});
