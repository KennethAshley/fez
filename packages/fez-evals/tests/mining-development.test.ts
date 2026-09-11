import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from 'node:url';
import { developmentCommand } from "../../fez-mining/src/development.js";
import { writeState } from '../../fez-mining/src/state.js';

const homes: string[] = [];
afterEach(() => homes.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function fixture(body = `return {evaluator:'fixture-v1',dataset:'tasks-v1',metrics:{score:0.5},detail:'Two tasks evaluated',costUsd:0.02}`) {
  const home = mkdtempSync(join(tmpdir(), "mining-development-")); homes.push(home);
  const repo = join(home, "repo"); mkdirSync(repo); mkdirSync(join(home, "miners"));
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo,'agent.py'),'def agent_main(input): return ""\n');
  execFileSync('git',['-C',repo,'add','.']);
  execFileSync('git',['-C',repo,'-c','user.name=Test','-c','user.email=test@example.com','commit','-qm','baseline']);
  writeFileSync(join(home,'miners/test.js'),`export default [{netuid:62,name:'Fixture',development:{instructions:'Write agent_main',evaluate:async(ctx,file)=>{${body}}}}]`);
  return {home,repo};
}

it('links a checkout without running code and records comparable evaluations with immutable provenance',async()=>{
  const {home,repo}=fixture();
  const linked=await developmentCommand('configure',62,'coder',{repository:repo,source:'agent.py'},home);
  expect(linked.workspace).toEqual({repository:realpathSync(repo),source:'agent.py'});
  expect(linked.runs).toEqual([]);
  await expect(developmentCommand('evaluate',62,'coder',{source:'old.py'},home)).rejects.toThrow('Linked source changed');
  await developmentCommand('evaluate',62,'coder',{},home);
  const second=await developmentCommand('evaluate',62,'coder',{},home);
  expect(second.runs).toHaveLength(2);
  expect(second.runs[0]).toMatchObject({status:'completed',sourceSha256:expect.stringMatching(/^[a-f0-9]{64}$/),commit:expect.stringMatching(/^[a-f0-9]{40}$/),dirty:false,result:{metrics:{score:0.5}}});
  expect(readFileSync(second.runs[0].candidateFile!,'utf8')).toBe(readFileSync(join(repo,'agent.py'),'utf8'));
  expect(second.comparison).toMatchObject({deltas:{score:0},baselineId:second.runs[1].id});
  expect((await developmentCommand('inspect',62,'other',{},home)).runs).toEqual([]);
  writeFileSync(join(repo,'next.py'),'# new candidate');
  expect((await developmentCommand('configure',62,'coder',{repository:repo,source:'next.py'},home)).comparison).toBeUndefined();
});

it('rejects escaping source and unsafe identity without changing workspace',async()=>{
  const {home,repo}=fixture();
  await expect(developmentCommand('configure',62,'../bad',{repository:repo,source:'agent.py'},home)).rejects.toThrow(/persona/);
  await expect(developmentCommand('configure',62,'coder',{repository:repo,source:'../outside.py'},home)).rejects.toThrow(/source|repository/i);
  expect((await developmentCommand('inspect',62,'coder',{},home)).workspace).toBeUndefined();
});

it('records failed evaluations without copying sensitive adapter exceptions',async()=>{
  const {home,repo}=fixture(`throw Error('SECRET-KEY-should-not-leak')`);
  await developmentCommand('configure',62,'coder',{repository:repo,source:'agent.py'},home);
  const result=await developmentCommand('evaluate',62,'coder',{},home);
  expect(result.runs[0].status).toBe('failed');
  expect(JSON.stringify(result)).not.toContain('SECRET-KEY');
  expect(result.comparison).toBeUndefined();
});

it('does not accept a score for source changed during evaluation',async()=>{
  const {home,repo}=fixture(`const fs=await import('node:fs/promises');await fs.appendFile(file,'# changed');return {evaluator:'v1',dataset:'d1',metrics:{score:1},detail:'done'}`);
  await developmentCommand('configure',62,'coder',{repository:repo,source:'agent.py'},home);
  const result=await developmentCommand('evaluate',62,'coder',{},home);
  expect(result.runs[0].status).toBe('failed');
  expect(result.runs[0].result).toBeUndefined();
  expect(readFileSync(join(repo,'agent.py'),'utf8')).not.toContain('changed');
});

it('does not compare a different evaluator or dataset and refuses concurrent evaluations',async()=>{
  const {home,repo}=fixture(`await new Promise(r=>setTimeout(r,80));return {evaluator:'v1',dataset:ctx.config.dataset||'d1',metrics:{score:1},detail:'done'}`);
  const descriptor=join(home,'miners/test.js');
  writeFileSync(descriptor,readFileSync(descriptor,'utf8').replace("name:'Fixture'","name:'Fixture',config:[{key:'dataset',label:'Dataset',type:'string'}]"));
  await developmentCommand('configure',62,'coder',{repository:repo,source:'agent.py'},home);
  const results=await Promise.allSettled([developmentCommand('evaluate',62,'coder',{},home),developmentCommand('evaluate',62,'coder',{},home)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  await writeState(home,{miners:[{netuid:62,persona:'coder',hotkey:'',desired:'stopped',config:{dataset:'d2'}}],covered:[],subnets:[]});
  const next=await developmentCommand('evaluate',62,'coder',{},home);
  expect(next.runs).toHaveLength(2);
  expect(next.comparison).toBeUndefined();
});

it('the installed CLI starts an evaluation in the background without a wallet or deployment',async()=>{
  const {home,repo}=fixture(`await new Promise(r=>setTimeout(r,700));return {evaluator:'v1',dataset:'d1',metrics:{score:0.5},detail:'done'}`);
  const cli=fileURLToPath(new URL('../../fez-mining/dist/cli.js',import.meta.url));
  const call=(args:string[])=>JSON.parse(execFileSync(process.execPath,[cli,...args,'--netuid','62','--persona','coder','--json'],{env:{...process.env,FEZ_MINE_HOME:home},encoding:'utf8',timeout:10000}));
  expect(call(['development','--repository',repo,'--source','agent.py','configure']).workspace.source).toBe('agent.py');
  const started=call(['development','evaluate']);
  expect(started.job.status).toBe('running');
  expect(()=>call(['development','evaluate'])).toThrow();
  let completed=started;
  for(let i=0;i<50 && completed.job.status==='running';i++) {await new Promise(r=>setTimeout(r,50));completed=call(['development','inspect']);}
  expect(completed.job.status).toBe('completed');
  expect(completed.runs[0].result.metrics.score).toBe(0.5);
});
