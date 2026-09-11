import { useEffect, useRef, useState } from "react";
import { Avatar as UiAvatar } from "@fezchat/ui";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { BrowserWire } from "./wire";
import { latestPendingFor, findByTask, updateRecord, tauriStore } from "./orchestration";
import { relaySet } from "./relay";
import { BAZAAR_RELAY } from "./bazaar-record";
import { fetchSaltPanel, invalidateSaltPanel, tierLabel, tierTitle, type SaltPanel } from "./salt-record";

import { parseGuestEvent, isGuestReplyTo, replaceableEventWins } from "../../fez-client/src/guest-protocol.js";
import { GuestHirePanel } from "./GuestHirePanel.js";
import { readGuestJobs } from "./guest-job.js";

type ParsedGuest = NonNullable<ReturnType<typeof parseGuestEvent>>;
type GuestTask = Extract<ParsedGuest, { type: "task" }>;
type GuestReply = Extract<ParsedGuest, { type: "result" | "progress" }>;

const MD_PLUGINS = [remarkGfm, remarkBreaks];

/**
 * Guest threads: public job conversations with a foreign identity.
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
/** Bazaar enrollment binding — an EMPTY one is the miner's clean
 *  shutdown ("retired"), the one explicit offline signal on the wire. */
const KIND_BINDING = 47041;
/** Liveness lease: miners re-announce every 5 minutes (fez-bazaar
 *  miner/main.ts), so 3× that is the staleness bound — buzz's rule: a
 *  bounded wrong dot, never an indefinite one. */
