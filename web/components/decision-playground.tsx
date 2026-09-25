'use client';

import { useEffect, useRef, useState } from 'react';
import { editorRequest, parseResponse, PRESETS, type Answer, type DecisionRequest, type DecisionResponse, type ModelOption } from '@/lib/playground';
import styles from './decision-playground.module.css';

type Run = { request: DecisionRequest; response: DecisionResponse; elapsed: number };
const asText = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const percentage = (value: number) => `${(value * 100).toFixed(1)}%`;

function AnswerCard({ id, question, answer }: { id: string; question: DecisionRequest['questions'][string]; answer: Answer }) {
  const rows = answer.type === 'noul'
    ? [['Yes', answer.noul], ['No', 1 - answer.noul]] as const
    : Object.entries(answer.probabilities).map(([key, value]) => [answer.type === 'score' ? `${key} · ${answer.legend[key]}` : key, value] as const);
  const sorted = [...rows].sort((a, b) => b[1] - a[1]);
  const headline = answer.type === 'noul' ? (answer.noul >= 0.5 ? 'Yes' : 'No') : answer.type === 'choice' ? answer.choice : `${answer.score.toFixed(2)} / ${rows.length - 1}`;
  return <article className={styles.answer}>
    <div className={styles.answerIntro}>
      <p className={styles.questionId}>{id} <span>{answer.type === 'noul' ? 'yes / no' : answer.type}</span></p>
      <h3>{question.instructions == null ? id : asText(question.instructions)}</h3>
      <p className={styles.winner}>{headline}</p>
      {answer.type !== 'noul' && <p className={styles.confidence}>Confidence {percentage(answer.confidence)}</p>}
    </div>
    <dl className={styles.probabilities}>
      {sorted.map(([label, value], index) => <div key={label} className={index === 0 ? styles.leading : undefined}>
        <dt title={label}>{label}</dt>
        <dd><span className={styles.track} aria-hidden="true"><span style={{ width: `${value * 100}%` }} /></span><span>{percentage(value)}</span></dd>
      </div>)}
    </dl>
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

  return <div className={styles.playground}>
    <div className={styles.sourceNotice}>
      <div><span className={styles.statusDot} aria-hidden="true" /><strong>{models[0].label}</strong><span>{configured ? 'Fez model endpoint' : 'Endpoint not connected'}</span></div>
      <p>{configured ? 'Runs use our Fez checkpoint. This is an experimental model; inspect the probabilities before relying on an answer.' : 'You can explore the examples. Live answers become available when the Fez model endpoint is connected.'}</p>
    </div>
    <div className={styles.toolbar}>
      <div className={styles.presets} aria-label="Example requests">
        {PRESETS.map((p, i) => <button type="button" key={p.name} aria-pressed={preset === i} disabled={busy} onClick={() => selectPreset(i)}>{p.name}</button>)}
      </div>
      <label className={styles.modelLabel}>Model<select value={model} disabled={busy} onChange={e => { changed(); setModel(e.target.value); }}>
        {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select></label>
    </div>
    <p className={styles.presetDescription}>{PRESETS[preset].description}</p>
    <div className={styles.columns}>
      <form className={styles.editor} onSubmit={e => { e.preventDefault(); void decide(); }} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void decide(); } }}>
        <fieldset disabled={busy}>
          <label htmlFor="decision-state">State <span>The text or JSON the model reads</span></label>
          <textarea id="decision-state" spellCheck={false} value={state} onChange={e => { changed(); setState(e.target.value); }} className={styles.state} />
          <div className={styles.questionLabel}><label htmlFor="decision-questions">Questions <span>yes/no, choice, or score</span></label><button type="button" onClick={() => {
            try { setQuestions(JSON.stringify(JSON.parse(questions), null, 2)); setError(''); } catch { setError('Questions must be valid JSON before formatting.'); }
          }}>Format JSON</button></div>
          <textarea id="decision-questions" spellCheck={false} autoCapitalize="off" autoCorrect="off" value={questions} onChange={e => { changed(); setQuestions(e.target.value); }} className={styles.questions} />
        </fieldset>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.runControls}>
          <button type="submit" className={styles.runButton} disabled={busy || !configured}>{busy ? 'Running…' : 'Run questions'}<span aria-hidden="true">⌘ ↵</span></button>
          {busy ? <button type="button" onClick={() => { active.current?.abort(); setError('Request canceled.'); }}>Cancel</button> : <span>One request. Every question.</span>}
        </div>
        <p className={styles.privacy}>Run sends your input to Fez’s model server. Use non-sensitive examples.</p>
      </form>
      <section className={styles.results} aria-label="Decision results" aria-busy={busy}>
        <div className={styles.resultToolbar}>
          <div className={styles.views} aria-label="Result view">{(['Answers', 'JSON', 'API'] as const).map(tab => <button type="button" key={tab} aria-pressed={view === tab} onClick={() => { setView(tab); setCopied(false); setOrigin(window.location.origin); }}>{tab}</button>)}</div>
          {code && view !== 'Answers' && <button type="button" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>}
        </div>
        <div role="status" className={styles.resultStatus}>
          {busy ? 'Waiting for Fez. Requests time out after 60 seconds.' : run ? `${Object.keys(run.response.answers).length} answers returned` : configured ? 'Ready when you are.' : 'Waiting for the Fez endpoint.'}
        </div>
        {view === 'API' ? <><p className={styles.apiNote}>Send the same state and typed questions from your own code. This request uses the Fez endpoint on this website.</p><pre className={styles.code}><code>{requestCode}</code></pre></> : run ? <>
          <div className={styles.runMeta}><span>{run.response.model}</span><span>{Math.round(run.response.latency_ms).toLocaleString()} ms model time</span><span>{run.response.usage.input_tokens.toLocaleString()} input tokens</span><span>{(run.elapsed / 1000).toFixed(1)} s total, including queue</span></div>
          {view === 'JSON' ? <pre className={styles.code}><code>{code}</code></pre> : <>
            {Object.entries(run.response.answers).map(([id, answer]) => <AnswerCard key={id} id={id} question={run.request.questions[id]} answer={answer} />)}
            <p className={styles.resultFootnote}>Bars show each option’s probability. Confidence is a separate model statistic, not a guarantee of correctness.</p>
          </>}
        </> : <div className={styles.empty}>
          <span className={styles.emptyMark} aria-hidden="true">▴</span>
          <h2>{busy ? 'Reading your questions.' : 'See how the model decides.'}</h2>
          <p>{busy ? 'Your answers will appear here when the model finishes.' : 'Choose an example or write your own. Run it to see the answer and probability of every option.'}</p>
          {!busy && <p className={styles.emptyTypes}><span>Yes / no</span><span>Choice</span><span>Score</span></p>}
        </div>}
      </section>
    </div>
  </div>;
}
