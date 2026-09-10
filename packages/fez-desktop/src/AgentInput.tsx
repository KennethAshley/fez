import React, { useEffect, useReducer, useRef, useState } from "react";
import { dmConvoKey, INPUT_WAIT_MS, validateInputResponse, type FezClient, type InputAnswers, type InputResponse, type PendingInput, type InputHistoryEntry } from "@fezchat/client";
import { notifyEvent } from "./notify";

export function InputCard({ request, name, onAnswer, response, awaitingReceipt = false }: {
  request: PendingInput;
  name: string;
  onAnswer: (response: InputResponse) => Promise<void>;
  response?: InputResponse;
  awaitingReceipt?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [sentLocally, setSent] = useState(false);
  const sent = awaitingReceipt || sentLocally;
  const answers = response?.action === "accept" ? response.content : {};
  const [error, setError] = useState("");
  const answer = async (response: InputResponse) => {
    setBusy(true);
    setError("");
    try {
      await onAnswer(validateInputResponse(request.form, response));
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
    void answer({ action: "accept", content });
  };
  return <section className="input-card" aria-label={`Questions from ${name}`}>
    <header><strong>@{name} needs your input</strong><span>Private · only this agent receives your answers</span></header>
    {!sent && <p className="input-waiting">Waiting for your answer</p>}
    <form onSubmit={submit}>
      <p className="input-message">{request.form.message}</p>
      <fieldset disabled={busy} className="input-fields">
        {request.form.fields.map(field => <fieldset key={field.id} className="input-question">
          <legend>{field.title}{field.required ? " *" : ""}</legend>
          {field.description && <p>{field.description}</p>}
          {field.options ? field.options.map(option => <label className="input-choice" key={option.value}>
            <input type={field.type === "array" ? "checkbox" : "radio"} name={field.id} value={option.value} defaultChecked={Array.isArray(answers[field.id]) ? (answers[field.id] as string[]).includes(option.value) : answers[field.id] === option.value} required={field.required && field.type !== "array"} />
            <span>{option.label}{option.description && <small>{option.description}</small>}</span>
          </label>) : field.type === "boolean" ? <select name={field.id} aria-label={field.title} required={field.required} defaultValue={answers[field.id] === undefined ? "" : String(answers[field.id])}>
            <option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option>
          </select> : field.type === "number" || field.type === "integer" ? <input name={field.id} aria-label={field.title} type="number" defaultValue={String(answers[field.id] ?? "")} required={field.required} min={field.min} max={field.max} step={field.type === "integer" ? 1 : "any"} />
            : field.format ? <input defaultValue={String(answers[field.id] ?? "")} name={field.id} aria-label={field.title} type={field.format === "uri" ? "url" : field.format === "date-time" ? "text" : field.format} placeholder={field.format === "date-time" ? "2026-09-10T14:00:00Z" : undefined} required={field.required} minLength={field.min} maxLength={field.max ?? 8000} />
              : <textarea name={field.id} aria-label={field.title} defaultValue={String(answers[field.id] ?? "")} required={field.required} minLength={field.min} maxLength={field.max ?? 8000} rows={2} />}
        </fieldset>)}
      </fieldset>
      {error && <p className="input-error" role="alert">{error}</p>}
      {sent && <p role="status">Waiting for agent to acknowledge your answers…</p>}
      <footer>
        <button type="button" disabled={busy} onClick={() => void answer({ action: "decline" })}>Skip</button>
        <button type="submit" disabled={busy}>{busy ? "Sending…" : sent ? "Send again" : "Submit answers"}</button>
      </footer>
    </form>
  </section>;
}

export default function AgentInput({ client, onOpen }: { client: FezClient; onOpen?: (request: PendingInput) => void }) {
  const [, render] = useReducer(n => n + 1, 0);
  const [open, setOpen] = useState(() => client.pendingInputs().some(request => !request.origin));
  const [fallbackId, setFallbackId] = useState<string>();
  const [tab, setTab] = useState<"waiting" | "history">("waiting");
  const [loading, setLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const panel = useRef<HTMLElement>(null);
  const loadHistory = async () => {
    setTab("history"); setLoading(true); setHistoryError("");
    try { await client.loadInputHistory(); }
    catch { setHistoryError("History could not load. Try again."); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    void client.loadInputHistory().catch(() => setHistoryError("History could not load. Try again."));
    let known = new Set(client.pendingInputs().map(request => request.id));
    const offInputs = client.on("inputsChanged", () => {
      const requests = client.pendingInputs();
      for (const request of requests) {
        if (known.has(request.id)) continue;
        if (!request.origin) setOpen(true);
        notifyEvent({ key: `question:${request.id}`, kind: "needs_action", title: `${client.displayName(request.agentPk)} needs your input`,
          body: "Open Fez to answer privately.", label: "Questions", target: { kind: "questions", ...(request.origin ? { id: request.id } : {}) } });
      }
      known = new Set(requests.map(request => request.id));
      render();
    });
    const offChannels = client.on("channelsChanged", render);
    const show = (event: Event) => {
      const id: unknown = "detail" in event ? event.detail : undefined;
      setFallbackId(typeof id === "string" ? id : undefined);
      setOpen(true); setTab(typeof id === "string" && !client.pendingInputs().some(r => r.id === id) ? "history" : "waiting");
      setTimeout(() => panel.current?.focus(), 0);
    };
    window.addEventListener("fez-show-questions", show);
    return () => { offInputs(); offChannels(); window.removeEventListener("fez-show-questions", show); };
  }, [client]);
  const requests = client.pendingInputs();
  const history = tab === "history" ? client.inputHistory() : [];
  return <>
    <button className="channel home-link" aria-label="Questions" aria-expanded={open} aria-controls="agent-questions-panel" onClick={() => setOpen(value => !value)}>
      <span className="nav-glyph">?</span> questions
      {requests.length > 0 && <span className="badge" aria-label={`${requests.length} pending question request${requests.length === 1 ? "" : "s"}`}>{requests.length}</span>}
    </button>
    <aside ref={panel} id="agent-questions-panel" className="agent-input" aria-label="Agent questions" tabIndex={-1} hidden={!open} onKeyDown={event => { if (event.key === "Escape") setOpen(false); }}>
      <header className="input-panel-header"><strong>Questions</strong><button aria-label="Close questions" onClick={() => setOpen(false)}>×</button></header>
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
          : <InputCard key={request.id} request={request} name={client.displayName(request.agentPk)} onAnswer={response => client.answerInput(request.id, response)} />)}
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
    </aside>
  </>;
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
      ? <InputCard key={entry.answeredAt ?? "pending"} request={entry} name={client.displayName(entry.agentPk)} response={entry.response} awaitingReceipt={entry.status === "sent"} onAnswer={response => client.answerInput(entry.id, response)} />
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
