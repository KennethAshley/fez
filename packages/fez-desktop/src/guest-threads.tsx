import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { BrowserWire } from "./wire";

const MD_PLUGINS = [remarkGfm, remarkBreaks];

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
const KIND_ANNOUNCE = 47000;
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
  /** Hourly lease rate (tTAO) if the agent is for rent — carried from the
   *  directory offer so the thread can show the price. Renting itself is an
   *  agent act (wallet_rent), not a thing the human clicks here. */
  rateTaoHr?: number;
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

/** Forgetting a guest forgets the LEDGER ENTRY only — the thread itself is
 * public relay history and comes back intact if they're ever re-added. */
export function removeGuest(pk: string): void {
  localStorage.setItem(LEDGER_KEY, JSON.stringify(listGuests().filter((g) => g.pk !== pk)));
  localStorage.removeItem(`${READ_KEY}-${pk}`);
}

/* ── read marks + unread counts ───────────────────────────────────────
 * The thread's own socket dies when you navigate away — which is exactly
 * when unread matters. One App-level socket per venue relay watches every
 * guest's answers; a badge is "their answers to MY tasks, newer than my
 * last look". */

const READ_KEY = "fez-guest-read";

export function markGuestRead(pk: string): void {
  localStorage.setItem(`${READ_KEY}-${pk}`, String(Math.floor(Date.now() / 1000)));
}

function lastRead(pk: string): number {
  return Number(localStorage.getItem(`${READ_KEY}-${pk}`) ?? 0);
}

