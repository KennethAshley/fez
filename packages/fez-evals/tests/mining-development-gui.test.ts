// @vitest-environment jsdom
/// <reference lib="dom" />
import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const require=createRequire(resolve(__dirname,'../../fez-desktop/package.json'));
const React=require('react'); const {createRoot}=require('react-dom/client');
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
afterEach(()=>vi.useRealTimers());

async function mountJobPanel() {
 const code=execFileSync(createRequire(import.meta.url).resolve('esbuild/bin/esbuild'),[resolve(__dirname,'../../fez-mining/src/development-gui.tsx'),'--bundle','--format=iife','--global-name=Dev','--jsx-factory=h'],{encoding:'utf8'});
 const factory=new Function(code+';return Dev.createDevelopmentGui')();
 const calls:string[][]=[];const onSource=vi.fn();
 const result={id:'latest',status:'completed',startedAt:'2026-09-10T10:00:00Z',durationMs:100,repository:'/repo',source:'agent.py',sourceSha256:'a'.repeat(64),commit:'b'.repeat(40),dirty:false,configSha256:'c'.repeat(64),result:{metrics:{score:1},evaluator:'fixture',dataset:'fixture',detail:'Evaluated'}};
 const view={workspace:{repository:'/repo',source:'agent.py'},instructions:'Use official tasks',canEvaluate:true,runs:[result],comparison:{baselineId:'previous',candidateId:'latest',deltas:{score:1}},job:undefined as {status:'running'|'completed'|'failed';error?:string}|undefined};
 let pending:Promise<unknown>|undefined;
 const {DevelopmentPanel}=factory({React,processes:{run:async(_bin:string,args:string[])=>{
   calls.push(args);
   if(args[1]==='evaluate')view.job={status:'running'};
   const next=pending?await pending:JSON.parse(JSON.stringify(view));
   return {code:0,stdout:JSON.stringify(next),stderr:''};
 }}},{card:{},dim:{}});
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const render=async(persona='coder',netuid=62)=>{await React.act(async()=>root.render(React.createElement(DevelopmentPanel,{netuid,persona,onSource})));};
 const button=(label:string)=>{const b=Array.from(host.querySelectorAll('button')).find(b=>b.textContent===label);expect(b).toBeTruthy();return b!;};
 const click=async(label:string)=>{expect(button(label).disabled).toBe(false);await React.act(async()=>button(label).click());};
 const change=async(label:string,value:string)=>{await React.act(async()=>{const input=host.querySelector(`[aria-label="${label}"]`)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});};
 const dispose=async()=>{await React.act(async()=>root.unmount());host.remove();};
 await render();
 return {host,calls,onSource,view,render,button,click,change,dispose,defer:(p:typeof pending)=>{pending=p;}};
}

it('clears evaluation approval on refresh and hides comparisons from a previous source',async()=>{
 const p=await mountJobPanel();
 try {
  expect(p.host.textContent).toContain('Change from compatible run');
  await p.click('Evaluate candidate');
  p.view.workspace={repository:'/other-repo',source:'new.py'};
  await p.click('Refresh experiments');
  expect(p.host.querySelector('[aria-label="Confirm evaluation"]')).toBeNull();
  expect(p.host.textContent).not.toContain('Change from compatible run');
  expect(p.host.textContent).toContain('/repo/agent.py');
  expect(p.onSource).toHaveBeenLastCalledWith('/other-repo/new.py');
  expect(p.calls.some(a=>a[1]==='evaluate')).toBe(false);
 } finally {await p.dispose();}
});

it('polls a running evaluation without replacing source drafts or launching duplicate evaluations',async()=>{
 vi.useFakeTimers();const p=await mountJobPanel();
 try {
  await p.click('Evaluate candidate');await p.click('Confirm evaluation');
  expect(p.host.textContent).toContain('Evaluating');
  expect(p.button('Evaluate candidate').disabled).toBe(true);
  const sources=p.onSource.mock.calls.length;
  await p.change('Candidate source','unsaved.py');
  const before=p.calls.length;
  await React.act(async()=>{await vi.advanceTimersByTimeAsync(1999);});
  expect(p.calls).toHaveLength(before);
  await React.act(async()=>{await vi.advanceTimersByTimeAsync(1);});
  expect(p.calls).toHaveLength(before+1);
  expect(p.onSource.mock.calls).toHaveLength(sources);
  expect((p.host.querySelector('[aria-label="Candidate source"]') as HTMLInputElement).value).toBe('unsaved.py');
  p.view.job={status:'completed'};
  await React.act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
  expect(p.host.textContent).not.toContain('Evaluating');
  await p.change('Candidate source','agent.py');
  expect(p.button('Evaluate candidate').disabled).toBe(false);
  const done=p.calls.length;
  await React.act(async()=>{await vi.advanceTimersByTimeAsync(6000);});
  expect(p.calls).toHaveLength(done);
  expect(p.calls.filter(a=>a[1]==='evaluate')).toHaveLength(1);
  expect(p.calls.every(a=>a[0]==='development')).toBe(true);
 } finally {await p.dispose();}
});

