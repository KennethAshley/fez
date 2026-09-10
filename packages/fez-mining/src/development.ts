import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadDescriptors } from './descriptors.js';
import { resolveConfig } from './config.js';
import { getSecret } from './secrets.js';
import { fezHome, readState } from './state.js';

const workspaceSchema = z.object({ repository: z.string(), source: z.string() });
const resultSchema = z.object({ evaluator: z.string().min(1).max(500), dataset: z.string().min(1).max(500),
  metrics: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_. -]{0,79}$/), z.number().finite()),
  detail: z.string().max(8000), costUsd: z.number().finite().nonnegative().optional() });
const runSchema = z.object({id:z.string(),status:z.enum(['running','completed','failed']),startedAt:z.string(),durationMs:z.number(),
  sourceSha256:z.string(),commit:z.string(),dirty:z.boolean(),configSha256:z.string(),repository:z.string(),source:z.string(),
  candidateFile:z.string().optional(),result:resultSchema.optional(),error:z.string().optional()});
type Run = z.infer<typeof runSchema>;
const jobSchema=z.object({status:z.enum(['running','completed','failed']),error:z.string().optional()});
export type DevelopmentView = {
  workspace?: z.infer<typeof workspaceSchema>;
  instructions: string;
  canEvaluate: boolean;
  runs: Run[];
  job?:z.infer<typeof jobSchema>;
  comparison?: {baselineId:string;candidateId:string;deltas:Record<string,number>};
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const git = (repository:string,args:string[]) => execFileSync('git',['-c','core.fsmonitor=false','-C',repository,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10_000,maxBuffer:4*1024*1024}).trim();

async function readJson(file:string):Promise<unknown|undefined> {
  try { return JSON.parse(await fs.readFile(file,'utf8')); }
  catch(e) { if(e && typeof e==='object' && 'code' in e && e.code==='ENOENT') return undefined; throw Error('Mining development history is unreadable; preserve it before recovery'); }
}
async function writeJson(file:string,value:unknown) {
  const tmp=`${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});
  await fs.rename(tmp,file);
}
async function sourceInRepo(repository:string,source:string) {
  if(!path.isAbsolute(repository) || path.isAbsolute(source) || source.split(/[\\/]/).includes('..')) throw Error('Choose an absolute repository and a source path inside it');
  const root=await fs.realpath(repository);
  if(git(root,['rev-parse','--show-toplevel'])!==root) throw Error('Choose the Git repository root');
  const file=await fs.realpath(path.join(root,source));
  if(path.relative(root,file).startsWith('..') || path.isAbsolute(path.relative(root,file))) throw Error('Source must stay inside the repository');
  const stat=await fs.stat(file);
  if(!stat.isFile() || stat.size>1024*1024) throw Error('Source must be a file of at most 1 MiB');
  return {repository:root,source:path.relative(root,file),file};
}

/** One local workspace and experiment ledger, shared by chat and GUI. Never deploys. */
export async function developmentCommand(action:'inspect'|'configure'|'evaluate',netuid:number,persona:string,
  options:{repository?:string;source?:string}={},home=fezHome()):Promise<DevelopmentView> {
  if(!Number.isSafeInteger(netuid)||netuid<0) throw Error('Invalid netuid');
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(persona)) throw Error('Invalid persona');
  if(!['inspect','configure','evaluate'].includes(action)) throw Error('Unknown development action');
  const descriptor=(await loadDescriptors(home)).find(d=>d.netuid===netuid);
  if(!descriptor) throw Error('Install a miner adapter for this subnet first');
  const dir=path.join(home,'mining',`${netuid}-${persona}`,'development');
  const view=async():Promise<DevelopmentView>=>{
    const raw=await readJson(path.join(dir,'workspace.json'));
    const workspace=raw===undefined?undefined:workspaceSchema.parse(raw);
    const rawJob=await readJson(path.join(dir,'job.json'));
    const job=rawJob===undefined?undefined:jobSchema.parse(rawJob);
    const files=await fs.readdir(dir).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;});
    const runs=(await Promise.all(files.filter(f=>/^run-[a-f0-9-]+\.json$/.test(f)).map(async f=>runSchema.parse(await readJson(path.join(dir,f))))))
      .sort((a,b)=>b.startedAt.localeCompare(a.startedAt)||b.id.localeCompare(a.id)).slice(0,50);
    const latest=runs[0];
    const baseline=latest?.result && workspace?.repository===latest.repository && workspace.source===latest.source && runs.slice(1).find(r=>r.result && r.repository===latest.repository && r.source===latest.source && r.configSha256===latest.configSha256 && r.result.evaluator===latest.result!.evaluator && r.result.dataset===latest.result!.dataset);
    const deltas:Record<string,number>={};
    if(baseline && baseline.result && latest.result) for(const [key,value] of Object.entries(latest.result.metrics)) if(key in baseline.result.metrics) deltas[key]=value-baseline.result.metrics[key];
    return {workspace,instructions:descriptor.development?.instructions??'Use this subnet’s documented miner contract. Create and commit source with your coding agent; link it here. This adapter does not supply a local performance evaluator.',
      canEvaluate:typeof descriptor.development?.evaluate==='function',runs,job,
      ...(baseline && Object.keys(deltas).length ? {comparison:{baselineId:baseline.id,candidateId:latest.id,deltas}}:{})};
  };
  if(action==='inspect') return view();
  await fs.mkdir(dir,{recursive:true});
  const lock=await fs.open(path.join(dir,'operation.lock'),'wx').catch(()=>{throw Error('Another development operation is running; do not retry an evaluation until its outcome is known');});
  try {
    if(action==='configure') {
      const {repository,source}=await sourceInRepo(options.repository??'',options.source??'');
      await writeJson(path.join(dir,'workspace.json'),{repository,source});
      return await view();
    }
    if(!descriptor.development?.evaluate) throw Error('This subnet has no local performance evaluator');
    const workspace=(await view()).workspace;
    if(!workspace) throw Error('Link a repository and source file first');
    if((options.repository!==undefined && options.repository!==workspace.repository)||(options.source!==undefined && options.source!==workspace.source)) throw Error('Linked source changed; inspect it before evaluating');
    const selected=await sourceInRepo(workspace.repository,workspace.source);
    const initial=(await readState(home)).miners.find(m=>m.netuid===netuid && m.persona===persona);
    const config=resolveConfig(descriptor.config,initial?.config,k=>getSecret(netuid,persona,k));
    const publicConfig=Object.fromEntries((descriptor.config??[]).filter(f=>f.type!=='secret').map(f=>[f.key,config[f.key]]).sort(([a],[b])=>String(a).localeCompare(String(b))));
    const bytes=await fs.readFile(selected.file);
    const run:Run={id:randomUUID(),status:'running',startedAt:new Date().toISOString(),durationMs:0,
      repository:selected.repository,source:selected.source,sourceSha256:hash(bytes),
      commit:git(selected.repository,['rev-parse','HEAD']),dirty:!!git(selected.repository,['status','--porcelain']),configSha256:hash(JSON.stringify(publicConfig))};
    // A running marker survives crashes; only validated output can make a successful score.
    run.error='Evaluation running or interrupted. Inspect the evaluator before retrying; inference may already have been billed.';
    run.candidateFile=path.join(dir,`candidate-${run.id}${path.extname(selected.file)}`);
    await fs.writeFile(run.candidateFile,bytes,{mode:0o600,flag:'wx'});
    const record=path.join(dir,`run-${run.id}.json`); await writeJson(record,run);
    const started=Date.now();
    try {
      const result=resultSchema.parse(await descriptor.development.evaluate({persona,hotkey:initial?.hotkey,config,walletBin:path.join(home,'bin','fez-wallet'),workDir:path.dirname(dir)},run.candidateFile));
      if(hash(await fs.readFile(selected.file))!==run.sourceSha256 || hash(await fs.readFile(run.candidateFile))!==run.sourceSha256) throw Error('Source changed');
      // Adapter messages are untrusted; never persist configured credentials in history.
      for(const field of descriptor.config??[]) if(field.type==='secret' && typeof config[field.key]==='string' && String(config[field.key]).length) {
        if(JSON.stringify(result).includes(String(config[field.key]))) throw Error('Result contained a credential');
      }
      run.result=result; run.status='completed'; delete run.error;
    } catch { run.status='failed';run.error='Evaluation failed or source changed. Check evaluator setup and logs locally. No score accepted; no submission made.'; }
    run.durationMs=Date.now()-started; await writeJson(record,run);
    return await view();
  } finally { await lock.close(); await fs.unlink(path.join(dir,'operation.lock')); }
}

/** Detach expensive evaluation from the desktop's bounded command lifetime. */
export async function startDevelopmentEvaluation(netuid:number,persona:string,options:{repository?:string;source?:string},cliFile:string,home=fezHome()) {
  const current=await developmentCommand('inspect',netuid,persona,{},home);
  if(!current.canEvaluate||!current.workspace)throw Error('Link source and configure an evaluator first');
  if((options.repository!==undefined && options.repository!==current.workspace.repository)||(options.source!==undefined && options.source!==current.workspace.source))throw Error('Linked source changed; inspect it before evaluating');
  const dir=path.join(home,'mining',`${netuid}-${persona}`,'development');
  const launch=path.join(dir,'launch.lock');
  const lock=await fs.open(launch,'wx').catch(()=>{throw Error('An evaluation is running or was interrupted. Inspect its outcome before retrying');});
  await lock.close();
  try {
    await writeJson(path.join(dir,'job.json'),{status:'running'});
    const child=spawn(process.execPath,[cliFile,'development','evaluate-worker','--netuid',String(netuid),'--persona',persona,
      '--repository',current.workspace.repository,'--source',current.workspace.source],{
      detached:true,stdio:'ignore',env:{...process.env,FEZ_MINE_HOME:home},
    });
    await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    child.unref();
    return await developmentCommand('inspect',netuid,persona,{},home);
  }catch(error){await writeJson(path.join(dir,'job.json'),{status:'failed',error:'Could not start evaluation'});await fs.unlink(launch);throw error;}
}

/** Internal worker entry: persistent status survives the initiating chat/window. */
export async function runDevelopmentEvaluation(netuid:number,persona:string,options:{repository?:string;source?:string},home=fezHome()) {
  // Validate before constructing any writable path from CLI input.
  await developmentCommand('inspect',netuid,persona,{},home);
  const dir=path.join(home,'mining',`${netuid}-${persona}`,'development');
  await fs.access(path.join(dir,'launch.lock'));
  try {
    const result=await developmentCommand('evaluate',netuid,persona,options,home);
    await writeJson(path.join(dir,'job.json'),{status:result.runs[0]?.status==='completed'?'completed':'failed'});
  }catch{await writeJson(path.join(dir,'job.json'),{status:'failed',error:'Evaluation failed. Check the linked source and evaluator setup before retrying; inference may have been billed.'});}
  finally{await fs.unlink(path.join(dir,'launch.lock'));}
}
