import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { SubmissionContext } from '../../fez-extension-api/src/miner.js';
// No LFS object or paid inference: only these fixture bytes get a substituted digest.
vi.mock('node:crypto', async original => {
  const crypto = await original<typeof import('node:crypto')>();
  return { ...crypto, createHash: (...args: Parameters<typeof crypto.createHash>) => {
    const hash = crypto.createHash(...args), update = hash.update.bind(hash), digest = hash.digest.bind(hash);
    let fixture = false;
    hash.update = ((data: string | Buffer) => { fixture = String(data) === 'fixture-pack'; update(data); return hash; }) as typeof hash.update;
    hash.digest = ((encoding: 'hex') => fixture ? '9e5d11c6945edc19e06b730afd5681a035f75827933f958e6bfbcc846a28c73a' : digest(encoding)) as typeof hash.digest;
    return hash;
  } };
});
import { evaluateOro, oroDevelopmentInstructions, type OroProcess } from '../../fez-oro/src/evaluation.js';
const COMMIT = 'ffb98e581e8976fbe33cc4a3a467eb617d4b0328';
const PACK = '9e5d11c6945edc19e06b730afd5681a035f75827933f958e6bfbcc846a28c73a';
const families = ['intent_decomposition','retrieval_recall','constraint_satisfaction','preference_reasoning','ranking','recovery','justification'];
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p,{recursive:true,force:true}))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(),'oro-eval-test-'))); dirs.push(root);
  const checkout = join(root,'checkout'); await mkdir(checkout);
  const pack = join(root,'pack'), source = join(root,'agent.py');
  await writeFile(pack,'fixture-pack'); await writeFile(source,'raise RuntimeError("never run on host")');
  const config: SubmissionContext['config'] = { evaluation_checkout:checkout,evaluation_commit:COMMIT,evaluation_pack:pack,
    evaluation_provider:'openrouter',evaluation_model:'vendor/model',openrouter_api_key:'runtime-secret',chutes_api_key:'unselected-secret' };
  for(const [key,repo] of Object.entries({validator:'validator',sandbox:'sandbox',proxy:'proxy',search:'search-server'}))
    config[`evaluation_${key}_image`]=`ghcr.io/oro-ai/oro/${repo}@sha256:${'a'.repeat(64)}`;
  const ctx: SubmissionContext = {persona:'shopper',workDir:root,walletBin:'/unused',config};
  const runId=`local-${'b'.repeat(32)}`;
  const tasks = families.flatMap(family=>Array.from({length:5},(_,i)=>({task_id:`${family}-${i}`,family,outcome:'completed',reward:0.5,error_classification:null as string|null,error_detail:null})));
  const summary: Record<string,unknown> = {schema_version:'oro.local_generated_summary.v1',run_id:runId,status:'completed',pack_sha256:PACK,
    task_count:35,task_roster:tasks.map(t=>t.task_id),aggregate_score:0.5,tasks,family_rewards:Object.fromEntries(families.map(f=>[f,0.5])),error:null};
  type Service = {image:string;pull_policy:string;platform:string;build?:unknown;ports?:unknown;network_mode?:string;volumes:{source:string;target:string}[];networks:Record<string,{aliases?:string[]}>;environment:Record<string,string>};
  let logs='', compose: {services:Record<string,Service>;networks:Record<string,{name:string;internal?:boolean}>};
  const run=vi.fn<OroProcess>().mockImplementation(async(command,args,options)=>{
    if(command==='git') {
      expect(options.env.GIT_NO_REPLACE_OBJECTS).toBe('1');
      if(args.includes('ls-tree'))return `100644 blob ${'a'.repeat(40)}      7\ttracked.py\0`;
      if(args.includes('archive')){
        const path=args.find(a=>a.startsWith('--output='))!.slice(9);
        const tree=join(root,'tracked-tree'); await mkdir(tree,{recursive:true}); await writeFile(join(tree,'tracked.py'),'# code\n');
        execFileSync('tar',['-cf',path,'-C',tree,'tracked.py']); return '';
      }
      return args.includes('--show-toplevel')?checkout:args.includes('HEAD')?COMMIT:'';
    }
    if(command==='tar'){execFileSync('tar',args);return ''; }
    if(args[0]==='context')return 'unix:///tmp/docker-fixture.sock';
    if(args[0]==='ps')return 'abcdef123456';
    if(args[0]==='image') return 'amd64';
    if(args.includes('-f')) {
      compose=JSON.parse(await readFile(args[args.indexOf('-f')+1],'utf8'));
      if(args.includes('run')) {
        logs=compose.services.test.volumes.find((v:{target:string})=>v.target==='/app/logs')!.source;
        const out=join(logs,'environment-runs',runId); await mkdir(out,{recursive:true});
        await writeFile(join(out,'summary.json'),JSON.stringify(summary));
        await mkdir(join(out,'sandbox')); await writeFile(join(out,'sandbox','sandbox_output.jsonl'),'{"score":999}');
        expect(options.env.OPENROUTER_API_KEY).toBe('runtime-secret'); expect(options.env.CHUTES_API_KEY).toBeUndefined();
        const candidate=compose.services.test.volumes.find((v:{target:string})=>v.target==='/workspace/agent.py')!.source;
        expect(await readFile(candidate,'utf8')).toContain('never run on host');
        expect((await stat(candidate)).mode&0o777).toBe(0o444);
      }
    }
    return 'untrusted runtime-secret stdout';
  });
  return {ctx,source,pack,checkout,run,summary,tasks,runId,compose:()=>compose,logs:()=>logs};
}
it('keeps instructions concise and explicitly development-only',()=>{
  expect(oroDevelopmentInstructions.split(/\s+/).length).toBeLessThanOrEqual(150);
  expect(oroDevelopmentInstructions).toMatch(/explicit/i); expect(oroDevelopmentInstructions).toMatch(/qualifying/i);
});
it('runs pinned isolated services, reads only trusted summary and cleans owned resources',async()=>{
  const f=await fixture(), result=await evaluateOro(f.ctx,f.source,f.run);
  expect(result.metrics.aggregateScore).toBe(0.5); expect(result.metrics.taskCount).toBe(35);
  expect(result).not.toHaveProperty('costUsd'); expect(JSON.stringify(result)).not.toContain('secret');
  const c=f.compose(); expect(Object.keys(c.services).sort()).toEqual(['test','test-proxy','test-search-server']);
  expect(c.networks.main.name).toMatch(/^fez-oro-[a-f0-9]+-main$/); expect(c.networks['test-sandbox'].internal).toBe(true);
  expect(c.services.test.network_mode).toBe('service:test-proxy'); expect(c.services['test-proxy'].networks['test-sandbox'].aliases).toEqual(['proxy']);
  expect(JSON.stringify(c)).not.toContain('runtime-secret'); expect(JSON.stringify(c)).not.toContain('.bittensor');
  for(const s of Object.values(c.services) as Record<string,unknown>[]) {expect(s.image).toMatch(/@sha256:/);expect(s.build).toBeUndefined();expect(s.ports).toBeUndefined();expect(s.pull_policy).toBe('never');}
  expect(f.run.mock.calls.some(([,a])=>a[0]==='rm'&&a.includes(`oro-generated-${f.runId}`))).toBe(true);
  expect(f.run.mock.calls.some(([,a])=>a.includes('down'))).toBe(true); expect(f.run.mock.calls.every(([,a])=>!a.includes('prune'))).toBe(true);
  await expect(stat(f.logs())).rejects.toMatchObject({code:'ENOENT'});
});
it('rejects LFS pointers, wrong pack bytes, mutable images and wrong commits before Docker',async()=>{
  const f=await fixture(); await writeFile(f.pack,'version https://git-lfs.github.com/spec/v1');
  await expect(evaluateOro(f.ctx,f.source,f.run)).rejects.toThrow(/LFS/);
  await writeFile(f.pack,'bad'); await expect(evaluateOro(f.ctx,f.source,f.run)).rejects.toThrow(/digest/);
  await writeFile(f.pack,'fixture-pack'); f.ctx.config.evaluation_proxy_image='ghcr.io/oro-ai/oro/proxy:stable';
  await expect(evaluateOro(f.ctx,f.source,f.run)).rejects.toThrow(/evaluation_proxy_image/);
  f.ctx.config.evaluation_commit='a'.repeat(40); await expect(evaluateOro(f.ctx,f.source,f.run)).rejects.toThrow(/commit/);
  expect(f.run.mock.calls.every(([c])=>c==='git')).toBe(true);
});
it('rejects failed, incomplete, wrong-digest and inconsistent summaries',async()=>{
  for(const patch of [{status:'failed',error:{message:'runtime-secret'}},{task_count:34},{pack_sha256:'c'.repeat(64)},
    {aggregate_score:null},{aggregate_score:999},{task_roster:['missing']},{family_rewards:{}},{run_id:`local-${'c'.repeat(32)}`}]) {
    const f=await fixture(); Object.assign(f.summary,patch);
    await expect(evaluateOro(f.ctx,f.source,f.run)).rejects.toThrow(/summary/);
    expect(f.run.mock.calls.some(([,a])=>a.includes('down'))).toBe(true);
  }
});
it('uses official zero agent-failure rewards but rejects infrastructure outcomes',async()=>{
  const f=await fixture(); Object.assign(f.tasks[0],{outcome:'agent_error',reward:0,error_classification:'agent'});
  f.summary.aggregate_score=17/35; (f.summary.family_rewards as Record<string,number>)[families[0]]=0.4;
  expect((await evaluateOro(f.ctx,f.source,f.run)).metrics.agentErrors).toBe(1);
  f.tasks[0].outcome='environment_error'; await expect(evaluateOro(f.ctx,f.source,f.run)).rejects.toThrow(/summary/);
});
it('cleans only its own sandbox/project after timeout and suppresses raw errors',async()=>{
  const f=await fixture(), normal=f.run.getMockImplementation()!;
  f.run.mockImplementation(async(...args)=>{const result=await normal(...args);if(args[1].includes('run'))throw Error('runtime-secret');return result;});
  await expect(evaluateOro(f.ctx,f.source,f.run)).rejects.toThrow(/^ORO evaluation failed/);
  expect(f.run.mock.calls.some(([,a])=>a[0]==='rm'&&a.includes(`oro-generated-${f.runId}`))).toBe(true);
  expect(f.run.mock.calls.some(([,a])=>a.includes('down'))).toBe(true);
  await expect(stat(f.logs())).rejects.toMatchObject({code:'ENOENT'});
});
it('uses the selected local Docker endpoint and rejects remote daemons before launch',async()=>{
  const f=await fixture(); await evaluateOro(f.ctx,f.source,f.run);
  for(const [command,args,options] of f.run.mock.calls)if(command==='docker'&&args[0]!=='context')expect(options.env.DOCKER_HOST).toBe('unix:///tmp/docker-fixture.sock');
  const normal=f.run.getMockImplementation()!;f.run.mockClear();
  f.run.mockImplementation(async(...args)=>args[1][0]==='context'?'tcp://remote:2376':normal(...args));
  await expect(evaluateOro(f.ctx,f.source,f.run)).rejects.toThrow(/local unix Docker endpoint/);
  expect(f.run.mock.calls.some(([,args])=>args.includes('up'))).toBe(false);
});
it('accepts already-removed resources and discards evaluator streams without a buffer cap',async()=>{
  const f=await fixture(),normal=f.run.getMockImplementation()!;
  f.run.mockImplementation(async(...args)=>args[1][0]==='ps'?'':normal(...args));
  expect((await evaluateOro(f.ctx,f.source,f.run)).metrics.aggregateScore).toBe(0.5);
  expect(f.run.mock.calls.some(([,args])=>args[0]==='rm')).toBe(false);
  const evaluation=f.run.mock.calls.find(([,args])=>args.includes('run'))!;
  expect(evaluation[2].capture).toBe(false);expect(evaluation[2].timeout).toBe(2700000);
});
it('reports cleanup failure instead of claiming a successful score',async()=>{
  const f=await fixture(),normal=f.run.getMockImplementation()!;
  f.run.mockImplementation(async(...args)=>{if(args[1][0]==='rm')throw Error('daemon unavailable runtime-secret');return normal(...args);});
  await expect(evaluateOro(f.ctx,f.source,f.run)).rejects.toThrow(/^ORO cleanup failed/);
  // Cleanup failure intentionally retains recovery files; the test removes its private fixture.
  const composeCall=f.run.mock.calls.find(([,args])=>args.includes('-f'))!;
  const file=composeCall[1][composeCall[1].indexOf('-f')+1];
  const {dirname}=await import('node:path'); await rm(dirname(file),{recursive:true,force:true});
});
it('mounts a bounded pristine commit export, excluding ignored checkout bytecode',async()=>{
  const f=await fixture(); await mkdir(join(f.checkout,'__pycache__')); await writeFile(join(f.checkout,'__pycache__','inject.pyc'),'unreviewed');
  const normal=f.run.getMockImplementation()!;
  f.run.mockImplementation(async(...args)=>{
    const result=await normal(...args);
    if(args[1].includes('run')){
      const evaluator=f.compose().services.test.volumes.find(v=>v.target==='/evaluator')!.source;
      expect(evaluator).not.toBe(f.checkout);
      expect(await readFile(join(evaluator,'tracked.py'),'utf8')).toBe('# code\n');
      await expect(stat(join(evaluator,'__pycache__'))).rejects.toMatchObject({code:'ENOENT'});
    }
    return result;
  });
  await evaluateOro(f.ctx,f.source,f.run);
  expect(f.run.mock.calls.some(([c,a])=>c==='git'&&a.includes('archive')&&a.at(-1)===COMMIT)).toBe(true);
});
it('refuses links and traversal in a commit export before starting services',async()=>{
  for(const entry of [`120000 blob ${'a'.repeat(40)}      1\tlink\0`,`100644 blob ${'a'.repeat(40)}      1\t../escape.py\0`]){
    const f=await fixture(),normal=f.run.getMockImplementation()!;
    f.run.mockImplementation(async(...args)=>args[1].includes('ls-tree')?entry:normal(...args));
    await expect(evaluateOro(f.ctx,f.source,f.run)).rejects.toThrow(/export/);
    expect(f.run.mock.calls.some(([,args])=>args.includes('up'))).toBe(false);
  }
});