it('drops old identity polling results and stops polling on unmount',async()=>{
 vi.useFakeTimers();const p=await mountJobPanel();
 try {
  await p.click('Evaluate candidate');await p.click('Confirm evaluation');
  let finish!:(value:unknown)=>void;
  p.defer(new Promise(resolve=>{finish=resolve;}));
  await React.act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
  p.defer(undefined);p.view.job=undefined;p.view.workspace={repository:'/new-persona',source:'new.py'};
  await p.render('other',63);
  await React.act(async()=>finish({...p.view,workspace:{repository:'/OLD',source:'old.py'},job:{status:'running'}}));
  expect((p.host.querySelector('[aria-label="Repository folder"]') as HTMLInputElement).value).toBe('/new-persona');
  expect(p.onSource.mock.calls.flat()).not.toContain('/OLD/old.py');
  const done=p.calls.length;
  await React.act(async()=>{await vi.advanceTimersByTimeAsync(6000);});
  expect(p.calls).toHaveLength(done);
  await p.click('Evaluate candidate');await p.click('Confirm evaluation');
 } finally {await p.dispose();}
 const done=p.calls.length;
 await React.act(async()=>{await vi.advanceTimersByTimeAsync(6000);});
 expect(p.calls).toHaveLength(done);
});

it('shows a failed background job and stops polling without retrying evaluation',async()=>{
 vi.useFakeTimers();const p=await mountJobPanel();
 try {
  await p.click('Evaluate candidate');await p.click('Confirm evaluation');
  p.view.job={status:'failed',error:'Evaluation worker stopped; inspect history before retrying.'};
  await React.act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
  expect(p.host.textContent).toContain('Evaluation worker stopped');
  expect(p.host.textContent).not.toContain('Evaluating');
  expect(p.button('Evaluate candidate').disabled).toBe(false);
  const done=p.calls.length;
  await React.act(async()=>{await vi.advanceTimersByTimeAsync(6000);});
  expect(p.calls).toHaveLength(done);
  expect(p.calls.filter(a=>a[1]==='evaluate')).toHaveLength(1);
 } finally {await p.dispose();}
});

it('shares repository configuration and explicit evaluation approval with the CLI',async()=>{
 const code=execFileSync(createRequire(import.meta.url).resolve('esbuild/bin/esbuild'),[resolve(__dirname,'../../fez-mining/src/development-gui.tsx'),'--bundle','--format=iife','--global-name=Dev','--jsx-factory=h'],{encoding:'utf8'});
 const factory=new Function(code+';return Dev.createDevelopmentGui')();
 const calls:string[][]=[];
 let workspace:object|undefined;
 const {DevelopmentPanel}=factory({React,processes:{run:async(_bin:string,args:string[])=>{
   calls.push(args);
   if(args[1]==='configure') workspace={repository:'/repo',source:'agent.py'};
   return {code:0,stdout:JSON.stringify({workspace,instructions:'Use official tasks',canEvaluate:true,runs:[]}),stderr:''};
 }}},{card:{},dim:{}});
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const click=async(label:string)=>{const b=Array.from(host.querySelectorAll('button')).find(b=>b.textContent===label)!;expect(b).toBeTruthy();await React.act(async()=>b.click());};
 try {
  await React.act(async()=>root.render(React.createElement(DevelopmentPanel,{netuid:62,persona:'coder'})));
  for(const [label,value] of [['Repository folder','/repo'],['Candidate source','agent.py']]) await React.act(async()=>{
   const input=host.querySelector(`[aria-label="${label}"]`)!;
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await click('Link source');
  expect(calls.find(a=>a[1]==='configure')).toContain('/repo');
  await click('Evaluate candidate');
  expect(calls.some(a=>a[1]==='evaluate')).toBe(false);
  expect(host.textContent).toContain('inference');
  await click('Confirm evaluation');
  expect(calls.filter(a=>a[1]==='evaluate')).toHaveLength(1);
  expect(calls.every(a=>a[0]==='development')).toBe(true);
 } finally {await React.act(async()=>root.unmount());host.remove();}
});
