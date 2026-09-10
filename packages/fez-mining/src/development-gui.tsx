import type { GuiExtensionApi } from '@fezchat/extension-api/gui';
import type { DevelopmentView } from './development.js';

export function createDevelopmentGui(api:GuiExtensionApi,styles:{card:Record<string,string|number>;dim:Record<string,string|number>}) {
  const h=api.React.createElement;
  const {useState,useEffect,useRef}=api.React;
  function DevelopmentPanel({netuid,persona,onSource}:{netuid:number;persona:string;onSource?:(file:string)=>void}):JSX.Element {
    const [view,setView]=useState<DevelopmentView|undefined>(undefined);
    const [repository,setRepository]=useState('');const [source,setSource]=useState('agent.py');
    const [busy,setBusy]=useState(false);const [confirm,setConfirm]=useState(false);const [error,setError]=useState('');
    const revision=useRef(0); const flight=useRef(false);
    const running=view?.job?.status==='running';
    const latest=view?.runs[0];
    const comparison=latest && view?.workspace && latest.repository===view.workspace.repository && latest.source===view.workspace.source ? view.comparison : undefined;
    async function action(verb:'inspect'|'configure'|'evaluate',background=false) {
      if(verb==='inspect'&&!background)setConfirm(false);
      if(!api.processes?.run||flight.current||(verb==='evaluate'&&running))return;
      const current=revision.current;flight.current=true;if(!background)setBusy(true);setError('');
      try {
        const args=['development',verb,'--netuid',String(netuid),'--persona',persona,'--json'];
        if(verb==='configure'||verb==='evaluate')args.push('--repository',repository,'--source',source);
        const out=await api.processes.run('fez-mine',args);
        if(current!==revision.current)return;
        if(out.code!==0)throw Error(out.stderr.trim()||'Development command failed');
        const next=JSON.parse(out.stdout) as DevelopmentView;
        if(!Array.isArray(next.runs)||typeof next.canEvaluate!=='boolean'||typeof next.instructions!=='string')throw Error('Invalid development response');
        setView(next);
        // Polling updates results only: source drafts and the submission receipt
        // belong to the user until they explicitly link or refresh a source.
        if(next.workspace&&!background&&verb!=='evaluate'){setRepository(next.workspace.repository);setSource(next.workspace.source);onSource?.(`${next.workspace.repository}/${next.workspace.source}`);}
      }catch(e){if(current===revision.current)setError(e instanceof Error?e.message:'Development command failed');}
      finally{if(current===revision.current){flight.current=false;setBusy(false);}}
    }
    useEffect(()=>{revision.current++;flight.current=false;setView(undefined);setRepository('');setSource('agent.py');setConfirm(false);void action('inspect');return()=>{revision.current++;};},[netuid,persona]);
    useEffect(()=>{
      if(!running)return;
      const timer=setInterval(()=>void action('inspect',true),2000);
      return()=>clearInterval(timer);
    },[netuid,persona,running]);
    return <div style={{...styles.card,padding:12,marginTop:12}}>
      <div className="skill-name">Develop your miner</div>
      <p style={styles.dim}>{view?.instructions??'Link the Git checkout your coding agent works in. Changes here do not deploy or submit a miner.'}</p>
      <label style={{display:'grid',gap:4}}>Repository folder<input className="manage-input" aria-label="Repository folder" value={repository} disabled={busy} onChange={(e:{target:{value:string}})=>{setRepository(e.target.value);setConfirm(false);}} placeholder="/absolute/path/to/repository" /></label>
      <label style={{display:'grid',gap:4,marginTop:8}}>Candidate source<input className="manage-input" aria-label="Candidate source" value={source} disabled={busy} onChange={(e:{target:{value:string}})=>{setSource(e.target.value);setConfirm(false);}} placeholder="agent.py" /></label>
      <div style={{display:'flex',gap:8,marginTop:8}}>
        <button className="agent-action" disabled={busy||running||!repository||!source||!api.processes?.run} onClick={()=>void action('configure')}>Link source</button>
        <button className="skill-link" disabled={busy||!api.processes?.run} onClick={()=>void action('inspect')}>Refresh experiments</button>
        {view?.canEvaluate?<button className="agent-action" disabled={busy||running||!view.workspace||repository!==view.workspace.repository||source!==view.workspace.source} onClick={()=>setConfirm(true)}>Evaluate candidate</button>:null}
      </div>
      {view && !view.canEvaluate?<p style={styles.dim}>This adapter has no local performance evaluator. Your agent can develop the source using the subnet’s documented tools.</p>:null}
      {confirm?<div role="group" aria-label="Confirm evaluation"><p>Run the subnet evaluator on this candidate? It may use Docker, network access and paid inference with configured credentials. This does not submit or deploy the candidate.</p><button className="agent-action" disabled={busy||running} onClick={()=>{setConfirm(false);void action('evaluate');}}>Confirm evaluation</button><button className="skill-link" disabled={busy} onClick={()=>setConfirm(false)}>Cancel evaluation</button></div>:null}
      {running?<p role="status">Evaluating… Results refresh automatically.</p>:null}
      {view?.job?.status==='failed'?<p role="alert" className="ob-error">{view.job.error||'Evaluation failed. Inspect the experiment history before retrying.'}</p>:null}
      {busy?<p role="status">Working…</p>:null}{error?<p role="alert" className="ob-error">{error}</p>:null}
      {comparison?<p style={styles.dim}>Change from compatible run {comparison.baselineId}: {Object.entries(comparison.deltas).map(([key,n])=>`${key} ${n>=0?'+':''}${n}`).join(', ')}. Whether higher is better depends on the metric.</p>:null}
      {view?.runs.slice(0,10).map(run=><div key={run.id} style={{...styles.dim,marginTop:8,overflowWrap:'anywhere'}}>
        <div>{run.status} · {run.startedAt} · {(run.durationMs/1000).toFixed(1)}s</div>
        <div>{run.repository}/{run.source}</div>
        <div>Source {run.sourceSha256} · commit {run.commit}{run.dirty?' (uncommitted changes)':''}</div>
        {run.result?<div><div>{Object.entries(run.result.metrics).map(([k,n])=>`${k}: ${n}`).join(' · ')}{run.result.costUsd!==undefined?` · $${run.result.costUsd}`:''}</div><div>{run.result.evaluator} · {run.result.dataset}</div><div>{run.result.detail}</div></div>:<div>{run.error}</div>}
      </div>)}
    </div>;
  }
  return {DevelopmentPanel};
}
