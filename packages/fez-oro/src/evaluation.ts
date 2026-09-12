import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { SubmissionContext } from '@fezchat/extension-api';

const COMMIT = 'ffb98e581e8976fbe33cc4a3a467eb617d4b0328';
const PACK = '9e5d11c6945edc19e06b730afd5681a035f75827933f958e6bfbcc846a28c73a';
const families = ['intent_decomposition','retrieval_recall','constraint_satisfaction','preference_reasoning','ranking','recovery','justification'] as const;
export const oroDevelopmentInstructions =
  'Unsupported for testnet mining. Local evaluation is development only and does not mine or earn rewards. Keep Wallet on testnet. ' +
  'Implement synchronous agent_main(problem_data) using the supplied environment binding and policy_view. ' +
  'Evaluate runs the official 35-task development pack, not a prediction of current qualifying or race scores. ' +
  'It requires an explicit request and can bill both agent and simulator inference. ' +
  'Select the reviewed ORO checkout/commit, the actual Git LFS EnvPack archive, four digest-pinned images, a provider and a currently allowed model. ' +
  'Configure only that provider’s runtime key. Start local Docker with Compose, install the selected AMD64 images, and reserve at least 16 GB; ARM hosts need emulation. ' +
  'No wallet is required. Allow several minutes for pack validation and up to 30 minutes for evaluation. ' +
  'Results use trusted runtime summaries; raw private artifacts are discarded. Models and the live allowlist can change between comparisons.';

export type OroProcess = (command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeout: number; capture?: boolean;
}) => Promise<string>;
const runProcess: OroProcess = (command, args, options) => new Promise((resolve,reject) => {
  const child=spawn(command,args,{cwd:options.cwd,env:options.env,stdio:['ignore',options.capture===false?'ignore':'pipe','ignore']});
  const chunks:Buffer[]=[]; let size=0, failed=false;
  const timer=setTimeout(()=>{failed=true;child.kill('SIGKILL');},options.timeout);
  child.stdout?.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>256*1024){failed=true;child.kill('SIGKILL');}else chunks.push(chunk);});
  child.on('error',()=>{clearTimeout(timer);reject(Error('ORO process could not start; raw output withheld'));});
  child.on('close',code=>{clearTimeout(timer);if(failed||code!==0)reject(Error('ORO process failed or timed out; raw output withheld'));else resolve(Buffer.concat(chunks).toString('utf8'));});
});
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function field(ctx: SubmissionContext, key: string, pattern?: RegExp): string {
  const value = ctx.config[key];
  // eslint-disable-next-line no-control-regex -- Reject control characters at the process and filesystem boundary.
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || (pattern && !pattern.test(value))) throw Error(`Configure valid ${key}`);
  return value;
}
function absolute(value: string): string {
  // Docker's -v and Compose interpolation must not reinterpret local paths.
  // eslint-disable-next-line no-control-regex -- Reject control characters at the process and filesystem boundary.
  if (!isAbsolute(value) || /[:$\x00-\x1f]/.test(value)) throw Error('ORO paths must be absolute without colons, dollar signs or control characters');
  return value;
}
async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > limit) throw Error('ORO input/output must be a bounded regular file');
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) { const read = await file.read(bytes, count, bytes.length - count, null); if (!read.bytesRead) break; count += read.bytesRead; }
    if (!count || count > limit) throw Error('ORO input/output exceeded size limit');
    return bytes.subarray(0, count);
  } finally { await file.close(); }
}
const reward = z.number().finite().nonnegative();
const taskSchema = z.object({ task_id:z.string().min(1).max(256), family:z.enum(families), outcome:z.string().min(1).max(64),
  reward, error_classification:z.string().max(64).nullable(), error_detail:z.string().max(16384).nullable() }).strict();
const summarySchema = z.object({ schema_version:z.literal('oro.local_generated_summary.v1'), run_id:z.string().regex(/^local-[a-f0-9]{32}$/),
  status:z.literal('completed'), pack_sha256:z.literal(PACK), task_count:z.literal(35), task_roster:z.array(z.string().min(1).max(256)).length(35),
  aggregate_score:reward, tasks:z.array(taskSchema).length(35), family_rewards:z.record(reward), error:z.null() }).strict();
