import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { dmConvoKey, INPUT_WAIT_MS, validateInputResponse, type FezClient, type InputAnswers, type InputResponse, type PendingInput, type InputHistoryEntry } from "@fezchat/client";
import { notifyEvent } from "./notify";

const draftPrefix = (ownerPk: string) => `fez-input-draft:${ownerPk}:`;
const draftKey = (ownerPk: string, request: PendingInput) => draftPrefix(ownerPk) + request.id;
function removeDraft(key: string) {
  try { localStorage.removeItem(key); } catch { /* Storage may be unavailable; answering must still work. */ }
}

function readDraft(key: string, request: PendingInput): { values: InputAnswers; step: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    if (saved?.expiresAt !== request.expiresAt || saved.expiresAt <= Date.now() || saved.form !== JSON.stringify(request.form)
      || !saved.values || typeof saved.values !== "object" || Array.isArray(saved.values)) throw new Error("Stale draft");
    const values: InputAnswers = {};
    // Drafts may be incomplete or invalid (a half-written email, for example).
    // Restore only this form's fields; full validation stays at submission.
    for (const field of request.form.fields) {
      const value: unknown = saved.values[field.id];
      if (field.type === "array") {
        if (Array.isArray(value) && value.length <= 64 && value.every(v => typeof v === "string" && field.options?.some(o => o.value === v))) values[field.id] = value;
      } else if (typeof value === "string" && value.length <= 8000 && (!field.options || field.options.some(o => o.value === value))) values[field.id] = value;
    }
    return { values, step: Number.isInteger(saved.step) && saved.step >= 0 && saved.step < request.form.fields.length ? saved.step : 0 };
  } catch { removeDraft(key); return { values: {}, step: 0 }; }
}

function pruneDrafts(client: FezClient) {
  const finished = new Set(client.inputHistory().filter(entry => entry.status !== "pending").map(entry => draftKey(client.pubkey, entry)));
  try {
    for (const key of Object.keys(localStorage).filter(key => key.startsWith(draftPrefix(client.pubkey)))) {
      try {
        const saved = JSON.parse(localStorage.getItem(key) ?? "null");
        if (finished.has(key) || !Number.isFinite(saved?.expiresAt) || saved.expiresAt <= Date.now()) removeDraft(key);
      } catch { removeDraft(key); }
    }
  } catch { /* Storage may be unavailable. */ }
}

