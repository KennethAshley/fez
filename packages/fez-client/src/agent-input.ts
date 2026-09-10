import { K, type Wire } from "./index.js";

export interface InputOption { value: string; label: string; description?: string }
export interface InputField {
  id: string;
  title: string;
  description?: string;
  type: "string" | "array" | "boolean" | "number" | "integer";
  required: boolean;
  options?: InputOption[];
  min?: number;
  max?: number;
  format?: "email" | "uri" | "date" | "date-time";
}
export interface InputForm { message: string; fields: InputField[] }
export type InputAnswers = Record<string, string | string[] | number | boolean>;
export type InputResponse = { action: "accept"; content: InputAnswers } | { action: "decline" | "cancel" };
export type InputOrigin =
  | { kind: "channel"; channelId: string; rootId: string; messageId: string }
  | { kind: "dm"; participants: string[]; messageId: string };
export interface PendingInput {
  /** Agent pubkey + request nonce: two agents cannot close each other's form. */
  id: string;
  requestId: string;
  agentPk: string;
  expiresAt: number;
  form: InputForm;
  origin?: InputOrigin;
}
export interface InputHistoryEntry extends PendingInput {
  requestedAt: number;
  status: "pending" | "sent" | "received" | "closed" | "expired";
  response?: InputResponse;
  answeredAt?: number;
}
export const INPUT_WAIT_MS = 30 * 60_000;
const MAX_BYTES = 24_000;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function text(value: unknown, fallback = ""): string {
  if (value == null) return fallback;
  if (typeof value !== "string" || value.length > 8000) throw new Error("Invalid question text");
  return value;
}
function bound(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid field limit");
  return value;
}

/** Routing stays inside the ciphertext; invalid/legacy origins use the question inbox. */
export function inputOrigin(value: unknown, agentPk: string, recipient: string): InputOrigin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  const eventId = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9]{64}$/.test(id);
  if (!eventId(v.messageId)) return;
  // eslint-disable-next-line no-control-regex -- Routing identifiers must not contain control characters.
  if (v.kind === "channel" && typeof v.channelId === "string" && v.channelId.length > 0 && v.channelId.length <= 256 && !/\s|[\u0000-\u001f]/.test(v.channelId) && eventId(v.rootId)) {
    return { kind: "channel", channelId: v.channelId, rootId: v.rootId, messageId: v.messageId };
  }
  if (v.kind === "dm" && Array.isArray(v.participants) && v.participants.length >= 2 && v.participants.length <= 64 && v.participants.every(eventId)
    && v.participants.includes(agentPk) && v.participants.includes(recipient)) {
    return { kind: "dm", participants: [...new Set(v.participants)].sort(), messageId: v.messageId };
  }
}

/** Normalize ACP forms and our wire representation at the same trust boundary. */
export function inputForm(value: unknown): InputForm {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BYTES) throw new Error("Question form is too large");
  const request = object(value);
  const stored = Array.isArray(request.fields);
  if (!stored && request.mode !== "form") throw new Error("Only question forms are supported");
  const schema = stored ? {} : object(request.requestedSchema);
  if (schema.type != null && schema.type !== "object") throw new Error("Question schema must be an object");
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some(id => typeof id !== "string")) throw new Error("Invalid required fields");
  const entries: [string, unknown][] = stored
    ? (request.fields as unknown[]).map(f => { const field = object(f); return [text(field.id), field]; })
    : Object.entries(object(schema.properties));
  if (!entries.length || entries.length > 64 || new Set(entries.map(([id]) => id)).size !== entries.length) throw new Error("Invalid question count");
  if (required.some(id => !entries.some(([key]) => key === id))) throw new Error("Unknown required field");
  const fields = entries.map(([id, raw]): InputField => {
    const f = object(raw);
    if (!id || id.length > 200 || ["__proto__", "constructor", "prototype"].includes(id)) throw new Error("Invalid question id");
    const type = f.type;
    if (type !== "string" && type !== "array" && type !== "boolean" && type !== "number" && type !== "integer") throw new Error(`Unsupported question type: ${type}`);
    // Arbitrary regexes from a remote tool can freeze a client. Decline until
    // a bounded regex evaluator is available; never silently drop a constraint.
    if (f.pattern != null) throw new Error("Pattern-constrained questions are not supported");
    const choices: unknown = stored ? f.options : type === "array" ? object(f.items).anyOf ?? object(f.items).enum : f.oneOf ?? f.enum;
    let options: InputOption[] | undefined;
    if (choices != null) {
      if (!Array.isArray(choices) || !choices.length || choices.length > 64) throw new Error("Invalid question options");
      options = choices.map(o => {
        if (typeof o === "string") return { value: o, label: o };
        const option = object(o);
        const value = stored ? option.value : option.const;
        if (typeof value !== "string") throw new Error("Invalid option value");
        return { value: text(value), label: text(stored ? option.label : option.title, value), description: text(option.description) || undefined };
      });
      if (new Set(options.map(o => o.value)).size !== options.length) throw new Error("Duplicate question options");
    }
    if (type === "array" && !options) throw new Error("Multi-select questions need options");
    const format = f.format;
    if (format != null && !["email", "uri", "date", "date-time"].includes(String(format))) throw new Error("Unsupported question format");
    const min = bound(stored ? f.min : type === "string" ? f.minLength : type === "array" ? f.minItems : f.minimum);
    const max = bound(stored ? f.max : type === "string" ? f.maxLength : type === "array" ? f.maxItems : f.maximum);
    if (min !== undefined && max !== undefined && min > max) throw new Error("Invalid field limits");
    return { id, type, title: text(f.title, id), description: text(f.description) || undefined,
      required: stored ? f.required === true : required.includes(id), options, min, max, format: format as InputField["format"] };
  });
  return { message: text(request.message), fields };
}