function parseSummary(bytes: Buffer, runId: string) {
  try {
    const result = summarySchema.parse(JSON.parse(bytes.toString('utf8')));
    if (result.run_id !== runId || new Set(result.task_roster).size !== 35 || new Set(result.tasks.map(t=>t.task_id)).size !== 35 ||
      result.tasks.some(t=>!result.task_roster.includes(t.task_id)) || Object.keys(result.family_rewards).length !== 7) throw Error();
    for (const task of result.tasks) {
      if (['environment_error','verifier_error','leakage','exploit'].includes(task.outcome)) throw Error();
      if (task.outcome === 'completed' ? task.error_classification !== null : task.error_classification !== 'agent' || task.reward !== 0) throw Error();
    }
    for (const family of families) {
      const tasks = result.tasks.filter(t=>t.family===family);
      if (tasks.length !== 5 || !Number.isFinite(result.family_rewards[family]) || Math.abs(tasks.reduce((s,t)=>s+t.reward,0)/5-result.family_rewards[family])>1e-9) throw Error();
    }
    if (Math.abs(result.tasks.reduce((s,t)=>s+t.reward,0)/35-result.aggregate_score)>1e-9) throw Error();
    return result;
  } catch { throw Error('ORO summary is failed, incomplete, inconsistent or invalid; no score recorded'); }
}

