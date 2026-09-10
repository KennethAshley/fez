import React, { useEffect, useReducer, useState } from "react";
import { validateInputResponse, type FezClient, type InputAnswers, type InputResponse, type PendingInput } from "@fezchat/client";

export function InputCard({ request, name, onAnswer }: {
  request: PendingInput;
  name: string;
  onAnswer: (response: InputResponse) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
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
    <form onSubmit={submit}>
      <p className="input-message">{request.form.message}</p>
      <fieldset disabled={busy} className="input-fields">
        {request.form.fields.map(field => <fieldset key={field.id} className="input-question">
          <legend>{field.title}{field.required ? " *" : ""}</legend>
          {field.description && <p>{field.description}</p>}
          {field.options ? field.options.map(option => <label className="input-choice" key={option.value}>
            <input type={field.type === "array" ? "checkbox" : "radio"} name={field.id} value={option.value} required={field.required && field.type !== "array"} />
            <span>{option.label}{option.description && <small>{option.description}</small>}</span>
          </label>) : field.type === "boolean" ? <select name={field.id} aria-label={field.title} required={field.required} defaultValue="">
            <option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option>
          </select> : field.type === "number" || field.type === "integer" ? <input name={field.id} aria-label={field.title} type="number" required={field.required} min={field.min} max={field.max} step={field.type === "integer" ? 1 : "any"} />
            : field.format ? <input name={field.id} aria-label={field.title} type={field.format === "uri" ? "url" : field.format === "date-time" ? "text" : field.format} placeholder={field.format === "date-time" ? "2026-09-10T14:00:00Z" : undefined} required={field.required} minLength={field.min} maxLength={field.max ?? 8000} />
              : <textarea name={field.id} aria-label={field.title} required={field.required} minLength={field.min} maxLength={field.max ?? 8000} rows={2} />}
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

export default function AgentInput({ client }: { client: FezClient }) {
  const [, render] = useReducer(n => n + 1, 0);
  useEffect(() => {
    const offInputs = client.on("inputsChanged", render);
    const offChannels = client.on("channelsChanged", render);
    return () => { offInputs(); offChannels(); };
  }, [client]);
  const requests = client.pendingInputs();
  if (!requests.length) return null;
  return <aside className="agent-input" aria-label="Agent questions">
    {requests.map(request => <InputCard key={request.id} request={request} name={client.displayName(request.agentPk)} onAnswer={response => client.answerInput(request.id, response)} />)}
  </aside>;
}
