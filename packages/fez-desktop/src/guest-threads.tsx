import { useEffect, useRef, useState } from "react";
import type { BrowserWire } from "./wire";

/**
 * Guest threads (spec 2026-09-03): hiring a stranger is a DM.
 *
 * A guest is a foreign npub from a market relay — not a workspace member,
 * so nothing here touches the gift-wrap pipe. The thread is a PUBLIC
 * conversation: outgoing messages are directed 47001 tasks signed by the
 * owner's own key (an engagement, not the directory's anonymous tryout),
 * incoming bubbles are only what the guest npub itself signed (47003
 * answers, 47002 progress). Identity is cryptographic, not cosmetic —
 * nothing this file does can put words in a guest's mouth.
 *
 * Miners are stateless (one model call per task), so continuity rides IN
 * the task text: each send prepends the recent turns as a visible context
 * block. Agents that read context well will out-score those that don't —
 * the market does the upgrading, not this file.
 */

const KIND_PROFILE = 0;
const KIND_TASK = 47001;
const KIND_PROGRESS = 47002;
const KIND_RESULT = 47003;
/** What the live fleet serves — mirrors the bazaar's DEFAULT_TASK_TYPE. */
const TASK_TYPE = "research-citations";
const DEADLINE_S = 180;
const CONTEXT_TURNS = 6;

/* ── the guest ledger ──────────────────────────────────────────────────
 * npub → venue relay + last-seen name, persisted. Guests enter one way:
 * YOU messaged them (directory row, or a pasted npub). Strangers cannot
 * add themselves, so inbound guest spam is structurally impossible. */

export interface Guest {
  pk: string;
  relay: string;
  name?: string;
  picture?: string;
}

const LEDGER_KEY = "fez-guests";

export function listGuests(): Guest[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LEDGER_KEY) ?? "[]") as Guest[];
    return Array.isArray(raw) ? raw.filter((g) => /^[0-9a-f]{64}$/.test(g.pk ?? "")) : [];
  } catch {
    return [];
  }
}

export function addGuest(guest: Guest): void {
  const rest = listGuests().filter((g) => g.pk !== guest.pk);
  localStorage.setItem(LEDGER_KEY, JSON.stringify([guest, ...rest]));
}

export function rememberGuestFace(pk: string, name?: string, picture?: string): void {
  const guests = listGuests();
  const hit = guests.find((g) => g.pk === pk);
  if (!hit || (hit.name === name && hit.picture === picture)) return;
  addGuest({ ...hit, ...(name ? { name } : {}), ...(picture ? { picture } : {}) });
}

/* ── the thread context block ─────────────────────────────────────────
 * Visible, delimited, honest: the miner sees exactly what we resend. */

export function withContext(turns: { mine: boolean; text: string }[], next: string): string {
  const recent = turns.slice(-CONTEXT_TURNS);
  if (recent.length === 0) return next;
  const block = recent.map((t) => `${t.mine ? "client" : "you"}: ${t.text}`).join("\n");
  return `<thread_context>\n${block}\n</thread_context>\n\n${next}`;
}

/** The words the human typed, with any context block we prepended removed. */
export function withoutContext(content: string): string {
  const end = content.indexOf("</thread_context>");
  return end === -1 ? content : content.slice(end + "</thread_context>".length).trimStart();
}

/* ── the view ─────────────────────────────────────────────────────── */

interface WireEvent {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
}

type Turn =
  | { kind: "mine"; id: string; ts: number; text: string }
  | { kind: "theirs"; id: string; ts: number; text: string; status: string }
  | { kind: "progress"; id: string; ts: number; text: string };

