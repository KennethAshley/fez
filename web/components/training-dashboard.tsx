'use client';

import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { canDownload, DOWNLOAD_FILES, MAX_DATASET_BYTES, SPLITS, STATUS_COPY, submissionSchema, terminal, trainingApi, TrainingApiError, validateDatasets, type Job, type Split } from '@/lib/training';
import styles from '@/app/(home)/train/train.module.css';

type Config = { url: string; key: string; apiUrl: string };
const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
const label = (status: string) => status.replaceAll('_', ' ');
const metric = (value: number | undefined, percent = false) => value === undefined ? '—' : percent ? `${(value * 100).toFixed(2)}%` : value.toFixed(4);
const EXAMPLE = '{"id":"case-001","group_id":"source-001","family":"model-selection","state":{"task":"Look up a known value"},"question":{"type":"choice","criteria":{"small":"Small model","large":"Large model"}},"label":"small"}';

export function TrainingDashboard({ config }: { config: Config }) {
  const [client] = useState(() => createClient(config.url, config.key, { auth: { storageKey: 'fez-training-auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }));
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const { data } = client.auth.onAuthStateChange((_event, next) => { if (active) { setSession(next); setNotice(''); } });
    client.auth.getSession().then(({ data, error }) => { if (active) { setSession(data.session); if (error) setError(error.message); } }).catch(error => { if (active) { setError(message(error)); setSession(null); } });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, [client]);
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const { error } = await client.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: `${window.location.origin}/train` } });
      if (error) throw error;
      setNotice('Check your email for a sign-in link. Open it to return to your training dashboard.');
    } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  async function signOut() {
    setError('');
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) setError(error.message);
  }
  if (session === undefined) return <p role="status" className={styles.panel}>Checking your session…</p>;
  return <>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {session ? <>
      <div className={styles.account}><span>Signed in as <strong>{session.user.email || 'your account'}</strong></span><button className={styles.secondary} onClick={signOut}>Sign out</button></div>
      <SignedInDashboard key={session.user.id} client={client} config={config} onExpired={signOut} />
    </> : <section className={`${styles.panel} ${styles.signIn}`}><span className={styles.badge}>Private workspace</span><h2>Sign in to your training jobs.</h2><p>Use an email link to access your own datasets and results.</p><form onSubmit={signIn}><label htmlFor="training-email">Email address</label><input id="training-email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" disabled={busy} /><button className={styles.button} disabled={busy}>{busy ? 'Sending link…' : 'Email me a sign-in link'}</button></form>{notice && <p role="status" className={styles.notice}>{notice}</p>}</section>}
  </>;
}

