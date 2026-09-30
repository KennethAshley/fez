'use client';

import { useEffect, useRef, useState } from 'react';
import { editorRequest, parseResponse, PRESETS, type Answer, type DecisionRequest, type DecisionResponse, type ModelOption } from '@/lib/playground';
import s from '@/components/light.module.css';

type Run = { request: DecisionRequest; response: DecisionResponse; elapsed: number };
const asText = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const percentage = (value: number) => `${(value * 100).toFixed(1)}%`;
const CARD_COLORS = ['bg-[#FF9AD5]', 'bg-[#6C93FF]', 'bg-[#46DFEF]', 'bg-[#FFB36B]'];
const CELLS = 20;
const TEXTAREA = 'w-full resize-y rounded-xl bg-neutral-50 p-4 font-mono text-[13px] leading-6 text-neutral-900 ring-1 ring-neutral-200 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#3455dc]';

/** One answer on the instrument: every option as a block-character bar, winner lit. */
function AnswerCard({ id, question, answer }: { id: string; question: DecisionRequest['questions'][string]; answer: Answer }) {
  const rows = answer.type === 'noul'
    ? [['yes', answer.noul], ['no', 1 - answer.noul]] as const
    : Object.entries(answer.probabilities).map(([key, value]) => [answer.type === 'score' ? `${key} · ${answer.legend[key]}` : key, value] as const);
  const sorted = [...rows].sort((a, b) => b[1] - a[1]);
  const headline = answer.type === 'noul' ? (answer.noul >= 0.5 ? 'yes' : 'no') : answer.type === 'choice' ? answer.choice : `${answer.score.toFixed(2)} / ${rows.length - 1}`;
  return <article className={`border-t border-[#9ee89e]/15 py-5 first:border-t-0 first:pt-0 ${s.lineIn}`}>
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <p className="text-[10px] tracking-[0.14em] text-[#9ee89e]/60">{id.toUpperCase()} · {answer.type === 'noul' ? 'YES / NO' : answer.type.toUpperCase()}</p>
      {answer.type !== 'noul' && <p className="text-[10px] tracking-[0.1em] text-[#9ee89e]/60">CONFIDENCE {percentage(answer.confidence)}</p>}
    </div>
    <h3 className="mt-1 text-[#c9f5c9]">{question.instructions == null ? id : asText(question.instructions)}</h3>
    <dl className="mt-3 space-y-1">
      {sorted.map(([label, value], index) => {
        const filled = Math.round(value * CELLS);
        return <div key={label} className={`grid grid-cols-[minmax(0,8rem)_1fr_3.5rem] items-center gap-2 sm:gap-3 ${index === 0 ? 'text-[#FFB070]' : 'text-[#9ee89e]'}`}>
          <dt className="truncate" title={label}>{label}</dt>
          <dd aria-hidden="true" className="overflow-hidden whitespace-nowrap tracking-[-0.05em]">{'█'.repeat(filled)}<span className="opacity-25">{'░'.repeat(CELLS - filled)}</span></dd>
          <dd className="text-right tabular-nums">{percentage(value)}</dd>
        </div>;
      })}
    </dl>
    <p className="mt-3"><span className={`inline-block rounded-sm border border-[#FFB070]/60 px-2 text-[#FFB070] ${s.stamp}`}>→ {headline}</span></p>
  </article>;
}