export function GuestThreadView({ wire, selfPk, guest }: { wire: BrowserWire; selfPk: string; guest: Guest }) {
  const [events, setEvents] = useState<Map<string, WireEvent>>(new Map());
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const wsRef = useRef<WebSocket | undefined>(undefined);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEvents(new Map());
    let closed = false;
    let ws: WebSocket;
    const connect = () => {
      if (closed) return;
      ws = new WebSocket(guest.relay);
      wsRef.current = ws;
      ws.onopen = () => {
        // My asks at this guest; everything the guest signed; its face.
        ws.send(JSON.stringify(["REQ", "gt-mine", { kinds: [KIND_TASK], authors: [selfPk], "#p": [guest.pk], limit: 200 }]));
        ws.send(JSON.stringify(["REQ", "gt-them", { kinds: [KIND_PROGRESS, KIND_RESULT], authors: [guest.pk], limit: 500 }]));
        ws.send(JSON.stringify(["REQ", "gt-face", { kinds: [KIND_PROFILE], authors: [guest.pk], limit: 1 }]));
      };
      ws.onmessage = (m) => {
        let msg: unknown[];
        try { msg = JSON.parse(String(m.data)) as unknown[]; } catch { return; }
        if (msg[0] !== "EVENT") return;
        const ev = msg[2] as WireEvent;
        if (ev.kind === KIND_PROFILE) {
          try {
            const p = JSON.parse(ev.content) as { name?: string; picture?: string };
            rememberGuestFace(guest.pk, p.name, p.picture);
          } catch { /* faceless is fine */ }
          return;
        }
        setEvents((prev) => (prev.has(ev.id) ? prev : new Map(prev).set(ev.id, ev)));
      };
      ws.onclose = () => { if (!closed) setTimeout(connect, 4000); };
    };
    connect();
    return () => { closed = true; ws?.close(); };
  }, [guest.pk, guest.relay, selfPk]);

  // Timeline: my tasks, and ONLY guest events threaded to them — a guest
  // event aimed at someone else's task is not part of this conversation.
  const all = [...events.values()];
  const myTasks = all.filter((e) => e.kind === KIND_TASK && e.pubkey === selfPk);
  const myTaskIds = new Set(myTasks.map((e) => e.id));
  const rootOf = (e: WireEvent) => e.tags.find((t) => t[0] === "e" && t[3] === "root")?.[1] ?? e.tags.find((t) => t[0] === "e")?.[1];
  const turns: Turn[] = [
    ...myTasks.map((e): Turn => ({ kind: "mine", id: e.id, ts: e.created_at, text: withoutContext(e.content) })),
    ...all
      .filter((e) => e.pubkey === guest.pk && myTaskIds.has(rootOf(e) ?? ""))
      .map((e): Turn => {
        if (e.kind === KIND_RESULT) {
          try {
            const body = JSON.parse(e.content) as { status?: string; result?: string };
            return { kind: "theirs", id: e.id, ts: e.created_at, text: body.result ?? e.content, status: body.status ?? "success" };
          } catch {
            return { kind: "theirs", id: e.id, ts: e.created_at, text: e.content, status: "success" };
          }
        }
        let note = e.content;
        try { note = (JSON.parse(e.content) as { message?: string }).message ?? e.content; } catch { /* bare string stands */ }
        return { kind: "progress", id: e.id, ts: e.created_at, text: note };
      }),
  ].sort((a, b) => a.ts - b.ts);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "auto" }); });

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    if (!wire.signEvent) {
      setError("this wire cannot sign public events");
      return;
    }
    setSending(true);
    setError(undefined);
    try {
      const context = turns
        .filter((t): t is Extract<Turn, { kind: "mine" | "theirs" }> => t.kind !== "progress")
        .map((t) => ({ mine: t.kind === "mine", text: t.text }));
      const signed = await wire.signEvent({
        kind: KIND_TASK,
        content: withContext(context, text),
        tags: [
          ["task_type", TASK_TYPE],
          ["deadline", String(Math.floor(Date.now() / 1000) + DEADLINE_S)],
          ["p", guest.pk],
        ],
        created_at: Math.floor(Date.now() / 1000),
      });
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error(`not connected to ${guest.relay}`);
      ws.send(JSON.stringify(["EVENT", signed]));
      setEvents((prev) => new Map(prev).set((signed as WireEvent).id, signed as WireEvent));
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const name = guest.name ?? guest.pk.slice(0, 8);
  const dim = { color: "var(--fg-dim, #928374)" } as const;

  return (
    <main className="main">
      <header className="topbar">
        <div className="topbar-row" data-tauri-drag-region>
          {guest.picture ? (
            <img src={guest.picture} alt="" width={20} height={20} style={{ imageRendering: "pixelated", display: "block" }} />
          ) : (
            <span style={dim}>◌</span>
          )}
          <span>{name}</span>
          <span className="pill" title={guest.pk}>{`guest · ${guest.pk.slice(0, 8)}`}</span>
          <span
            className="pill"
            style={{ color: "var(--warn, #d79921)" }}
            title="this conversation is directed tasks and signed answers on a public market relay — anyone can read the whole thread; history is whatever that relay kept"
          >
            public
          </span>
        </div>
      </header>
      <div className="timeline" style={{ overflowY: "auto", flex: 1, padding: "12px 18px" }}>
        <p className="settings-hint">
          {`Public conversation on ${guest.relay.replace(/^wss?:\/\//, "")} — anyone can read this thread; never share secrets here. `}
          {`Messages you send are tasks only ${name} may answer.`}
        </p>
        {turns.map((t) =>
          t.kind === "progress" ? (
            <div key={t.id} style={{ ...dim, fontSize: "0.72rem", padding: "2px 0" }}>{`· ${t.text}`}</div>
          ) : (
            <div key={t.id} style={{ margin: "10px 0" }}>
              <div style={{ ...dim, fontSize: "0.7rem", marginBottom: 2 }}>
                {t.kind === "mine" ? "you" : name}
                {t.kind === "theirs" && t.status !== "success" ? ` · ${t.status}` : ""}
                {" · "}
                {new Date(t.ts * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              </div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: "0.86rem", lineHeight: 1.55 }}>{t.text}</div>
            </div>
          )
        )}
        {turns.length === 0 ? <p className="settings-hint">no messages yet — the first one below starts the engagement</p> : null}
        <div ref={bottomRef} />
      </div>
      <div style={{ padding: "10px 18px", borderTop: "1px solid var(--hairline, #32302f)" }}>
        {error ? <p className="ob-error">{error}</p> : null}
        <div style={{ display: "flex", gap: 8 }}>
          <textarea
            className="manage-input"
            style={{ flex: 1, minHeight: "2.6rem", resize: "vertical" }}
            placeholder={`message ${name} — public, on the market relay`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="agent-action" disabled={sending || !draft.trim()} onClick={() => void send()}>
            {sending ? "…" : "send"}
          </button>
        </div>
      </div>
    </main>
  );
}