/** The caller must obtain explicit evaluation consent; never call from sourcecheck or status. */
export async function evaluateOro(ctx: SubmissionContext, sourcePath: string, run: OroProcess = runProcess) {
  const checkout = await realpath(absolute(field(ctx,'evaluation_checkout')));
  if (field(ctx,'evaluation_commit') !== COMMIT) throw Error(`ORO evaluation_commit must be reviewed commit ${COMMIT}`);
  const env: NodeJS.ProcessEnv = { PATH:process.env.PATH, HOME:process.env.HOME,
    DOCKER_DEFAULT_PLATFORM:'linux/amd64', COMPOSE_DISABLE_ENV_FILE:'1' };
  if(process.env.DOCKER_CONTEXT)env.DOCKER_CONTEXT=process.env.DOCKER_CONTEXT;
  const gitEnv = {PATH:process.env.PATH,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'};
  const git = (args: string[]) => run('git',['--no-optional-locks','-c','core.fsmonitor=false','-C',checkout,...args],{cwd:checkout,env:gitEnv,timeout:5000}).then(s=>s.trim());
  if (await git(['rev-parse','--show-toplevel']) !== checkout || await git(['rev-parse','--verify','HEAD']) !== COMMIT) throw Error('ORO evaluator root/commit does not match selection');
  // The one LFS path is separately snapshotted and digest-checked, allowing both
  // pointer-only and smudged checkouts without requiring a host git-lfs filter.
  if (await git(['status','--porcelain','--untracked-files=all','--ignore-submodules=none','--','.',':(exclude)data/local-test/env-pack.tar.gz'])) throw Error('ORO evaluator checkout must be clean');
  const pack = await boundedFile(absolute(field(ctx,'evaluation_pack')),16*1024*1024);
  if (pack.subarray(0,80).toString().startsWith('version https://git-lfs.github.com/spec/v1')) throw Error('ORO EnvPack is a Git LFS pointer; supply the actual published archive');
  if (sha(pack) !== PACK) throw Error(`ORO pack digest must equal ${PACK}`);
  const source = await boundedFile(absolute(sourcePath),1024*1024);
  const images: Record<string,string> = {};
  for (const [key,repo] of Object.entries({validator:'validator',sandbox:'sandbox',proxy:'proxy',search:'search-server'}))
    images[key]=field(ctx,`evaluation_${key}_image`,new RegExp(`^ghcr\\.io/oro-ai/oro/${repo}@sha256:[a-f0-9]{64}$`));
  const provider=field(ctx,'evaluation_provider',/^(openrouter|chutes)$/), model=field(ctx,'evaluation_model',/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/);
  const keyName=provider==='openrouter'?'OPENROUTER_API_KEY':'CHUTES_API_KEY';
  const key=field(ctx,keyName.toLowerCase());
  const endpoint=(!env.DOCKER_CONTEXT && process.env.DOCKER_HOST) || (await run('docker',['context','inspect','--format','{{.Endpoints.docker.Host}}'],{cwd:checkout,env,timeout:15000})).trim();
  // eslint-disable-next-line no-control-regex -- Reject control characters at the process and filesystem boundary.
  if(!/^unix:\/\/\/[^\x00-\x1f]+$/.test(endpoint))throw Error('ORO evaluation requires a local unix Docker endpoint, not a remote daemon');
  env.DOCKER_HOST=endpoint; delete env.DOCKER_CONTEXT;
  for (const image of Object.values(images)) {
    if ((await run('docker',['image','inspect','--format','{{.Architecture}}',image],{cwd:checkout,env,timeout:15000})).trim()!=='amd64') throw Error('Install all selected digest-pinned AMD64 ORO images on the local Docker daemon');
  }
  const root=await mkdtemp(join(tmpdir(),'fez-oro-')), project=`fez-oro-${randomUUID().replaceAll('-','')}`;
  const runner=`${project}-test`, composeFile=join(root,'compose.json'), logs=join(root,'logs'), outputs=join(logs,'environment-runs'), evaluator=join(root,'evaluator');
  const mount=(source:string,target:string,readOnly=true)=>({type:'bind',source,target,read_only:readOnly});
  const health=(test:string[])=>({test,interval:'10s',timeout:'10s',retries:6,start_period:'30s'});
  const service=(image:string)=>({image,platform:'linux/amd64',pull_policy:'never',restart:'no',logging:{driver:'json-file',options:{'max-size':'10m','max-file':'1'}}});
  // Minimal projection of upstream's test profile. No default services, global
  // network names, host ports, wallet mounts, build hooks or watchtower labels.
  const compose={services:{
    'test-search-server':{...service(images.search),environment:{HOST:'0.0.0.0',PORT:'5632',SEARCH_WORKERS:'2',SEARCH_THREADS:'4',_JAVA_OPTIONS:'-Xmx1g -Xms256m'},networks:['main'],
      healthcheck:health(['CMD','python','-c',"import urllib.request; urllib.request.urlopen('http://localhost:5632/health').read()"] )},
    'test-proxy':{...service(images.proxy),environment:{SEARCH_SERVER_URL:'test-search-server',SEARCH_SERVER_PORT:'5632',CHUTES_HOST:'llm.chutes.ai',
      OPENROUTER_HOST:'openrouter.ai',BACKEND_URL:'https://api.oroagents.com',BACKEND_HOST:'api.oroagents.com',SESSION_RUNTIME_HOST:'127.0.0.1',SESSION_RUNTIME_PORT:'9101',SESSION_CALL_TIMEOUT:'65s'},
      networks:{main:{},'test-sandbox':{aliases:['proxy']}},healthcheck:health(['CMD','wget','--quiet','--tries=1','--spider','http://127.0.0.1/health'])},
    test:{...service(images.validator),entrypoint:['/app/.venv/bin/python','-m','subnet.local_generated_validator'],working_dir:'/evaluator',network_mode:'service:test-proxy',
      volumes:[mount('/var/run/docker.sock','/var/run/docker.sock',false),mount(evaluator,'/evaluator'),mount(join(root,'agent.py'),'/workspace/agent.py'),
        mount(join(root,'pack.tar.gz'),'/pack/env-pack.tar.gz'),mount(logs,'/app/logs',false)],
      environment:{HOST_PROJECT_DIR:root,PYTHONPATH:'/evaluator:/app',LOCAL_OUTPUT_ROOT:'/app/logs/environment-runs',
        SANDBOX_IMAGE:images.sandbox,SANDBOX_NETWORK:`${project}-sandbox`,SANDBOX_MODEL:model,INFERENCE_PROVIDER:provider,
        [keyName]:`\${${keyName}}`,LOCAL_ENV_PACK_PATH:'/pack/env-pack.tar.gz',LOCAL_ENV_PACK_SHA256:PACK,LOCAL_MAX_WORKERS:'7',LOCAL_TIMEOUT:'1800',
        SEARCH_SERVER_URL:'http://test-search-server:5632',DOCKER_DEFAULT_PLATFORM:'linux/amd64'}},
  },networks:{main:{name:`${project}-main`,driver:'bridge'},'test-sandbox':{name:`${project}-sandbox`,driver:'bridge',internal:true}}};
  const composeArgs=['compose','--project-name',project,'--project-directory',root,'-f',composeFile];
  const docker=(args:string[],timeout:number,paid=false)=>run('docker',args,{cwd:root,env:paid?{...env,[keyName]:key}:env,timeout,capture:args[0]==='ps'});
  const removeOwned=async(name:string)=>{
    const args=['ps','--all','--quiet','--filter',`name=^/${name}$`];
    const present=(await docker(args,15000)).trim();
    if(!present)return;
    if(!/^[a-f0-9]{12,64}$/.test(present))throw Error('Unexpected Docker resource identity');
    try{await docker(['rm','--force',name],30000);}catch{if((await docker(args,15000)).trim())throw Error('Owned Docker resource remains');}
  };
  let started=false, cleanupFailed=false;
  try {
    // Export the reviewed tree, never import from a mutable checkout or its
    // ignored __pycache__. Validate Git's archive entries before native extraction.
    const listing=await git(['ls-tree','-rlz',COMMIT]);
    const treeEntries=listing.split('\0').filter(Boolean); let total=0;
    if(!treeEntries.length||treeEntries.length>10000)throw Error('ORO evaluator tree exceeds export limits');
    for(const entry of treeEntries){
      const match=/^(100644|100755) blob [a-f0-9]{40} +(\d+)\t(.+)$/s.exec(entry);
      if(!match)throw Error('ORO evaluator export forbids links and submodules');
      const size=Number(match[2]),path=match[3]; total+=size;
      // eslint-disable-next-line no-control-regex -- Reject control characters at the process and filesystem boundary.
      if(size>64*1024*1024||total>256*1024*1024||path.startsWith('/')||path.split('/').includes('..')||/[\x00-\x1f\\]/.test(path)||/(^|\/)__pycache__(\/|$)|\.py[co]$/.test(path))
        throw Error('ORO evaluator export contains an unsafe or oversized entry');
    }
    const archive=join(root,'evaluator.tar');
    await git(['archive','--format=tar',`--output=${archive}`,COMMIT]);
    const archiveStat=await lstat(archive);
    if(!archiveStat.isFile()||archiveStat.nlink!==1||archiveStat.size>280*1024*1024)throw Error('ORO evaluator archive exceeds export limits');
    await mkdir(evaluator,{mode:0o755});
    await run('tar',['--no-same-owner','--no-same-permissions','-xf',archive,'-C',evaluator],{cwd:root,env:{PATH:process.env.PATH},timeout:30000,capture:false});
    await rm(archive);
    await mkdir(outputs,{recursive:true,mode:0o755});
    await writeFile(join(root,'agent.py'),source,{mode:0o444}); await writeFile(join(root,'pack.tar.gz'),pack,{mode:0o444});
    await writeFile(composeFile,JSON.stringify(compose),{mode:0o600});
    started=true;
    try {
      await docker([...composeArgs,'up','--detach','--wait','--wait-timeout','180','--no-build','--pull','never','test-search-server','test-proxy'],240000);
      await docker([...composeArgs,'run','--rm','--no-deps','--name',runner,'test','--agent-file','/workspace/agent.py'],2700000,true);
    } catch { throw Error('ORO evaluation failed or timed out; check pack, images, model/key and Docker. Agent or simulator inference may have been billed.'); }
    const entries=await readdir(outputs,{withFileTypes:true});
    if(entries.length!==1||!entries[0].isDirectory()||!/^local-[a-f0-9]{32}$/.test(entries[0].name))throw Error('ORO summary run directory missing or ambiguous');
    const id=entries[0].name;
    const result=parseSummary(await boundedFile(join(outputs,id,'summary.json'),1024*1024),id);
    const metrics:Record<string,number>={aggregateScore:result.aggregate_score,taskCount:35,agentErrors:result.tasks.filter(t=>t.error_classification==='agent').length};
    for(const family of families)metrics[`family.${family}`]=result.family_rewards[family];
    // Pin the selected assets/config; live provider responses and allowlist are not frozen.
    const fingerprint=sha(JSON.stringify({images,provider,model,platform:'linux/amd64',workers:7,timeout:1800,adapter:1}));
    return {evaluator:`oro-local@${COMMIT}:${fingerprint}`,dataset:`${PACK}:${sha(JSON.stringify(result.task_roster))}`,metrics,
      detail:'Official 35-task development pack results only; current qualifying roster, live model allowlist and inference can differ. Cost is not reported by the official summary.'};
  } finally {
    if(started) {
      // Stop the parent first so it cannot create another child during cleanup.
      try {await removeOwned(runner);}catch{cleanupFailed=true;}
      try {
        for(const entry of await readdir(outputs,{withFileTypes:true}))if(entry.isDirectory()&&/^local-[a-f0-9]{32}$/.test(entry.name))
          await removeOwned(`oro-generated-${entry.name}`);
      }catch{cleanupFailed=true;}
      try {await docker([...composeArgs,'down','--timeout','10'],60000);}catch{cleanupFailed=true;}
    }
    // Retain private recovery metadata if Docker cleanup failed; never publish logs.
    // eslint-disable-next-line no-unsafe-finally -- Cleanup failure overrides results so owned resources are recovered before retrying.
    if(cleanupFailed)throw Error('ORO cleanup failed; inspect this run’s Docker resources before retrying. Private recovery files were retained.');
    await rm(root,{recursive:true,force:true});
  }
}