/** Reject unknown fields, invalid selections and missing required answers on BOTH ends. */
export function validateInputResponse(form: InputForm, value: unknown): InputResponse {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BYTES) throw new Error("Answers are too large");
  const response = object(value);
  if (response.action === "cancel" || response.action === "decline") return { action: response.action };
  if (response.action !== "accept") throw new Error("Invalid answer action");
  const content = object(response.content);
  if (Object.keys(content).some(id => !form.fields.some(f => f.id === id))) throw new Error("Unknown answer field");
  const answers: InputAnswers = {};
  for (const f of form.fields) {
    const v = content[f.id];
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) {
      if (f.required) throw new Error(`${f.title}: an answer is required`);
      continue;
    }
    const invalid = () => new Error(`${f.title}: invalid answer`);
    if (f.type === "string") {
      if (typeof v !== "string" || v.length > 8000 || (f.options && !f.options.some(o => o.value === v))) throw invalid();
      if (f.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw invalid();
      if (f.format === "uri") { try { new URL(v); } catch { throw invalid(); } }
      if (f.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v)) throw invalid();
      if (f.format === "date-time" && (!v.includes("T") || !Number.isFinite(Date.parse(v)))) throw invalid();
    } else if (f.type === "array") {
      if (!Array.isArray(v) || v.length > 64 || v.some(x => typeof x !== "string" || !f.options?.some(o => o.value === x)) || new Set(v).size !== v.length) throw invalid();
    } else if (f.type === "boolean") {
      if (typeof v !== "boolean") throw invalid();
    } else if (typeof v !== "number" || !Number.isFinite(v) || (f.type === "integer" && !Number.isInteger(v))) throw invalid();
    const size = typeof v === "string" || Array.isArray(v) ? v.length : typeof v === "number" ? v : undefined;
    if (size !== undefined && ((f.min !== undefined && size < f.min) || (f.max !== undefined && size > f.max))) throw invalid();
    answers[f.id] = v as InputAnswers[string];
  }
  return { action: "accept", content: answers };
}

type InputWire = Pick<Wire, "pubkey" | "publish" | "subscribe" | "encrypt" | "decrypt">;

/** Wait for this recipient's signed response; subscribe BEFORE publishing to avoid fast-answer loss. */
export async function requestInput(wire: InputWire, recipient: string, form: InputForm,
  { signal, timeoutMs = INPUT_WAIT_MS, origin }: { signal?: AbortSignal; timeoutMs?: number; origin?: InputOrigin } = {}): Promise<InputResponse> {
  form = inputForm(form);
  origin = inputOrigin(origin, wire.pubkey, recipient);
  if (!/^[a-f0-9]{64}$/.test(recipient)) throw new Error("Invalid question recipient");
  if (!Number.isFinite(timeoutMs)) throw new Error("Invalid question timeout");
  if (signal?.aborted) return { action: "cancel" };
  const requestId = crypto.randomUUID();
  const requestedAt = Date.now();
  const expiresAt = requestedAt + Math.min(INPUT_WAIT_MS, Math.max(1, timeoutMs));
  const tags = [["p", recipient], ["d", requestId]];
  let responseId: string | undefined;
  let settled = false;
  let settle!: (response: InputResponse, id?: string) => void;
  const answer = new Promise<InputResponse>(resolve => { settle = (response, id) => {
    if (settled) return;
    settled = true;
    responseId = id;
    resolve(response);
  }; });
  const cancel = () => settle({ action: "cancel" });
  const timer = setTimeout(cancel, expiresAt - Date.now());
  signal?.addEventListener("abort", cancel, { once: true });
  let unsubscribe = () => {};
  let receiving = Promise.resolve();
  try {
    unsubscribe = wire.subscribe([{ kinds: [K.INPUT_RESPONSE], authors: [recipient], "#p": [wire.pubkey], "#d": [requestId] }], event => {
      // Filters are an optimization; verify routing and author even on a lying relay.
      if (event.kind !== K.INPUT_RESPONSE || event.pubkey !== recipient || !event.tags.some(t => t[0] === "d" && t[1] === requestId) || !event.tags.some(t => t[0] === "p" && t[1] === wire.pubkey)) return;
      receiving = receiving.then(() => wire.decrypt(recipient, event.content)).then(raw => {
        if (!signal?.aborted && Date.now() < expiresAt) settle(validateInputResponse(form, JSON.parse(raw)), event.id);
      }).catch(() => {});
    });
    const publishing = Promise.resolve().then(async () => {
      const content = await wire.encrypt(recipient, JSON.stringify({ status: "pending", requestedAt, expiresAt, form, origin }));
      if (!signal?.aborted && Date.now() < expiresAt) await wire.publish({ kind: K.INPUT_REQUEST, tags, content });
    });
    // Cancellation/expiry also wins over a relay that never acknowledges publish.
    const early = await Promise.race([publishing, answer]);
    if (early) return early;
    return await answer;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    unsubscribe();
    // Expiry remains the fallback if the relay goes away during cleanup.
    void Promise.resolve().then(async () => {
      await wire.publish({ kind: K.INPUT_REQUEST, tags, content: await wire.encrypt(recipient, JSON.stringify({ status: "closed", requestedAt, closedAt: Date.now(), expiresAt, form, origin, responseId })) });
    }).catch(() => {});
  }
}