export function InputCard({ request, ownerPk, name, onAnswer, response, awaitingReceipt = false }: {
  request: PendingInput;
  ownerPk: string;
  name: string;
  onAnswer: (response: InputResponse) => Promise<void>;
  response?: InputResponse;
  awaitingReceipt?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [sentLocally, setSent] = useState(false);
  const sent = awaitingReceipt || sentLocally;
  const key = draftKey(ownerPk, request);
  const [draft] = useState(() => response ? { values: {}, step: 0 } : readDraft(key, request));
  const answers = response?.action === "accept" ? response.content : draft.values;
  const [step, setStep] = useState(draft.step);
  const lastStep = step === request.form.fields.length - 1;
  const formRef = useRef<HTMLFormElement>(null);
  const previousStep = useRef(step);
  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    formRef.current?.querySelector<HTMLElement>(".input-question:not([hidden]) legend")?.focus();
  }, [step]);
  const [draftError, setDraftError] = useState("");
  const [error, setError] = useState("");
  const saveDraft = (form: HTMLFormElement, position = step) => {
    if (sent || busy || request.expiresAt <= Date.now()) return;
    const data = new FormData(form);
    const values = Object.fromEntries(request.form.fields.flatMap(field => {
      const values = data.getAll(field.id).map(String).filter(value => value !== "");
      return values.length ? [[field.id, field.type === "array" ? values : values[0]]] : [];
    }));
    try {
      if (Object.keys(values).length || position > 0) localStorage.setItem(key, JSON.stringify({ expiresAt: request.expiresAt, form: JSON.stringify(request.form), values, step: position }));
      else localStorage.removeItem(key);
      setDraftError("");
    } catch { setDraftError("Draft could not be saved on this device. Keep this question open until you submit."); }
  };
  const moveTo = (position: number) => {
    if (formRef.current) saveDraft(formRef.current, position);
    setError("");
    setStep(position);
  };
  const answer = async (response: InputResponse) => {
    setBusy(true);
    setError("");
    try {
      await onAnswer(validateInputResponse(request.form, response));
      removeDraft(key);
      setDraftError("");
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const content: InputAnswers = {};
    for (const field of request.form.fields) {
      const values = data.getAll(field.id).map(String);
      if (!values.length || values[0] === "") continue;
      content[field.id] = field.type === "array" ? values : field.type === "boolean" ? values[0] === "true"
        : field.type === "number" || field.type === "integer" ? Number(values[0]) : values[0];
    }
    // Hidden steps remain mounted so Back and FormData retain every answer.
    // Validate before moving; on Send, return to any earlier invalid field.
    for (const field of lastStep ? request.form.fields : [request.form.fields[step]]) {
      try {
        // Browsers expose an unfinished number/date as "", which would
        // otherwise silently skip an optional answer with noValidate.
        const controls = event.currentTarget.querySelectorAll(".input-question")[request.form.fields.indexOf(field)]
          .querySelectorAll<HTMLInputElement>("input");
        if ([...controls].some(control => control.validity.badInput)) throw new Error(`${field.title}: enter a complete ${field.type === "number" || field.type === "integer" ? "number" : "value"}`);
        validateInputResponse({ message: request.form.message, fields: [field] }, { action: "accept", content: content[field.id] === undefined ? {} : { [field.id]: content[field.id] } });
      } catch (e) {
        moveTo(request.form.fields.indexOf(field));
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    if (lastStep) void answer({ action: "accept", content });
    else moveTo(step + 1);
  };
  return <section className="input-card" aria-label={`Questions from ${name}`}>
    <header><span className="input-progress" aria-live="polite">{request.form.fields.length > 1 ? `Question ${step + 1} of ${request.form.fields.length}` : "Question"}</span><span>@{name}</span></header>
    <form ref={formRef} noValidate onSubmit={submit} onInput={event => saveDraft(event.currentTarget)}>
      <p className="input-message">{request.form.message}</p>
      <fieldset disabled={busy} className="input-fields">
        {request.form.fields.map((field, index) => <fieldset key={field.id} className="input-question" hidden={index !== step}>
          <legend tabIndex={-1}>{field.title}{!field.required && <span className="input-optional"> (optional)</span>}</legend>
          {field.description && <p>{field.description}</p>}
          {field.type === "array" && <p>Choose all that apply.</p>}
          {field.options ? field.options.map((option, index) => <label className="input-choice" key={option.value}>
            <input type={field.type === "array" ? "checkbox" : "radio"} name={field.id} value={option.value} defaultChecked={Array.isArray(answers[field.id]) ? (answers[field.id] as string[]).includes(option.value) : answers[field.id] === option.value} required={field.required && field.type !== "array"} />
            <span className="input-choice-number" aria-hidden="true">{index + 1}</span>
            <span className="input-choice-copy">{option.label.replace(/\s*\(recommended\)$/i, "")}{/\(recommended\)$/i.test(option.label) && <span className="input-recommended">Recommended</span>}{option.description && <small>{option.description}</small>}</span>
            <span className="input-choice-check" aria-hidden="true">✓</span>
          </label>) : field.type === "boolean" ? <select name={field.id} aria-label={field.title} required={field.required} defaultValue={answers[field.id] === undefined ? "" : String(answers[field.id])}>
            <option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option>
          </select> : field.type === "number" || field.type === "integer" ? <input name={field.id} aria-label={field.title} type="number" defaultValue={String(answers[field.id] ?? "")} required={field.required} min={field.min} max={field.max} step={field.type === "integer" ? 1 : "any"} />
            : field.format ? <input defaultValue={String(answers[field.id] ?? "")} name={field.id} aria-label={field.title} type={field.format === "uri" ? "url" : field.format === "date-time" ? "text" : field.format} placeholder={field.format === "date-time" ? "2026-09-10T14:00:00Z" : undefined} required={field.required} minLength={field.min} maxLength={field.max ?? 8000} />
              : <textarea name={field.id} aria-label={field.title} placeholder="Write your response…" defaultValue={String(answers[field.id] ?? "")} required={field.required} minLength={field.min} maxLength={field.max ?? 8000} rows={2} />}
        </fieldset>)}
      </fieldset>
      {error && <p className="input-error" role="alert">{error}</p>}
      {draftError && <p className="input-error" role="alert">{draftError}</p>}
      {sent && <p role="status">Waiting for agent to acknowledge your answers…</p>}
      <footer>
        <div className="input-footer-note">{!sent && <p className="input-waiting">Waiting for your answer</p>}<span>Private to @{name}</span></div>
        {request.form.fields.length > 1 && <button type="button" disabled={busy || step === 0} onClick={() => moveTo(step - 1)}>Back</button>}
        <button type="button" disabled={busy} title="Skip this request" onClick={() => void answer({ action: "decline" })}>Skip</button>
        <button type="submit" disabled={busy}>{busy ? "Sending…" : !lastStep ? "Next" : sent ? "Send again" : "Send"}</button>
      </footer>
    </form>
  </section>;
}

export default function AgentInput({ client, onOpen }: { client: FezClient; onOpen?: (request: PendingInput) => void }) {
  const [, render] = useReducer(n => n + 1, 0);
  const [open, setOpen] = useState(false);
  const [fallbackId, setFallbackId] = useState<string>();
  const [tab, setTab] = useState<"waiting" | "history">("waiting");
  const [loading, setLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const panel = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const close = () => { setOpen(false); returnFocus.current?.focus(); };
  const loadHistory = useCallback(async () => {
    setTab("history"); setLoading(true); setHistoryError("");
    try { await client.loadInputHistory(); }
    catch { setHistoryError("History could not load. Try again."); }
    finally { setLoading(false); }
  }, [client]);
  useEffect(() => {
    pruneDrafts(client);
    void client.loadInputHistory().catch(() => setHistoryError("History could not load. Try again."));
    let known = new Set(client.pendingInputs().map(request => request.id));
    const offInputs = client.on("inputsChanged", () => {
      pruneDrafts(client);
      const requests = client.pendingInputs();
      for (const id of known) if (!requests.some(request => request.id === id)) removeDraft(draftPrefix(client.pubkey) + id);
      for (const request of requests) {
        if (known.has(request.id)) continue;
        notifyEvent({ key: `question:${request.id}`, kind: "needs_action", title: `${client.displayName(request.agentPk)} needs your input`,
          body: "Open Fez to answer privately.", label: "Inbox", target: { kind: "questions", id: request.id } });
      }
      known = new Set(requests.map(request => request.id));
      render();
    });
    const offChannels = client.on("channelsChanged", render);
    const show = (event: Event) => {
      const id: unknown = "detail" in event ? event.detail : undefined;
      const history = typeof id === "object" && id !== null && "view" in id && id.view === "history";
      if (!panel.current?.contains(document.activeElement)) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setFallbackId(typeof id === "string" ? id : undefined);
      setOpen(true);
      if (history) void loadHistory();
      else setTab(typeof id === "string" && !client.pendingInputs().some(r => r.id === id) ? "history" : "waiting");
      setTimeout(() => panel.current?.focus(), 0);
    };
    window.addEventListener("fez-show-questions", show);
    return () => { offInputs(); offChannels(); window.removeEventListener("fez-show-questions", show); };
  }, [client, loadHistory]);
  const requests = client.pendingInputs();
  const history = tab === "history" ? client.inputHistory() : [];
  return <aside ref={panel} id="agent-questions-panel" className="agent-input" aria-label="Agent questions" tabIndex={-1} hidden={!open} onKeyDown={event => { if (event.key === "Escape") close(); }}>
      <header className="input-panel-header"><strong>Questions</strong><button aria-label="Close questions" onClick={close}>×</button></header>
      <nav className="input-tabs" aria-label="Question views">
        <button aria-pressed={tab === "waiting"} onClick={() => setTab("waiting")}>Waiting{requests.length ? ` (${requests.length})` : ""}</button>
        <button aria-pressed={tab === "history"} onClick={() => void loadHistory()}>History</button>
      </nav>
      <div hidden={tab !== "waiting"}>
        {requests.length === 0 && <p className="input-empty">No questions waiting.</p>}
        {requests.map(request => request.origin && onOpen && request.id !== fallbackId
          ? <button className="input-thread-link" key={request.id} onClick={() => { setOpen(false); onOpen(request); }}>
            <strong>@{client.displayName(request.agentPk)}</strong><span>Open question in {request.origin.kind === "dm" ? "DM" : "thread"} →</span>
          </button>
          : <InputCard key={draftKey(client.pubkey, request)} ownerPk={client.pubkey} request={request} name={client.displayName(request.agentPk)} onAnswer={response => client.answerInput(request.id, response)} />)}
      </div>
      {tab === "history" && <div className="input-history">
        <p className="input-history-note">Private · latest 100 requests from the past 30 days</p>
        {loading && <p role="status">Loading history…</p>}
        {historyError && <p role="alert">{historyError} <button onClick={() => void loadHistory()}>Retry</button></p>}
        {history.map(entry => <React.Fragment key={entry.id}>
          <InputHistoryCard entry={entry} name={client.displayName(entry.agentPk)} />
          {entry.origin && onOpen && <button className="input-thread-link" onClick={() => { setOpen(false); onOpen(entry); }}>Open question in {entry.origin.kind === "dm" ? "DM" : "thread"} →</button>}
        </React.Fragment>)}
        {!loading && !historyError && history.length === 0 && <p>No question history yet.</p>}
      </div>}
    </aside>;
}

type Conversation = { kind: "channel"; channelId: string; rootId?: string } | { kind: "dm"; convoKey: string };

export function conversationQuestions(client: FezClient, conversation: Conversation): InputHistoryEntry[] {
  const records = new Map(client.inputHistory().map(entry => [entry.id, entry]));
  // Include active forms even when the bounded history window is full.
  for (const request of client.pendingInputs()) if (!records.has(request.id)) records.set(request.id, {
    ...request, requestedAt: request.expiresAt - INPUT_WAIT_MS, status: "pending",
  });
  return [...records.values()].filter(({ origin }) => origin?.kind === "channel" && conversation.kind === "channel"
    ? origin.channelId === conversation.channelId && origin.rootId === conversation.rootId
    : origin?.kind === "dm" && conversation.kind === "dm" && dmConvoKey(origin.participants, client.pubkey) === conversation.convoKey);
}

export function QuestionRow({ client, entry, focused }: { client: FezClient; entry: InputHistoryEntry; focused?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView({ block: "center" });
    ref.current?.focus({ preventScroll: true });
  }, [focused]);
  return <div ref={ref} id={`input-${entry.id}`} className={`conversation-question${focused ? " focus-flash" : ""}`} tabIndex={-1}>
    {entry.status === "pending" || entry.status === "sent"
      ? <InputCard key={`${draftKey(client.pubkey, entry)}:${entry.answeredAt ?? "pending"}`} ownerPk={client.pubkey} request={entry} name={client.displayName(entry.agentPk)} response={entry.response} awaitingReceipt={entry.status === "sent"} onAnswer={response => client.answerInput(entry.id, response)} />
      : <InputHistoryCard entry={entry} name={client.displayName(entry.agentPk)} />}
  </div>;
}

function InputHistoryCard({ entry, name }: { entry: InputHistoryEntry; name: string }) {
  const status = { pending: "Waiting for your answer", sent: "Sent · awaiting receipt", received: "Received by agent",
    closed: "Closed · no delivery receipt", expired: "Expired · no delivery receipt" }[entry.status];
  return <details className="input-history-card">
    <summary><strong>@{name}</strong><span>{status}</span><time dateTime={new Date(entry.requestedAt).toISOString()}>{new Date(entry.requestedAt).toLocaleString()}</time></summary>
    <p>{entry.form.message}</p>
    {entry.response?.action === "accept" ? <dl>{entry.form.fields.map(field => {
      const value = entry.response?.action === "accept" ? entry.response.content[field.id] : undefined;
      const label = (item: string | boolean | number) => field.options?.find(option => option.value === item)?.label ?? (typeof item === "boolean" ? item ? "Yes" : "No" : String(item));
      return <React.Fragment key={field.id}><dt>{field.title}</dt><dd>{value === undefined ? "No answer" : Array.isArray(value) ? value.map(label).join(", ") : label(value)}</dd></React.Fragment>;
    })}</dl> : <p>{entry.response?.action === "decline" ? "Skipped" : entry.response?.action === "cancel" ? "Cancelled" : "No answer recorded"}</p>}
  </details>;
}