function SignedInDashboard({ client, config, onExpired }: { client: SupabaseClient; config: Config; onExpired: () => Promise<void> }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [cancellable, setCancellable] = useState(false);
  const [name, setName] = useState('');
  const [accuracy, setAccuracy] = useState('0.8');
  const [improvement, setImprovement] = useState('0.01');
  const [consent, setConsent] = useState(false);
  const [files, setFiles] = useState<Partial<Record<Split, File>>>({});
  const [downloads, setDownloads] = useState<{ name: string; url: string }[]>([]);
  const [formVersion, setFormVersion] = useState(0);
  const life = useRef<AbortController | null>(null);
  const operation = useRef<AbortController | null>(null);
  const selected = jobs.find(job => job.id === selectedId);
  const api = useMemo(() => trainingApi(config.apiUrl, config.url, async () => {
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    return data.session?.access_token || '';
  }), [config.apiUrl, config.url, client]);
  const handleError = useCallback((error: unknown) => {
    if (error instanceof TrainingApiError && error.status === 401) { void onExpired(); return; }
    setError(message(error));
  }, [onExpired]);
  // A ref avoids restarting polling whenever the auth wrapper rerenders.
  const errorHandler = useRef(handleError);
  useEffect(() => { errorHandler.current = handleError; }, [handleError]);
  useEffect(() => {
    const controller = new AbortController(); life.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const { jobs } = await api.list(controller.signal);
        if (controller.signal.aborted) return;
        setJobs(jobs); setLoading(false);
        if (jobs.some(job => !terminal(job) && job.status !== 'uploading')) timer = setTimeout(poll, 10_000);
      } catch (error) { if (!controller.signal.aborted) { errorHandler.current(error); setLoading(false); timer = setTimeout(poll, 30_000); } }
    }
    void poll();
    return () => { controller.abort(); operation.current?.abort(); clearTimeout(timer); };
  }, [api, formVersion]);

  const refresh = async () => {
    setError('');
    try { const { jobs } = await api.list(life.current?.signal); if (!life.current?.signal.aborted) setJobs(jobs); } catch (error) { if (!life.current?.signal.aborted) handleError(error); }
  };
  function replaceJob(job: Job) { setJobs(previous => [job, ...previous.filter(other => other.id !== job.id)]); }
  async function selectJob(job: Job) {
    setSelectedId(job.id); setDownloads([]); setError('');
    try { const { job: updated } = await api.get(job.id, life.current?.signal); if (!life.current?.signal.aborted) replaceJob(updated); } catch (error) { if (!life.current?.signal.aborted) handleError(error); }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setDownloads([]);
    const parsed = submissionSchema.safeParse({ name, acceptance: { min_accuracy: accuracy === '' ? NaN : Number(accuracy), min_brier_improvement: improvement === '' ? NaN : Number(improvement) }, allow_training_data_export: consent });
    if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
    const { train, calibration, test } = files;
    if (!train || !calibration || !test) { setError('Choose all three independently prepared dataset splits.'); return; }
    const datasets = { train, calibration, test };
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setCancellable(true); setProgress('Validating files locally…');
    let createdId = '';
    try {
      await validateDatasets(datasets, controller.signal);
      setProgress('Creating your job…');
      const { job, uploads } = await api.create(parsed.data, controller.signal);
      createdId = job.id; replaceJob(job); setSelectedId(job.id);
      for (const split of SPLITS) {
        setProgress(`Uploading ${split} directly to private storage…`);
        const slot = uploads[split];
        if (!('uploaded' in slot)) await api.upload(split, slot, datasets[split], controller.signal);
      }
      setProgress('Submitting for validation…');
      const submitted = await api.submit(job.id, controller.signal);
      replaceJob(submitted.job); setProgress('Submitted. The coordinator will validate the data before worker approval.');
      setFiles({}); setName(''); setConsent(false); setFormVersion(v => v + 1);
    } catch (error) {
      if (controller.signal.aborted) setProgress('Stopped locally. Any created job and completed uploads remain in your workspace.');
      else { handleError(error); setProgress(createdId ? 'Your job is saved. Retry submission if all uploads finished, or resume missing uploads using the original files.' : 'No successful submission confirmed. Refresh the job list before creating another job.'); }
    } finally { if (!life.current?.signal.aborted) setBusy(false); setCancellable(false); operation.current = null; }
  }
  async function resumeUploads(job: Job) {
    const { train, calibration, test } = files;
    if (!train || !calibration || !test) { setError('Reselect all three original files in the form before resuming. Completed uploads will be skipped.'); return; }
    const datasets = { train, calibration, test };
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setCancellable(true); setError(''); setProgress('Checking original files…');
    try {
      await validateDatasets(datasets, controller.signal);
      const { uploads } = await api.resume(job.id, controller.signal);
      for (const split of SPLITS) {
        const slot = uploads[split];
        if ('uploaded' in slot) continue;
        setProgress(`Resuming ${split} upload…`);
        await api.upload(split, slot, datasets[split], controller.signal);
      }
      const result = await api.submit(job.id, controller.signal);
      replaceJob(result.job); setFiles({}); setFormVersion(v => v + 1);
      setProgress('Uploads complete. Submitted for validation.');
    } catch (error) { if (controller.signal.aborted) setProgress('Stopped locally. Saved uploads remain.'); else handleError(error); }
    finally { setBusy(false); setCancellable(false); operation.current = null; }
  }
  async function cancelJob(job: Job) {
    setBusy(true); setError(''); setDownloads([]);
    try { const result = await api.cancel(job.id, life.current?.signal); replaceJob(result.job); }
    catch (error) { if (!life.current?.signal.aborted) handleError(error); }
    finally { setBusy(false); }
  }
  async function retrySubmit(job: Job) {
    setBusy(true); setError(''); setDownloads([]);
    try { const result = await api.submit(job.id, life.current?.signal); replaceJob(result.job); setFormVersion(v => v + 1); }
    catch (error) { if (!life.current?.signal.aborted) handleError(error); }
    finally { setBusy(false); }
  }
  async function getDownloads(job: Job) {
    setBusy(true); setError(''); setDownloads([]);
    try { const items = await api.downloads(job, life.current?.signal); if (!life.current?.signal.aborted) setDownloads(items); }
    catch (error) { if (!life.current?.signal.aborted) handleError(error); }
    finally { setBusy(false); }
  }
  return <>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.grid}>
      <section className={styles.panel}><span className={styles.eyebrow}>01 / NEW JOB</span><h2>Train against your standard.</h2>
        <form onSubmit={create}>
          <fieldset disabled={busy}><legend className="sr-only">Job settings and dataset files</legend>
            <label htmlFor="job-name">Job name</label><input id="job-name" required pattern="[a-z0-9][a-z0-9-]{0,63}" maxLength={64} value={name} onChange={e => setName(e.target.value)} placeholder="model-selection-v1" /><small>Lowercase letters, digits, and hyphens. Use a new name for changed datasets.</small>
            <div className={styles.fields}><div><label htmlFor="min-accuracy">Minimum accuracy</label><input id="min-accuracy" type="number" required min="0" max="1" step="any" value={accuracy} onChange={e => setAccuracy(e.target.value)} /><small>0–1; 0.8 means 80%.</small></div><div><label htmlFor="min-brier">Minimum Brier improvement</label><input id="min-brier" type="number" required min="0" max="2" step="any" value={improvement} onChange={e => setImprovement(e.target.value)} /><small>Absolute loss decrease, 0–2. Not a percentage.</small></div></div>
            <p className={styles.help}>Candidates must meet the accuracy floor and improve on the calibrated baseline. A completed job may produce no qualifying model. Up to five active jobs per account.</p>
            <div key={formVersion}>{SPLITS.map(split => <div key={split} className={styles.file}><label htmlFor={`dataset-${split}`}>{label(split)} dataset</label><input id={`dataset-${split}`} type="file" accept=".jsonl,application/jsonl,application/x-ndjson" required onChange={e => { const file = e.target.files?.[0]; setFiles(previous => ({ ...previous, [split]: file })); if (file && file.size > MAX_DATASET_BYTES) setError(`${split}: maximum file size is 128 MiB.`); }} /><small>JSONL · 128 MiB maximum{files[split] ? ` · ${(files[split]!.size / 1024).toFixed(1)} KiB selected` : ''}</small></div>)}</div>
            <details className={styles.details}><summary>Dataset format and separation</summary><p>Every row needs id, group_id, family, state, question, and label. Questions support noul (true/false), choice, or score; labels must match a valid outcome.</p><pre>{EXAMPLE}</pre><p>IDs must be unique. Keep related source groups and exact prompts in one split. Calibration and test must contain the same families, all represented in training. Local checks do not detect semantic duplicates or prove permission to use the data. The server validates again.</p></details>
            <label className={styles.consent}><input type="checkbox" required checked={consent} onChange={e => setConsent(e.target.checked)} /><span>I am authorized to use these datasets and permit training data to be copied to assigned, approved workers. Those operators can read and retain it. This is not confidential compute. Calibration and test data stay with the validator.</span></label>
          </fieldset>
          <div className={styles.actions}><button className={styles.button} disabled={busy}>{busy ? 'Working…' : 'Validate, upload & submit'}</button>{busy && cancellable && <button type="button" className={styles.secondary} onClick={() => operation.current?.abort()}>Stop</button>}</div>
          {progress && <p role="status" className={styles.notice}>{progress}</p>}
        </form>
      </section>
      <section className={styles.panel}><div className={styles.panelHeader}><div><span className={styles.eyebrow}>02 / YOUR JOBS</span><h2>Follow the evidence.</h2></div><button className={styles.secondary} onClick={refresh} disabled={busy}>Refresh</button></div>
        {loading ? <p role="status">Loading your jobs…</p> : jobs.length === 0 ? <p className={styles.empty}>No jobs yet. Submitted jobs will appear here.</p> : <ul className={styles.jobs}>{jobs.map(job => <li key={job.id}><button disabled={busy} className={styles.jobButton} aria-pressed={selectedId === job.id} onClick={() => selectJob(job)}><strong>{job.name}</strong><span className={styles.badge}>{label(job.status)}</span></button></li>)}</ul>}
        {selected && <div className={styles.jobDetail}><h3>{selected.name}</h3><p className={styles.id}>{selected.id}</p>{selected.created_at && <p className={styles.help}>Created {new Date(selected.created_at).toLocaleString()}</p>}<p className={styles.notice} role="status">{STATUS_COPY[selected.status]}</p>{selected.error && <p role="alert" className={styles.error}>{selected.error}</p>}
          {selected.status === 'uploading' && <><p className={styles.help}>If all three uploads completed, retry submission. To resume a failed upload, reselect the three original files in the form. Completed uploads are skipped; existing files are not overwritten.</p><button className={styles.secondary} disabled={busy} onClick={() => retrySubmit(selected)}>Retry submission</button><button className={styles.secondary} disabled={busy} onClick={() => resumeUploads(selected)}>Resume missing uploads</button><button className={styles.secondary} disabled={busy} onClick={() => cancelJob(selected)}>Cancel this job</button></>}
          {selected.status === 'completed' && !selected.result && <p>Result details are not available yet. Refresh to try again.</p>}
          {selected.result && <><h3 className={styles.resultTitle}>{selected.result.delivery.status === 'accepted' ? 'A model met your criteria.' : 'No model met your criteria.'}</h3><p className={styles.help}>Measured on this job’s held-out data; not a guarantee on future inputs. Artifact delivery does not deploy an inference endpoint.</p><div className={styles.metrics}><div><span>Baseline accuracy</span><strong>{metric(selected.result.baseline.accuracy, true)}</strong></div><div><span>Baseline Brier loss</span><strong>{metric(selected.result.baseline.brier)}</strong></div></div><p className={styles.help}>Required: {metric(selected.result.delivery.acceptance.min_accuracy, true)} accuracy; {metric(selected.result.delivery.acceptance.min_brier_improvement)} absolute Brier improvement.</p>
            <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Candidate evaluations"><table><thead><tr><th>Candidate</th><th>Status</th><th>Accuracy</th><th>Brier ↓</th></tr></thead><tbody>{selected.result.miners.map(miner => <tr key={miner.uid}><th>{miner.uid}{selected.result?.delivery.uid === miner.uid ? ' · selected' : ''}</th><td>{miner.status}</td><td>{metric(miner.accuracy, true)}</td><td>{metric(miner.brier)}</td></tr>)}</tbody></table></div>
            {selected.result.delivery.sha256 && <p className={styles.hash}>Checkpoint SHA-256<br /><code>{selected.result.delivery.sha256}</code></p>}
            {canDownload(selected) && <><button disabled={busy} className={styles.button} onClick={() => getDownloads(selected)}>Get private download links</button><p className={styles.help}>Links expire. Generate fresh links when needed. Files: {DOWNLOAD_FILES.join(', ')}.</p>{downloads.length > 0 && <ul className={styles.downloads}>{downloads.map(file => <li key={file.name}><a href={file.url} target="_blank" rel="noreferrer">{file.name} ↗</a></li>)}</ul>}</>}
          </>}
        </div>}
      </section>
    </div>
  </>;
}