export function DecisionPlayground({ configured, models }: { configured: boolean; models: ModelOption[] }) {
  const [preset, setPreset] = useState(0);
  const [state, setState] = useState(asText(PRESETS[0].state));
  const [questions, setQuestions] = useState(asText(PRESETS[0].questions));
  const [model, setModel] = useState(models[0].id);
  const [run, setRun] = useState<Run | null>(null);
  const [view, setView] = useState<'Answers' | 'JSON' | 'API'>('Answers');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState('https://fez.chat');
  const active = useRef<AbortController | null>(null);

  useEffect(() => () => { active.current?.abort(); }, []);

  function changed() { setRun(null); setError(''); setCopied(false); }
  function selectPreset(index: number) {
    changed(); setPreset(index); setState(asText(PRESETS[index].state)); setQuestions(asText(PRESETS[index].questions)); setView('Answers');
  }

  async function decide() {
    if (active.current || !configured) return;
    let input: DecisionRequest;
    try {
      input = editorRequest(state, questions, model);
      if (new TextEncoder().encode(JSON.stringify(input)).length > 32_768) throw new Error('Keep state and questions under 32 KB.');
    } catch (e) { setError((e as Error).message); return; }
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(''); setRun(null); setView('Answers'); setCopied(false);
    const start = performance.now();
    try {
      const response = await fetch('/api/playground', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(65_000)]),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'The request failed. Try again.');
      if (!controller.signal.aborted) setRun({ request: input, response: parseResponse(result, input), elapsed: performance.now() - start });
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error && e.name === 'TimeoutError' ? 'The model took too long. Try again later.' : e instanceof Error ? e.message : 'Could not reach the model. Try again.');
    } finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  }

  let requestCode = 'Fix the questions JSON to generate an API request.';
  try {
    const json = JSON.stringify(editorRequest(state, questions, model), null, 2);
    requestCode = `curl ${origin}/api/playground \\\n  -H 'Content-Type: application/json' \\\n  --data '${json.replace(/'/g, "'\\''")}'`;
  } catch { /* The editor error is shown when Run is pressed. */ }
  const code = view === 'API' ? requestCode : run ? JSON.stringify(run.response, null, 2) : '';

  async function copy() {
    try { await navigator.clipboard.writeText(code); setCopied(true); }
    catch { setError('Clipboard access is unavailable. Select and copy the code directly.'); }
  }

  const status = busy ? 'WAITING FOR FEZ · TIMES OUT AFTER 60 S' : run ? `${Object.keys(run.response.answers).length} ANSWERS RETURNED` : configured ? 'READY' : 'ENDPOINT NOT CONNECTED';

  return <div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Example decisions">
      {PRESETS.map((p, i) => <button type="button" key={p.name} aria-pressed={preset === i} disabled={busy} onClick={() => selectPreset(i)}
        className={`group relative flex min-h-36 flex-col rounded-2xl p-5 text-left transition hover:-translate-y-0.5 disabled:opacity-60 ${CARD_COLORS[i % CARD_COLORS.length]} ${preset === i ? 'ring-2 ring-neutral-950 ring-offset-2' : 'opacity-80 hover:opacity-100'}`}>
        <span className="font-mono text-[10px] tracking-[0.12em] text-black/60">0{i + 1} / {p.tag.toUpperCase()}</span>
        <span className="mt-2 text-lg font-semibold leading-tight tracking-[-0.03em]">{p.name}</span>
        <span className="mt-2 text-xs leading-5 text-black/70">{p.description}</span>
      </button>)}
    </div>

    <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1.1fr]">
      <form className="rounded-2xl bg-white p-5 ring-1 ring-neutral-200 sm:p-6" onSubmit={e => { e.preventDefault(); void decide(); }} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void decide(); } }}>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-neutral-50 px-4 py-3 text-xs ring-1 ring-neutral-200">
          <span className="flex items-center gap-2"><span className={`size-1.5 rounded-full ${configured ? 'bg-emerald-500' : 'bg-[#FF6A00]'}`} aria-hidden="true" /><strong className="font-medium">{models[0].label}</strong></span>
          <label className="flex items-center gap-2 text-neutral-500">Model<select value={model} disabled={busy} onChange={e => { changed(); setModel(e.target.value); }} className="rounded-md bg-white px-2 py-1 text-neutral-900 ring-1 ring-neutral-200">
            {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select></label>
        </div>
        <fieldset disabled={busy} className="space-y-5">
          <div>
            <label htmlFor="decision-state" className="flex items-baseline justify-between text-sm font-medium">Context <span className="text-xs font-normal text-neutral-500">text or JSON the model reads</span></label>
            <textarea id="decision-state" spellCheck={false} value={state} onChange={e => { changed(); setState(e.target.value); }} className={`mt-2 min-h-32 ${TEXTAREA}`} />
          </div>
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor="decision-questions" className="text-sm font-medium">Decisions <span className="text-xs font-normal text-neutral-500">yes/no, choice, or score</span></label>
              <button type="button" className="text-xs text-neutral-500 hover:text-[#3455dc]" onClick={() => {
                try { setQuestions(JSON.stringify(JSON.parse(questions), null, 2)); setError(''); } catch { setError('Questions must be valid JSON before formatting.'); }
              }}>Format JSON</button>
            </div>
            <textarea id="decision-questions" spellCheck={false} autoCapitalize="off" autoCorrect="off" value={questions} onChange={e => { changed(); setQuestions(e.target.value); }} className={`mt-2 min-h-72 ${TEXTAREA}`} />
          </div>
        </fieldset>
        {error && <p role="alert" className="mt-4 rounded-lg bg-orange-50 px-4 py-3 text-sm text-[#B84A00]">{error}</p>}
        <div className="mt-5 flex flex-wrap items-center gap-4">
          <button type="submit" disabled={busy || !configured} className="inline-flex items-center gap-6 rounded-md bg-neutral-950 px-5 py-3 text-[13px] font-medium text-white transition hover:-translate-y-0.5 hover:bg-[#3455dc] disabled:translate-y-0 disabled:bg-neutral-300 disabled:text-neutral-500">
            {busy ? 'Deciding…' : 'Run decisions'}<span aria-hidden="true" className="font-mono text-[11px] opacity-70">⌘ ↵</span>
          </button>
          {busy ? <button type="button" className="text-sm text-neutral-600 hover:text-neutral-950" onClick={() => { active.current?.abort(); setError('Request canceled.'); }}>Cancel</button> : <span className="text-xs text-neutral-500">One request. Every decision.</span>}
        </div>
        <p className="mt-3 text-[11px] leading-5 text-neutral-500">Run sends your input to Fez’s model server. Use non-sensitive examples.</p>
      </form>

      <section aria-label="Decision results" aria-busy={busy} className="flex min-w-0 flex-col rounded-[22px] bg-white/60 p-2.5 ring-1 ring-neutral-200">
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2 pt-1">
          <div role="tablist" aria-label="Result view" className="flex gap-1">{(['Answers', 'JSON', 'API'] as const).map(tab => <button type="button" role="tab" key={tab} aria-selected={view === tab} onClick={() => { setView(tab); setCopied(false); setOrigin(window.location.origin); }}
            className={view === tab ? 'rounded-full bg-neutral-950 px-3.5 py-1 text-xs font-medium text-white' : 'rounded-full px-3.5 py-1 text-xs text-neutral-600 hover:text-neutral-950'}>{tab}</button>)}</div>
          {code && view !== 'Answers' ? <button type="button" className="text-xs text-neutral-600 hover:text-[#3455dc]" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
            : <span className="font-mono text-[10px] tracking-[0.14em] text-neutral-500">FEZ · DECISION INSTRUMENT</span>}
        </div>
        <div className={`relative min-h-[520px] flex-1 overflow-hidden rounded-2xl bg-[#0c0f0c] px-5 py-5 font-mono text-[12.5px] leading-6 sm:px-6 ${s.tube}`}>
          <span aria-hidden="true" className={`pointer-events-none absolute inset-0 ${s.scanlinesDark}`} />
          <div className={`relative ${s.phosphor}`}>
            <p role="status" className="mb-5 flex items-center gap-2 border-b border-[#9ee89e]/15 pb-3 text-[10px] tracking-[0.14em] text-[#9ee89e]/70">
              <span className={`size-1.5 rounded-full ${busy ? `bg-[#FFB070] ${s.cursor}` : configured ? 'bg-[#9ee89e]' : 'bg-[#FF6A00]'}`} aria-hidden="true" />{status}
            </p>
            {view === 'API' ? <>
              <p className="mb-3 text-[#9ee89e]/70">Send the same context and typed decisions from your own code. This request uses the Fez endpoint on this website.</p>
              <pre className="overflow-x-auto whitespace-pre text-[#c9f5c9]"><code>{requestCode}</code></pre>
            </> : run ? <>
              <p className="mb-5 flex flex-wrap gap-x-4 gap-y-1 text-[10px] tracking-[0.08em] text-[#9ee89e]/60">
                <span>{run.response.model}</span><span>{Math.round(run.response.latency_ms).toLocaleString()} MS MODEL TIME</span><span>{run.response.usage.input_tokens.toLocaleString()} INPUT TOKENS</span><span>{(run.elapsed / 1000).toFixed(1)} S TOTAL</span>
              </p>
              {view === 'JSON' ? <pre className="overflow-x-auto whitespace-pre text-[#c9f5c9]"><code>{code}</code></pre> : <>
                {Object.entries(run.response.answers).map(([id, answer]) => <AnswerCard key={id} id={id} question={run.request.questions[id]} answer={answer} />)}
                <p className="mt-4 text-[11px] text-[#9ee89e]/50">Bars show each option’s probability. Confidence is a separate model statistic, not a guarantee of correctness.</p>
              </>}
            </> : <div className="grid min-h-[400px] place-items-center text-center">
              <div>
                <p className="text-3xl text-[#FF6A00]" aria-hidden="true">▴</p>
                <h2 className="mt-4 text-base text-[#c9f5c9]">{busy ? 'Reading your decisions.' : configured ? 'Context in. Probabilities out.' : 'The Fez endpoint isn’t connected.'}</h2>
                <p className="mx-auto mt-2 max-w-xs text-[12px] leading-5 text-[#9ee89e]/60">{busy ? 'Answers appear here when the model finishes.' : configured ? 'Pick a use case or write your own, then run it to see the probability of every option.' : 'You can still explore the examples and copy the API request. Live answers appear once the model endpoint is connected.'}</p>
                {!busy && <span className={`mt-6 inline-block h-4 w-2 bg-[#9ee89e] ${s.cursor}`} aria-hidden="true" />}
              </div>
            </div>}
          </div>
        </div>
      </section>
    </div>
  </div>;
}