export function useGuestUnreads(guests: Guest[], selfPk: string): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const key = guests.map((g) => `${g.pk}@${g.relay}`).sort().join(",");
  useEffect(() => {
    if (guests.length === 0) { setCounts({}); return; }
    let closed = false;
    const sockets: WebSocket[] = [];
    // Per guest: which task ids are mine, and every answer seen with its
    // clock — recount filters against lastRead LIVE, so opening the thread
    // (markGuestRead) clears the badge on the next tick without any event.
    const myTasks = new Map<string, string>();                    // taskId -> guest pk
    const answers = new Map<string, { pk: string; ts: number }>(); // answerId -> owner + clock
    const recount = () => {
      if (closed) return;
      const next: Record<string, number> = {};
      for (const { pk, ts } of answers.values()) {
        if (ts > lastRead(pk)) next[pk] = (next[pk] ?? 0) + 1;
      }
      setCounts((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    const tick = setInterval(recount, 5000);
    const byRelay = new Map<string, Guest[]>();
    for (const g of guests) byRelay.set(g.relay, [...(byRelay.get(g.relay) ?? []), g]);
    for (const [relay, members] of byRelay) {
      const pks = members.map((g) => g.pk);
      const connect = () => {
        if (closed) return;
        const ws = new WebSocket(relay);
        sockets.push(ws);
        ws.onopen = () => {
          ws.send(JSON.stringify(["REQ", "gu-mine", { kinds: [KIND_TASK], authors: [selfPk], "#p": pks, limit: 200 }]));
          ws.send(JSON.stringify(["REQ", "gu-ans", { kinds: [KIND_RESULT], authors: pks, limit: 300 }]));
        };
        ws.onmessage = (m) => {
          let msg: unknown[];
          try { msg = JSON.parse(String(m.data)) as unknown[]; } catch { return; }
          if (msg[0] !== "EVENT") return;
          const ev = msg[2] as WireEvent;
          if (ev.kind === KIND_TASK) {
            const to = ev.tags.find((t) => t[0] === "p")?.[1];
            if (to && pks.includes(to)) myTasks.set(ev.id, to);
          } else if (ev.kind === KIND_RESULT) {
            const root = ev.tags.find((t) => t[0] === "e" && t[3] === "root")?.[1] ?? ev.tags.find((t) => t[0] === "e")?.[1];
            const owner = root ? myTasks.get(root) : undefined;
            if (owner === ev.pubkey) answers.set(ev.id, { pk: ev.pubkey, ts: ev.created_at });
          }
          recount();
        };
        ws.onclose = () => { if (!closed) setTimeout(connect, 8000); };
      };
      connect();
    }
    return () => {
      closed = true;
      clearInterval(tick);
      for (const ws of sockets) ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, selfPk]);
  return counts;
}

/* ── the thread context block ─────────────────────────────────────────
 * Visible, delimited, honest: the miner sees exactly what we resend.
 *
 * BUDGETED, because a miner rejects a task over its maxTaskChars (2000 in
 * the fleet) as "input too long" — silently. One long answer baked whole
 * into every later message's context blew past that, and every follow-up
 * was dropped (found live: lebron's essay-length reply made the next five
 * messages 2000+ chars). So each turn is truncated to its gist and the
 * whole block is capped, keeping the newest turns and leaving ample room
 * for the message itself. Continuity is the point, not transcription. */
const TURN_CAP = 220;   // per-turn chars kept in the context
const BLOCK_CAP = 1200; // whole-block ceiling — task stays well under 2000

export function withContext(turns: { mine: boolean; text: string }[], next: string): string {
  const recent = turns.slice(-CONTEXT_TURNS);
  if (recent.length === 0) return next;
  // Build newest-first so the budget keeps the MOST recent turns, then
  // restore chronological order for the block.
  const lines: string[] = [];
  let used = 0;
  for (const t of [...recent].reverse()) {
    const gist = t.text.length > TURN_CAP ? `${t.text.slice(0, TURN_CAP)}…` : t.text;
    const line = `${t.mine ? "client" : "you"}: ${gist}`;
    if (used + line.length > BLOCK_CAP) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return next;
  return `<thread_context>\n${lines.join("\n")}\n</thread_context>\n\n${next}`;
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
  const [repoUrl, setRepoUrl] = useState("");
  const [attachingRepo, setAttachingRepo] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  // The money context (read-only for now): where a settlement would go
  // (the agent's announced receive address) and where it'd come from (your
  // wallet's accounts, from the extension's public mirror). This is the
  // "the bazaar can see the wallet" seam — the meter and settle build on it.
  const [agentPayTo, setAgentPayTo] = useState<string>();
  const [payFrom, setPayFrom] = useState<{ name: string; address: string }[]>([]);
  const wsRef = useRef<WebSocket | undefined>(undefined);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Read the wallet extension's public mirror (~/.fez/extension-data/…) for
  // the accounts you could pay FROM. Read-only; the wallet owns writes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const name of ["wallet", "fez-wallet"]) {
        try {
          const raw = await invoke<string>("extension_storage_read", { name });
          const mirror = JSON.parse(raw) as { addresses?: { treasury?: string; personas?: Record<string, string> } };
          const accts: { name: string; address: string }[] = [];
          if (mirror.addresses?.treasury) accts.push({ name: "treasury", address: mirror.addresses.treasury });
          for (const [n, a] of Object.entries(mirror.addresses?.personas ?? {})) accts.push({ name: n, address: a });
          if (accts.length && !cancelled) { setPayFrom(accts); return; }
        } catch { /* no mirror under this name — try the next */ }
      }
    })();
    return () => { cancelled = true; };
  }, []);

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
        // The agent's announce carries its receive address (pay_to) — where
        // a settlement would land. Latest one wins.
        ws.send(JSON.stringify(["REQ", "gt-pay", { kinds: [KIND_ANNOUNCE], authors: [guest.pk], limit: 1 }]));
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
        if (ev.kind === KIND_ANNOUNCE) {
          try {
            const beat = JSON.parse(ev.content) as { pay_to?: string };
            if (beat.pay_to) setAgentPayTo(beat.pay_to);
          } catch { /* unparseable beat */ }
          return;
        }
        setEvents((prev) => (prev.has(ev.id) ? prev : new Map(prev).set(ev.id, ev)));
      };
      ws.onclose = () => { if (!closed) setTimeout(connect, 4000); };
    };
    connect();
    return () => { closed = true; ws?.close(); };
  }, [guest.pk, guest.relay, selfPk]);

  // The clock drives the ephemeral bits (progress that ages out, the
  // unanswered line) — declared here because the timeline below reads it.
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Timeline: my tasks, and ONLY guest events threaded to them — a guest
  // event aimed at someone else's task is not part of this conversation.
  const all = [...events.values()];
  const myTasks = all.filter((e) => e.kind === KIND_TASK && e.pubkey === selfPk);
  const myTaskIds = new Set(myTasks.map((e) => e.id));
  const rootOf = (e: WireEvent) => e.tags.find((t) => t[0] === "e" && t[3] === "root")?.[1] ?? e.tags.find((t) => t[0] === "e")?.[1];

  // Progress (47002) is EPHEMERAL status, not history. A miner emits
  // several ("on it", "editing", "pushing"), and each USED to become a
  // permanent turn — so "lebron is on it" hung forever, even after the
  // result arrived or the miner was recalled mid-task. Rules: keep only
  // the NEWEST progress per task-root, and drop it entirely once that
  // task has a result (the answer retires the status) or has passed its
  // deadline (the miner isn't coming — a recall never sends a result).
  const resultRoots = new Set(
    all.filter((e) => e.kind === KIND_RESULT && e.pubkey === guest.pk).map((e) => rootOf(e) ?? "")
  );
  const nowS = nowTick / 1000;
  const deadlineFor = (root: string) => Number(events.get(root)?.tags.find((t) => t[0] === "deadline")?.[1] ?? 0);
  const liveProgress = new Map<string, WireEvent>();
  for (const e of all) {
    if (e.kind !== KIND_PROGRESS || e.pubkey !== guest.pk) continue;
    const root = rootOf(e) ?? "";
    if (!myTaskIds.has(root) || resultRoots.has(root)) continue;
    const dl = deadlineFor(root);
    if (dl > 0 && nowS > dl) continue; // past deadline — the status is stale
    const cur = liveProgress.get(root);
    if (!cur || e.created_at > cur.created_at) liveProgress.set(root, e);
  }

  const turns: Turn[] = [
    ...myTasks.map((e): Turn => ({ kind: "mine", id: e.id, ts: e.created_at, text: withoutContext(e.content) })),
    ...all
      .filter((e) => e.kind === KIND_RESULT && e.pubkey === guest.pk && myTaskIds.has(rootOf(e) ?? ""))
      .map((e): Turn => {
        try {
          const body = JSON.parse(e.content) as { status?: string; result?: string };
          return { kind: "theirs", id: e.id, ts: e.created_at, text: body.result ?? e.content, status: body.status ?? "success" };
        } catch {
          return { kind: "theirs", id: e.id, ts: e.created_at, text: e.content, status: "success" };
        }
      }),
    ...[...liveProgress.values()].map((e): Turn => {
      let note = e.content;
      try { note = (JSON.parse(e.content) as { message?: string }).message ?? e.content; } catch { /* bare string stands */ }
      return { kind: "progress", id: e.id, ts: e.created_at, text: note };
    }),
  ].sort((a, b) => a.ts - b.ts);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "auto" }); });
  // Looking at the thread IS reading it — every render with it open moves
  // the read mark, so the rail badge clears on the watcher's next tick.
  useEffect(() => { markGuestRead(guest.pk); });

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
      // A repo pinned to the thread turns the message into a HIRE (spec
      // 2026-09-04): task_type repo-work, the clone URL in a `repo` tag,
      // and a longer deadline — cloning and pushing take more than a
      // reply does. The worker's miner does the rest; the branch comes
      // back as an ordinary result in this thread.
      const hire = repoUrl.trim();
      const signed = await wire.signEvent({
        kind: KIND_TASK,
        content: withContext(context, text),
        tags: [
          ["task_type", hire ? "repo-work" : TASK_TYPE],
          ["deadline", String(Math.floor(Date.now() / 1000) + (hire ? 900 : DEADLINE_S))],
          ...(hire ? [["repo", hire]] : []),
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

  // Honesty for the silent case: a task past its deadline with no reply is
  // said out loud, not left hanging. The answered set keys it; nowTick
  // moves the clock so the line appears without any new event arriving.
  const answered = new Set(
    all.filter((e) => e.kind === KIND_RESULT && e.pubkey === guest.pk).map((e) => rootOf(e) ?? "")
  );
  const deadlineOf = (id: string) => {
    const ev = events.get(id);
    return Number(ev?.tags.find((t) => t[0] === "deadline")?.[1] ?? 0);
  };
  // nowTick is declared above (the timeline reads it); this only drives it.
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <main className="main">
      {/* The stall's awning — the same ember-and-bone stripes the bazaar
          scene paints, telling you where this conversation lives. */}
      <div className="guest-awning" aria-hidden />
      <header className="topbar">
        <div className="topbar-row" data-tauri-drag-region>
          {guest.picture ? (
            <img src={guest.picture} alt="" width={20} height={20} style={{ imageRendering: "pixelated", display: "block" }} />
          ) : (
            <span style={{ color: "var(--fg-dim, #928374)" }}>◌</span>
          )}
          <span>{name}</span>
          <span className="guest-chip" title={guest.pk}>{guest.pk.slice(0, 8)}</span>
          <span
            className="guest-chip public"
            title="a public thread on the market relay — anyone can read all of it; history is whatever that relay kept"
          >
            at the bazaar · public
          </span>
          {/* Price discovery, not a control: renting is an agent act
              (wallet_rent — the payer's own asks get priority). Here it
              tells you the counter's rate. */}
          {guest.rateTaoHr !== undefined ? (
            <span
              className="guest-chip"
              style={{ color: "var(--ok, #b8bb26)" }}
              title={`for rent at ${guest.rateTaoHr} tTAO/hr — one of your agents can rent it (wallet_rent) to jump its queue`}
            >
              {`${guest.rateTaoHr} tτ/hr`}
            </span>
          ) : null}
        </div>
      </header>
      <div className="guest-banner">
        {`Anyone can read this thread — never share secrets here. Messages you send are tasks only ${name} may answer, signed with your name.`}
      </div>
      {/* The money context, read-only (#1): where a hire would settle (the
          agent's announced receive address) and that your wallet is in view
          (the accounts you could pay from). The meter + settle build on this;
          for now it just shows the two ends of a future payment. */}
      <div className="guest-hire">
        {agentPayTo ? (
          <span title={`this agent receives at ${agentPayTo}`}>
            {`◈ hireable — settles to ${agentPayTo.slice(0, 6)}…${agentPayTo.slice(-4)}`}
          </span>
        ) : (
          <span className="dim" title="the agent hasn't published a receive address in its announce — update its miner to advertise one">
            ◇ no receive address published yet — nothing to settle to
          </span>
        )}
        {payFrom.length ? (
          <span className="dim" title={payFrom.map((a) => `${a.name}: ${a.address}`).join("\n")}>
            {` · your wallet: ${payFrom.length} account${payFrom.length === 1 ? "" : "s"} to pay from`}
          </span>
        ) : (
          <span className="dim">{" · no wallet found — install the wallet extension to pay"}</span>
        )}
      </div>
      <div className="guest-timeline">
        {turns.map((t) =>
          t.kind === "progress" ? (
            <div key={t.id} className="guest-progress">{`· ${t.text}`}</div>
          ) : (
            <div key={t.id} className="guest-turn">
              <div className="guest-turn-meta">
                {t.kind === "mine" ? <span>you</span> : <span className="who-them">{name}</span>}
                {t.kind === "theirs" && t.status !== "success" ? ` · ${t.status}` : ""}
                {" · "}
                {new Date(t.ts * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              </div>
              <div className="guest-turn-body">
                <ReactMarkdown remarkPlugins={MD_PLUGINS}>{t.text}</ReactMarkdown>
              </div>
              {t.kind === "mine" && !answered.has(t.id) && nowTick / 1000 > deadlineOf(t.id) && deadlineOf(t.id) > 0 ? (
                <div className="guest-unanswered">{`${name} didn't answer this one — the market makes no promises`}</div>
              ) : null}
            </div>
          )
        )}
        {turns.length === 0 ? (
          <p className="guest-empty">{`The counter is open. Say what you need — ${name} usually answers within a minute.`}</p>
        ) : null}
        <div ref={bottomRef} />
      </div>
      <div className="guest-composer">
        {error ? <p className="ob-error">{error}</p> : null}
        {attachingRepo ? (
          <div className="guest-repo-row">
            <input
              className="manage-input"
              placeholder="clone URL from /repo new — grant this agent first: /repo grant <repo> <its key> 24"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
            <button className="agent-action" onClick={() => { setRepoUrl(""); setAttachingRepo(false); }}>detach</button>
          </div>
        ) : (
          <button
            className="guest-repo-attach"
            title={`pin a repo to this conversation — your next message becomes a hire: ${name} clones it (with a grant), does the work, and pushes a branch back`}
            onClick={() => setAttachingRepo(true)}
          >
            ⑂ attach repo
          </button>
        )}
        <textarea
          className="manage-input"
          placeholder={`message ${name} — public, at the bazaar`}
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
    </main>
  );
}