const FRESH_S = 15 * 60;
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
  /** A task prewritten by an extension (e.g. a proposal card) — prefills
   *  the composer. The human still presses send; this never auto-sends. */
  draft?: string;
  /** The summon gate was shown and accepted — once per guest, ever. */
  saltAck?: boolean;
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
  addGuest({ ...hit, name, picture });
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
    const myTasks = new Map<string, GuestTask>();
    const answers = new Map<string, Extract<ParsedGuest, { type: "result" }>>();
    setCounts({});
    const recount = () => {
      if (closed) return;
      const next: Record<string, number> = {};
      for (const reply of answers.values()) {
        const task = myTasks.get(reply.taskId);
        if (!task || !isGuestReplyTo(reply, task)) continue;
        const pk = reply.event.pubkey;
        if (reply.event.created_at > lastRead(pk)) next[pk] = (next[pk] ?? 0) + 1;
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
          let msg: unknown;
          if (closed || String(m.data).length > 262_144) return;
          try { msg = JSON.parse(String(m.data)); } catch { return; }
          if (!Array.isArray(msg) || msg[0] !== "EVENT" || !["gu-mine", "gu-ans"].includes(msg[1])) return;
          for (const guestPk of pks) {
            const parsed = parseGuestEvent(msg[2], { selfPk, guestPk });
            if (parsed?.type === "task" && msg[1] === "gu-mine") {
              if (myTasks.size >= 1000) myTasks.delete(myTasks.keys().next().value!);
              myTasks.set(parsed.event.id, parsed);
              break;
            }
            if (parsed?.type === "result" && msg[1] === "gu-ans") {
              if (answers.size >= 1000) answers.delete(answers.keys().next().value!);
              answers.set(parsed.event.id, parsed);
              break;
            }
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

type WireEvent = ParsedGuest["event"];

type Turn =
  | { kind: "mine"; id: string; ts: number; text: string }
  | { kind: "theirs"; id: string; ts: number; text: string; status: string }
  | { kind: "progress"; id: string; ts: number; text: string };

export function GuestThreadView(props: { wire: BrowserWire; selfPk: string; guest: Guest }) {
  return <GuestConversation key={JSON.stringify([props.selfPk, props.guest.pk, props.guest.relay])} {...props} />;
}

function GuestConversation({ wire, selfPk, guest }: { wire: BrowserWire; selfPk: string; guest: Guest }) {
  const [events, setEvents] = useState<Map<string, ParsedGuest>>(new Map());
  const [draft, setDraft] = useState(() => guest.draft ?? "");
  // Reopening the SAME guest (same pk) with a fresh draft — a second
  // openGuestDm call, e.g. from another proposal card — reuses this
  // mounted instance (App.tsx keys the view by guest.pk), so the
  // mount-time seed above won't rerun. Catch that here, but never
  // stomp on text the human already started typing.
  useEffect(() => {
    if (guest.draft && draft === "") setDraft(guest.draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guest.pk, guest.draft]);
  const [repoUrl, setRepoUrl] = useState("");
  const [attachingRepo, setAttachingRepo] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [offer, setOffer] = useState<Extract<ParsedGuest, { type: "announce" }>>();
  const [face, setFace] = useState({ name: guest.name, picture: guest.picture });
  // Salt: what people outside this agent's household say. No workspace
  // client here, so rings are viewer-only — exactly the vantage that
  // makes a stranger "nameless", which is who the gate is for.
  const [salt, setSalt] = useState<SaltPanel | "error">();
  const [saltAck, setSaltAck] = useState(() => !!guest.saltAck);
  useEffect(() => {
    let cancelled = false;
    setSalt(undefined);
    setSaltAck(!!listGuests().find((g) => g.pk === guest.pk)?.saltAck);
    void fetchSaltPanel({
      pk: guest.pk,
      viewer: selfPk,
      relays: [...relaySet(), BAZAAR_RELAY],
      isViewerAgent: (k) => k === selfPk,
      inViewerCircle: () => false,
    })
      .then((p) => { if (!cancelled) setSalt(p); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [guest.pk, selfPk]);
  // The once-per-guest gate: real salt, no ack, and a tier where nobody
  // the viewer can verify has vouched. "error" is excluded on purpose.
  const summonGate = !!(salt && salt !== "error" && !saltAck && (salt.tier === "nameless" || salt.tier === "spoken-of"));
  // YOUR standing vouch, specifically — ring0 also holds your agents'
  // evidence, and "revoke" may only withdraw what your key signed.
  const myVouch = !!(salt && salt !== "error" && salt.ring0.some((e) => e.kind === "vouch" && e.signer === selfPk));
  const [vouching, setVouching] = useState(false);
  /**
   * The write half of salt, finally somewhere a human can reach it: the
   * guest thread is the only surface fez has for a stranger, and
   * strangers are the only agents whose vouches count (deriveSalt's
   * household filter discards an owner's evidence for their own).
   * Sign once with the USER's key, publish to the workspace relay AND
   * the guest's venue — evidence accumulates where the agent works.
   * Revoke is the addressable convention: same d-tag, empty content.
   */
  const vouch = async (revoke: boolean) => {
    if (vouching) return;
    setVouching(true);
    setError(undefined);
    try {
      const ev = await wire.publish({
        kind: 47008,
        tags: [["d", guest.pk], ["p", guest.pk]],
        content: revoke ? "" : "vouched after working together in a guest thread",
      });
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(["EVENT", ev]));
      invalidateSaltPanel(guest.pk);
      const p = await fetchSaltPanel({
        pk: guest.pk,
        viewer: selfPk,
        relays: [...relaySet(), BAZAAR_RELAY],
        isViewerAgent: (k) => k === selfPk,
        inViewerCircle: () => false,
      });
      setSalt(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVouching(false);
    }
  };
  const wsRef = useRef<WebSocket | undefined>(undefined);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Liveness: newest announce (the 5-min heartbeat) vs newest EMPTY
  // binding (clean shutdown). Both are read from events already flowing
  // through this socket — the thread used to receive and discard them.
  const [lastBeatAt, setLastBeatAt] = useState(0);
  const [retiredAt, setRetiredAt] = useState(0);
  // Sends awaiting the relay's OK, by event id — buzz's model: render
  // optimistically, but bounded and reversible.
  const pendingOk = useRef(new Map<string, { ok: () => void; fail: (reason: string) => void }>());
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    setEvents(new Map());
    let closed = false;
    let ws: WebSocket;
    const latest = new Map<number, WireEvent>();
    const connect = () => {
      if (closed) return;
      const socket = new WebSocket(guest.relay);
      ws = socket;
      wsRef.current = socket;
      socket.onopen = () => {
        if (closed || wsRef.current !== socket) return;
        // Relay filters are hints; every envelope is verified below.
        try {
          const ids = readGuestJobs(localStorage, { ownerPk: selfPk, guestPk: guest.pk, relay: guest.relay }).map(job => job.requestId);
          if (ids.length) {
            socket.send(JSON.stringify(["REQ", "gt-jobs", { kinds: [KIND_TASK], authors: [selfPk], ids }]));
            socket.send(JSON.stringify(["REQ", "gt-job-results", { kinds: [KIND_RESULT], authors: [guest.pk], "#e": ids }]));
          }
        } catch { /* The payment panel reports corrupt storage and blocks spending. */ }
        socket.send(JSON.stringify(["REQ", "gt-mine", { kinds: [KIND_TASK], authors: [selfPk], "#p": [guest.pk], limit: 200 }]));
        socket.send(JSON.stringify(["REQ", "gt-them", { kinds: [KIND_PROGRESS, KIND_RESULT], authors: [guest.pk], limit: 500 }]));
        socket.send(JSON.stringify(["REQ", "gt-face", { kinds: [KIND_PROFILE], authors: [guest.pk], limit: 1 }]));
        // The agent's announce carries its receive address (pay_to) — where
        // a settlement would land. Latest one wins.
        socket.send(JSON.stringify(["REQ", "gt-pay", { kinds: [KIND_ANNOUNCE], authors: [guest.pk], limit: 1 }]));
        // Latest binding: empty content = the miner said goodbye cleanly.
        socket.send(JSON.stringify(["REQ", "gt-bind", { kinds: [KIND_BINDING], authors: [guest.pk], limit: 1 }]));
      };
      socket.onmessage = (m) => {
        let msg: unknown;
        if (closed || wsRef.current !== socket || String(m.data).length > 262_144) return;
        try { msg = JSON.parse(String(m.data)); } catch { return; }
        if (!Array.isArray(msg)) return;
        if (msg[0] === "OK") {
          const [, id, accepted, reason] = msg;
          if (typeof id !== "string" || typeof accepted !== "boolean") return;
          const waiter = pendingOk.current.get(id);
          if (waiter) {
            pendingOk.current.delete(id);
            if (accepted) waiter.ok();
            else waiter.fail(typeof reason === "string" ? reason : "the relay rejected the message");
          }
          return;
        }
        if (msg[0] !== "EVENT") return;
        const parsed = parseGuestEvent(msg[2], { selfPk, guestPk: guest.pk });
        if (!parsed) return;
        const subscription = msg[1];
        const expected = parsed.type === "task" ? ["gt-mine", "gt-jobs"]
          : parsed.type === "profile" ? ["gt-face"] : parsed.type === "announce" ? ["gt-pay"]
          : parsed.type === "binding" ? ["gt-bind"] : ["gt-them", "gt-job-results"];
        if (!expected.includes(subscription)) return;
        const ev = parsed.event;
        if (["profile", "announce", "binding"].includes(parsed.type)) {
          if (!replaceableEventWins(ev, latest.get(ev.kind))) return;
          latest.set(ev.kind, ev);
        }
        if (parsed.type === "profile") {
          const next = { name: parsed.profile?.name, picture: parsed.profile?.picture };
          setFace(next);
          rememberGuestFace(guest.pk, next.name, next.picture);
          return;
        }
        if (parsed.type === "announce") {
          setLastBeatAt(prev => Math.max(prev, ev.created_at));
          setOffer(parsed);
          return;
        }
        if (parsed.type === "binding") {
          if (parsed.retired) setRetiredAt(ev.created_at);
          else setLastBeatAt(prev => Math.max(prev, ev.created_at));
          return;
        }
        setEvents(prev => {
          if (prev.has(ev.id)) return prev;
          const next = new Map(prev);
          if (next.size >= 1000) next.delete(next.keys().next().value!);
          next.set(ev.id, parsed);
          return next;
        });
      };
      socket.onclose = () => {
        if (closed || wsRef.current !== socket) return;
        // A send the relay never acknowledged must fail loudly, not spin —
        // buzz rejects every in-flight publish on disconnect.
        for (const waiter of pendingOk.current.values()) waiter.fail("connection dropped before the relay confirmed");
        pendingOk.current.clear();
        if (!closed) setTimeout(connect, 4000);
      };
    };
    connect();
    return () => {
      closed = true;
      for (const waiter of pendingOk.current.values()) waiter.fail("conversation closed before acknowledgement");
      pendingOk.current.clear();
      ws?.close();
    };
  }, [guest.pk, guest.relay, selfPk]);

  // The clock drives the ephemeral bits (progress that ages out, the
  // unanswered line) — declared here because the timeline below reads it.
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Three liveness states, present-tense only (buzz keeps no last-seen):
  // a fresh lease is "here", a retirement or an expired lease is "away",
  // and no signal at all stays silent rather than guessing.
  const liveness: "here" | "away" | "unknown" =
    retiredAt > lastBeatAt ? "away"
    : lastBeatAt === 0 ? "unknown"
    : nowTick / 1000 - lastBeatAt > FRESH_S ? "away"
    : "here";

  // Timeline: my tasks, and ONLY guest events threaded to them — a guest
  // event aimed at someone else's task is not part of this conversation.
  const parsedEvents = [...events.values()];
  const tasks = parsedEvents.filter((event): event is GuestTask => event.type === "task");
  const taskById = new Map(tasks.map(task => [task.event.id, task]));
  const replies = parsedEvents.filter((event): event is GuestReply => {
    if (event.type !== "result" && event.type !== "progress") return false;
    const task = taskById.get(event.taskId);
    return !!task && isGuestReplyTo(event, task);
  });
  const results = replies.filter((event): event is Extract<ParsedGuest, { type: "result" }> => event.type === "result");
  const all = [...tasks, ...replies].map(event => event.event);
  const myTasks = tasks.map(task => task.event);
  const myTaskIds = new Set(myTasks.map(event => event.id));
  const rootOf = (event: WireEvent) => replies.find(reply => reply.event.id === event.id)?.taskId;
  useEffect(() => {
    for (const result of results) {
      void findByTask(tauriStore.read, guest.pk, result.taskId).then(record => {
        if (record && !record.outcome) return updateRecord(tauriStore.read, tauriStore.write, record.id, { outcome: { delivered: result.status === "success" } });
      }).catch(() => {});
    }
  }, [events, guest.pk]); // The parsed view only contains verified, correctly addressed replies.

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
  const deadlineFor = (root: string) => Number(events.get(root)?.event.tags.find((t) => t[0] === "deadline")?.[1] ?? 0);
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
    ...results.map((result): Turn => ({ kind: "theirs", id: result.event.id, ts: result.event.created_at, text: result.result, status: result.status })),
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
      const verified = parseGuestEvent(signed, { selfPk, guestPk: guest.pk });
      if (verified?.type !== "task") throw new Error("The signed task does not match this conversation.");
      const sid = verified.event.id;
      // Optimistic, but bounded and reversible (buzz's send model): the
      // turn renders as "sending…" until the relay's OK lands; rejection
      // or a 25s silence removes the delivered-looking bubble and hands
      // the text back — a message the relay never took must not sit in
      // the thread looking sent while the deadline clock runs on nothing.
      const acked = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          pendingOk.current.delete(sid);
          reject(new Error("the relay didn't acknowledge the message — check the connection and try again"));
        }, 25_000);
        pendingOk.current.set(sid, {
          ok: () => { clearTimeout(t); resolve(); },
          fail: (reason) => { clearTimeout(t); reject(new Error(reason)); },
        });
      });
      ws.send(JSON.stringify(["EVENT", signed]));
      setEvents((prev) => new Map(prev).set(sid, verified));
      setPendingIds((prev) => new Set(prev).add(sid));
      try {
        await acked;
      } catch (err) {
        setEvents((prev) => { const next = new Map(prev); next.delete(sid); return next; });
        setDraft(text);
        throw err;
      } finally {
        setPendingIds((prev) => { const next = new Set(prev); next.delete(sid); return next; });
      }
      setDraft("");
      // Clear the ledger copy too — a prefilled draft that already went out
      // must never resurrect on a later reopen and look like a fresh, unsent
      // task. Unconditional (not gated on guest.draft, which can be stale in
      // this closure) — JSON.stringify drops the undefined key, so it never
      // lingers as a literal "draft" field in storage.
      addGuest({ ...guest, draft: undefined });
      // Orchestration corpus: if @fez proposed this hire, the send closes
      // the "accepted" loop with the real task id. Best-effort — a log
      // failure must never look like a failed send.
      void latestPendingFor(tauriStore.read, guest.pk)
        .then((rec) => rec && updateRecord(tauriStore.read, tauriStore.write, rec.id, { sentTaskId: (signed as WireEvent).id }))
        .catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const name = face.name ?? guest.pk.slice(0, 8);
  const freshOffer = offer && nowTick / 1000 - offer.event.created_at <= FRESH_S ? offer : undefined;

  // Honesty for the silent case: a task past its deadline with no reply is
  // said out loud, not left hanging. The answered set keys it; nowTick
  // moves the clock so the line appears without any new event arriving.
  const answered = new Set(
    all.filter((e) => e.kind === KIND_RESULT && e.pubkey === guest.pk).map((e) => rootOf(e) ?? "")
  );
  const deadlineOf = (id: string) => {
    const ev = events.get(id)?.event;
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
          {face.picture ? (
            <img src={face.picture} alt="" width={20} height={20} style={{ imageRendering: "pixelated", display: "block" }} />
          ) : (
            // No published picture — the pk seeds the same generative face
            // as every other surface (agents-face rule: a pk earns a face).
            <UiAvatar pk={guest.pk} name={name} size={20} />
          )}
          <span>{name}</span>
          {/* The liveness dot — derived from the announce heartbeat the
              thread already receives. Unknown renders nothing: no signal
              is not the same claim as away. */}
          {liveness !== "unknown" ? (
            <span
              className="guest-chip"
              style={liveness === "here" ? { color: "var(--ok, #b8bb26)" } : undefined}
              data-tip={
                liveness === "here"
                  ? "announcing at the bazaar — heartbeat within the last 15 minutes"
                  : retiredAt > lastBeatAt
                    ? "left the bazaar (clean shutdown) — tasks wait on the relay until it returns"
                    : "no heartbeat lately — tasks wait on the relay until it returns"
              }
            >
              {liveness === "here" ? "● here" : "○ away"}
            </span>
          ) : null}
          <span
            className="guest-chip"
            data-tip="the agent's public key — its actual identity on the network (the name is self-chosen). Click to copy the full key."
            onClick={() => void navigator.clipboard.writeText(guest.pk)}
          >
            {guest.pk.slice(0, 8)}
          </span>
          <span
            className="guest-chip public"
            data-tip="a public thread on the market relay — anyone can read all of it; history is whatever that relay kept"
          >
            at the bazaar · public
          </span>
          {freshOffer?.offer?.rateTaoHr !== undefined ? (
            <span className="guest-chip" data-tip="Verified advertised rate for prepaid priority; no automatic renewal.">
              {`${freshOffer.offer.rateTaoHr} tτ/hr`}
            </span>
          ) : null}
          {/* The salt tier — ember when no one you can verify vouches
              (the "needs you" signal), quiet otherwise. Unreachable
              relays are "unknown", never "nameless" — offline says
              nothing about who vouches. */}
          {salt === "error" ? (
            <span className="guest-chip" data-tip="relays unreachable — salt unknown, not absent">
              salt unknown
            </span>
          ) : salt ? (
            <span
              className="guest-chip"
              style={salt.tier === "nameless" || salt.tier === "spoken-of" ? { color: "var(--brand, #FF6A00)" } : undefined}
              data-tip={tierTitle(salt.tier)}
            >
              {tierLabel(salt.tier)}
            </span>
          ) : null}
          {/* The write half of the chip beside it: vouch where the
              judgment forms. Hidden while salt is unknown — you can't
              meaningfully vouch (or revoke) against evidence you can't
              read. */}
          {salt && salt !== "error" ? (
            <button
              className="guest-chip"
              style={{ background: "transparent", cursor: "pointer" }}
              disabled={vouching}
              data-tip={
                myVouch
                  ? "withdraw your vouch — republishes your signed note as empty; the tier re-derives without it"
                  : `publish a signed vouch for ${name} — you become part of its public reputation, and anyone who trusts your key sees it as vouched`
              }
              onClick={() => void vouch(myVouch)}
            >
              {vouching ? "…" : myVouch ? "revoke vouch" : "vouch"}
            </button>
          ) : null}
        </div>
      </header>
      <div className="guest-banner">
        {`Anyone can read this thread. Share only the context intended for this job. Messages are signed with your identity and directed to ${name}.`}
      </div>
      <GuestHirePanel key={JSON.stringify([selfPk, guest.pk, guest.relay])}
        scope={{ ownerPk: selfPk, guestPk: guest.pk, relay: guest.relay }}
        tasks={tasks.filter(task => !pendingIds.has(task.event.id))} results={results} offer={freshOffer} />
      <div className="guest-timeline">
        {turns.map((t) =>
          t.kind === "progress" ? (
            <div key={t.id} className="guest-progress">{`· ${t.text}`}</div>
          ) : (
            <div key={t.id} className="guest-turn">
              <div className="guest-turn-meta">
                {t.kind === "mine" ? <span>you</span> : <span className="who-them">{name}</span>}
                {t.kind === "mine" && pendingIds.has(t.id) ? <span className="dim">{" · sending…"}</span> : null}
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
          <p className="guest-empty">
            {liveness === "here"
              ? `The counter is open. Say what you need — ${name} usually answers within a minute.`
              : liveness === "away"
                ? `The counter is open, but ${name} is away right now — say what you need and it waits on the relay until they return.`
                : `The counter is open. Say what you need — it goes out signed with your name.`}
          </p>
        ) : null}
        <div ref={bottomRef} />
      </div>
      {/* The summon gate — inform, don't hard-block. Shown once per guest,
          ever: accepting persists saltAck on the ledger entry. */}
      {/* An "error" panel skips the gate deliberately: unverifiable is
          not the same claim as unvouched, and blocking the composer on
          a network blip would gate every offline conversation. */}
      {/* Rendered ABOVE the composer, never in its place: salt resolves
          5–10s after mount, and swapping the composer out yanked the
          textarea from under a user mid-sentence — on their FIRST
          conversation, since every stranger starts nameless. Typing
          stays free; only send waits for the ack. */}
      {summonGate ? (
        <div className="guest-composer">
          <div className="guest-banner" style={{ color: "var(--brand, #FF6A00)", padding: 0 }}>
            no salt between you and anyone you know — summon anyway?
          </div>
          {[...salt.ring0, ...salt.ring1].slice(0, 5).map((e, i) => (
            <div key={`${e.signer}${i}`} className="guest-banner" style={{ padding: 0 }}>
              {`${e.note} — ${e.signer.slice(0, 8)} · ${new Date(e.at * 1000).toLocaleDateString()}${e.moneyBacked ? " · paid" : ""}`}
            </div>
          ))}
          {salt.ring2Signers > 0 ? (
            <div
              className="guest-banner"
              style={{ padding: 0 }}
              title="distinct keys, sybil-able — each is at least a real keypair vouching in public"
            >
              {`spoken of by ${salt.ring2Signers} key${salt.ring2Signers === 1 ? "" : "s"}`}
            </div>
          ) : null}
          <button
            className="agent-action"
            onClick={() => {
              const hit = listGuests().find((g) => g.pk === guest.pk) ?? guest;
              addGuest({ ...hit, saltAck: true });
              setSaltAck(true);
            }}
          >
            summon anyway
          </button>
        </div>
      ) : null}
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
              if (!summonGate) void send();
            }
          }}
        />
        <button className="agent-action" disabled={sending || !draft.trim() || summonGate} onClick={() => void send()}>
          {sending ? "…" : "send"}
        </button>
      </div>
    </main>
  );
}
