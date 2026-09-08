import { useEffect, useRef, useState } from "react";
import { Avatar as UiAvatar } from "@fezchat/ui";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { BrowserWire } from "./wire";
import { latestPendingFor, latestSentFor, updateRecord, tauriStore } from "./orchestration";
import { relaySet } from "./relay";
import { BAZAAR_RELAY } from "./bazaar-record";
import { fetchSaltPanel, invalidateSaltPanel, tierLabel, tierTitle, type SaltPanel } from "./salt-record";

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
  addGuest({ ...hit, ...(name ? { name } : {}), ...(picture ? { picture } : {}) });
}

/** Forgetting a guest forgets the LEDGER ENTRY only — the thread itself is
 * public relay history and comes back intact if they're ever re-added. */
export function removeGuest(pk: string): void {
  localStorage.setItem(LEDGER_KEY, JSON.stringify(listGuests().filter((g) => g.pk !== pk)));
  localStorage.removeItem(`${READ_KEY}-${pk}`);
}

/* ── the hire (model A: a negotiated lump) ─────────────────────────────
 * You chat and agree a price, then "start hire" locks it: the amount, the
 * account it pays FROM, and when. Settle pays it to the agent's announced
 * address via the wallet's tested `pay` verb. Persisted per guest so it
 * survives navigation; one active hire per guest at a time. */
export interface Hire {
  amount: string;         // tТАО, the agreed lump
  persona: string;        // which of your wallet accounts pays
  at: number;             // when the hire started (unix ms)
  settled?: { txHash: string; at: number };
  /** Escrow variant: the lump is HELD at a 2-of-3 multisig (you, the
   *  agent, the arbiter) the moment terms lock — the agent can verify the
   *  money exists before working, and release/refund each need two keys.
   *  ponytail: the arbiter is currently your own escrowarbiter persona, so
   *  today this protects delivery-shape, not you-vs-you; a neutral arbiter
   *  (a validator) is the upgrade path. */
  escrow?: { addr: string; state: "open" | "released" | "refunded" };
}
const HIRE_KEY = "fez-hire";
export function getHire(pk: string): Hire | undefined {
  try { return JSON.parse(localStorage.getItem(`${HIRE_KEY}-${pk}`) ?? "null") as Hire ?? undefined; }
  catch { return undefined; }
}
export function setHire(pk: string, hire: Hire | undefined): void {
  if (hire) localStorage.setItem(`${HIRE_KEY}-${pk}`, JSON.stringify(hire));
  else localStorage.removeItem(`${HIRE_KEY}-${pk}`);
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
  // The money context (read-only for now): where a settlement would go
  // (the agent's announced receive address) and where it'd come from (your
  // wallet's accounts, from the extension's public mirror). This is the
  // "the bazaar can see the wallet" seam — the meter and settle build on it.
  const [agentPayTo, setAgentPayTo] = useState<string>();
  const [agentRate, setAgentRate] = useState<number>();       // tТАО/hr, if the agent offers a lease
  const [leaseUntil, setLeaseUntil] = useState<number>(() => Number(localStorage.getItem(`fez-lease-${guest.pk}`) ?? 0));
  const [leasing, setLeasing] = useState(false);
  const [payFrom, setPayFrom] = useState<{ name: string; address: string }[]>([]);
  // The hire (model A): persisted terms, plus the in-flight "start hire"
  // form and the settle spinner.
  const [hire, setHireState] = useState<Hire | undefined>(() => getHire(guest.pk));
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
  const [starting, setStarting] = useState(false);
  const [hireAmt, setHireAmt] = useState("");
  const [hirePersona, setHirePersona] = useState("");
  const [settling, setSettling] = useState(false);
  const [hireErr, setHireErr] = useState<string>();
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
        // Latest binding: empty content = the miner said goodbye cleanly.
        ws.send(JSON.stringify(["REQ", "gt-bind", { kinds: [KIND_BINDING], authors: [guest.pk], limit: 1 }]));
      };
      ws.onmessage = (m) => {
        let msg: unknown[];
        try { msg = JSON.parse(String(m.data)) as unknown[]; } catch { return; }
        if (msg[0] === "OK") {
          const [, id, accepted, reason] = msg as [string, string, boolean, string?];
          const waiter = pendingOk.current.get(id);
          if (waiter) {
            pendingOk.current.delete(id);
            if (accepted) waiter.ok();
            else waiter.fail(reason || "the relay rejected the message");
          }
          return;
        }
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
          // The announce IS the heartbeat (miners re-send every 5 min) —
          // its timestamp is the liveness lease, not just its payload.
          setLastBeatAt((prev) => Math.max(prev, ev.created_at));
          try {
            const beat = JSON.parse(ev.content) as { pay_to?: string; rate?: { tao_hr?: number } };
            if (beat.pay_to) setAgentPayTo(beat.pay_to);
            if (beat.rate?.tao_hr && beat.rate.tao_hr > 0) setAgentRate(beat.rate.tao_hr);
          } catch { /* unparseable beat */ }
          return;
        }
        if (ev.kind === KIND_BINDING) {
          if (ev.content) setLastBeatAt((prev) => Math.max(prev, ev.created_at)); // fresh enrollment = alive
          else setRetiredAt((prev) => Math.max(prev, ev.created_at));
          return;
        }
        if (ev.kind === KIND_RESULT && ev.pubkey === guest.pk) {
          // Orchestration corpus: an answer to the sent task closes the
          // "delivered" leg of the record. Best-effort — a log failure
          // must never look like a dropped result.
          const rootId = ev.tags.find((t) => t[0] === "e" && t[3] === "root")?.[1] ?? ev.tags.find((t) => t[0] === "e")?.[1];
          void latestPendingFor(tauriStore.read, guest.pk)
            .then((rec) => {
              if (!rec?.sentTaskId || rec.outcome) return;
              if (rootId !== rec.sentTaskId) return; // only the proposed task closes the record
              return updateRecord(tauriStore.read, tauriStore.write, rec.id, { outcome: { delivered: true } });
            })
            .catch(() => {});
        }
        setEvents((prev) => (prev.has(ev.id) ? prev : new Map(prev).set(ev.id, ev)));
      };
      ws.onclose = () => {
        // A send the relay never acknowledged must fail loudly, not spin —
        // buzz rejects every in-flight publish on disconnect.
        for (const waiter of pendingOk.current.values()) waiter.fail("connection dropped before the relay confirmed");
        pendingOk.current.clear();
        if (!closed) setTimeout(connect, 4000);
      };
    };
    connect();
    return () => { closed = true; ws?.close(); };
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
      const sid = (signed as WireEvent).id;
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
      setEvents((prev) => new Map(prev).set(sid, signed as WireEvent));
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

  const name = guest.name ?? guest.pk.slice(0, 8);

  // How many of my asks this agent actually delivered on — the meter's
  // "work done" number (my task-roots that got a result).
  const delivered = [...myTaskIds].filter((id) => resultRoots.has(id)).length;

  const startHire = () => {
    const amt = Number(hireAmt);
    if (!(amt > 0)) { setHireErr("enter an amount greater than zero"); return; }
    const persona = hirePersona || payFrom[0]?.name;
    if (!persona) { setHireErr("no wallet account to pay from"); return; }
    const h: Hire = { amount: hireAmt.trim(), persona, at: Date.now() };
    setHire(guest.pk, h); setHireState(h); setStarting(false); setHireErr(undefined);
  };

  // Escrow hire: same terms, but the lump moves NOW — into a 2-of-3
  // multisig (you, the agent, the arbiter) — so the agent can verify the
  // money exists before working, and no single key can take it back.
  const ARBITER = "escrowarbiter";
  const arbiterAddr = payFrom.find((a) => a.name === ARBITER)?.address;
  const walletCall = async (args: string[]): Promise<Record<string, unknown>> => {
    const res = await invoke<{ code: number; stdout: string; stderr: string }>("run_extension_bin", {
      extension: "wallet", bin: "fez-wallet", args,
    });
    if (res.code !== 0) throw new Error(res.stderr.split("\n").map((l) => l.trim()).filter(Boolean).pop() || `wallet exited ${res.code}`);
    return JSON.parse(res.stdout.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
  };

  const startEscrow = async () => {
    const amt = Number(hireAmt);
    if (!(amt > 0)) { setHireErr("enter an amount greater than zero"); return; }
    const persona = hirePersona || payFrom[0]?.name;
    if (!persona || settling) return;
    if (!agentPayTo || !arbiterAddr) { setHireErr("escrow needs the agent's address and an arbiter account"); return; }
    setSettling(true); setHireErr(undefined);
    try {
      const out = await walletCall(["escrow", "open", agentPayTo, arbiterAddr, hireAmt.trim(), "--as", persona, "--json"]);
      const h: Hire = { amount: hireAmt.trim(), persona, at: Date.now(), escrow: { addr: String(out.escrow ?? ""), state: "open" } };
      setHire(guest.pk, h); setHireState(h); setStarting(false);
    } catch (err) {
      setHireErr(err instanceof Error ? err.message : String(err));
    } finally { setSettling(false); }
  };

  // Two approvals move escrowed funds: yours (the poster), then the
  // arbiter's — the second executes the transfer. Both keys are local, so
  // one click does both; when the arbiter is a neutral someday, the second
  // half becomes their act, not this button's.
  const closeEscrow = async (verb: "release" | "refund") => {
    if (!hire?.escrow || settling) return;
    const posterAddr = payFrom.find((a) => a.name === hire.persona)?.address;
    if (!posterAddr || !agentPayTo || !arbiterAddr) { setHireErr("missing an escrow address — wallet mirror out of date?"); return; }
    setSettling(true); setHireErr(undefined);
    try {
      const args = ["escrow", verb, posterAddr, agentPayTo, arbiterAddr, hire.amount, "--json"];
      const first = await walletCall([...args, "--as", hire.persona]).catch((err: unknown) => {
        // The chain's raw voice for "can't reserve the multisig deposit"
        // is InsufficientBalance — translate it, because the money's
        // already locked in escrow when this hits and a raw error reads
        // as lost funds. The deposit (~0.2 tτ) is refunded on execution.
        const msg = err instanceof Error ? err.message : String(err);
        if (/InsufficientBalance|too low/i.test(msg)) {
          throw new Error(`${hire.persona} can't cover the release deposit (~0.2 tτ, held by the chain during approval and refunded when it executes) — top up ${hire.persona} and press ${verb} again; the escrow is safe meanwhile`);
        }
        throw err;
      });
      const exec = first.executed ? first : await walletCall([...args, "--as", ARBITER]);
      const releaseTxHash = String(exec.txHash ?? "");
      const done: Hire = {
        ...hire,
        escrow: { ...hire.escrow, state: verb === "release" ? "released" : "refunded" },
        ...(verb === "release" ? { settled: { txHash: releaseTxHash, at: Date.now() } } : {}),
      };
      setHire(guest.pk, done); setHireState(done);
      // Orchestration corpus: an escrow release is a paid hire — record
      // what moved. Best-effort, and only on release (a refund paid nobody).
      if (verb === "release") {
        void latestSentFor(tauriStore.read, guest.pk)
          .then((rec) => rec && updateRecord(tauriStore.read, tauriStore.write, rec.id, { hire: { kind: "escrow", paid: hire.amount, txHash: releaseTxHash } }))
          .catch(() => {});
      }
    } catch (err) {
      setHireErr(err instanceof Error ? err.message : String(err));
    } finally { setSettling(false); }
  };

  // Streaming lease: pay for a block of hours at the agent's advertised
  // rate, which buys PRIORITY (the miner tracks paidUntil and serves your
  // asks first while paid). Reuses the tested `rent` verb. Persona-only
  // for now (root-free rent can't sign as treasury — same limit `pay` had
  // before payFromTreasury; a treasury lease is the matching follow-up).
  const startLease = async (hours: number, persona: string) => {
    if (leasing || !(hours > 0)) return;
    setLeasing(true); setHireErr(undefined);
    try {
      const res = await invoke<{ code: number; stdout: string; stderr: string }>("run_extension_bin", {
        extension: "wallet", bin: "fez-wallet",
        args: ["rent", guest.pk, String(hours), "--as", persona, "--json"],
      });
      if (res.code !== 0) throw new Error(res.stderr.split("\n").map((l) => l.trim()).filter(Boolean).pop() || `lease exited ${res.code}`);
      // Extend from paid-through, not from now — mid-lease ticks stack
      // (matching the miner's ledger), they don't reset the clock.
      const until = Math.max(Date.now(), leaseUntil) + hours * 3_600_000;
      localStorage.setItem(`fez-lease-${guest.pk}`, String(until));
      setLeaseUntil(until);
    } catch (err) {
      setHireErr(err instanceof Error ? err.message : String(err));
    } finally {
      setLeasing(false);
    }
  };

  const settle = async () => {
    if (!hire || settling) return;
    if (!agentPayTo) { setHireErr("this agent hasn't published a receive address — nothing to settle to"); return; }
    setSettling(true); setHireErr(undefined);
    try {
      // The tested `pay` verb, invoked as the wallet extension (holds
      // `processes`). `--for` ties the receipt to one of my task roots so
      // the settlement is legible on the relay.
      const anyRoot = [...myTaskIds][0];
      const res = await invoke<{ code: number; stdout: string; stderr: string }>("run_extension_bin", {
        extension: "wallet",
        bin: "fez-wallet",
        args: ["pay", agentPayTo, hire.amount, "--as", hire.persona, "--to-pk", guest.pk, ...(anyRoot ? ["--for", anyRoot] : []), "--json"],
      });
      if (res.code !== 0) throw new Error(res.stderr.split("\n").map((l) => l.trim()).filter(Boolean).pop() || `settle exited ${res.code}`);
      const out = JSON.parse(res.stdout.trim().split("\n").pop() ?? "{}") as { txHash?: string };
      const settleTxHash = out.txHash ?? "";
      const settled: Hire = { ...hire, settled: { txHash: settleTxHash, at: Date.now() } };
      setHire(guest.pk, settled); setHireState(settled);
      // Orchestration corpus: what was actually paid, once settle succeeds.
      // Best-effort — a log failure must never look like a failed settle.
      void latestSentFor(tauriStore.read, guest.pk)
        .then((rec) => rec && updateRecord(tauriStore.read, tauriStore.write, rec.id, { hire: { kind: "settle", paid: hire.amount, txHash: settleTxHash } }))
        .catch(() => {});
    } catch (err) {
      setHireErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSettling(false);
    }
  };

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
          {/* Price discovery, not a control: renting is an agent act
              (wallet_rent — the payer's own asks get priority). Here it
              tells you the counter's rate. */}
          {guest.rateTaoHr !== undefined ? (
            <span
              className="guest-chip"
              style={{ color: "var(--ok, #b8bb26)" }}
              data-tip={`this agent's asking rate: rent it for ${guest.rateTaoHr} tTAO per hour to jump its queue (one of your agents does the renting, via wallet_rent)`}
            >
              {`${guest.rateTaoHr} tτ/hr`}
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
        {`Anyone can read this thread — never share secrets here. Messages you send are tasks only ${name} may answer, signed with your name.`}
      </div>
      {/* The hire: chat free, then start a negotiated-lump hire, watch the
          meter, and settle to the agent's address through the wallet. Four
          states — settled, active (the meter), starting (the form), and the
          idle offer to begin. */}
      <div className="guest-hire">
        {hire?.escrow?.state === "refunded" ? (
          <span title={`the escrow at ${hire.escrow.addr} was refunded to ${hire.persona}`}>
            {`↩ refunded — ${hire.amount} tτ returned to ${hire.persona}`}
            <button className="guest-hire-link" onClick={() => { setHire(guest.pk, undefined); setHireState(undefined); }}>new hire</button>
          </span>
        ) : hire?.settled ? (
          <span title={`paid ${hire.amount} tТАО from ${hire.persona}`}>
            {hire.escrow ? `✓ released from escrow — ${hire.amount} tτ paid` : `✓ settled — paid ${hire.amount} tτ from ${hire.persona}`}
            {hire.settled.txHash ? <span className="dim">{` · tx ${hire.settled.txHash.slice(0, 10)}…`}</span> : null}
            <button className="guest-hire-link" onClick={() => { setHire(guest.pk, undefined); setHireState(undefined); }}>new hire</button>
          </span>
        ) : hire?.escrow ? (
          <span>
            {`◈ escrowed · ${hire.amount} tτ held at ${hire.escrow.addr.slice(0, 6)}…${hire.escrow.addr.slice(-4)} · ${delivered} delivered`}
            <button className="guest-hire-btn" disabled={settling} title={`two approvals (you + the arbiter) move ${hire.amount} tТАО to ${name}`} onClick={() => void closeEscrow("release")}>
              {settling ? "signing…" : "release & pay"}
            </button>
            <button className="guest-hire-link" disabled={settling} title="two approvals return the funds to you" onClick={() => void closeEscrow("refund")}>refund</button>
          </span>
        ) : hire ? (
          <span>
            {`◈ hired · ${hire.amount} tτ agreed · from ${hire.persona} · ${delivered} delivered`}
            <button className="guest-hire-btn" disabled={settling || !agentPayTo} title={agentPayTo ? `pay ${hire.amount} tТАО to ${name}` : "the agent hasn't published a receive address yet"} onClick={() => void settle()}>
              {settling ? "settling…" : "settle & pay"}
            </button>
            <button className="guest-hire-link" onClick={() => { setHire(guest.pk, undefined); setHireState(undefined); setHireErr(undefined); }}>cancel</button>
          </span>
        ) : starting ? (
          <span className="guest-hire-form">
            <span className="dim">start hire —</span>
            <input className="guest-hire-amt" placeholder="amount" value={hireAmt} onChange={(e) => setHireAmt(e.target.value)} />
            <span className="dim">tτ, paid from</span>
            <select className="guest-hire-sel" value={hirePersona} onChange={(e) => setHirePersona(e.target.value)}>
              {payFrom.filter((a) => a.name !== ARBITER).map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
            </select>
            <button className="guest-hire-btn" onClick={startHire} title="a handshake — nothing moves until you settle">lock terms</button>
            {agentPayTo && arbiterAddr ? (
              <button className="guest-hire-btn" disabled={settling} onClick={() => void startEscrow()} title="funds move NOW into a 2-of-3 multisig the agent can verify; release or refund needs two keys. Releasing also holds a ~0.2 tτ chain deposit from the paying account (refunded when it executes)">
                {settling ? "funding…" : "hold in escrow"}
              </button>
            ) : null}
            <button className="guest-hire-link" onClick={() => { setStarting(false); setHireErr(undefined); }}>cancel</button>
          </span>
        ) : (
          <span>
            {agentPayTo
              ? <span className="dim">{`◈ hireable — settles to ${agentPayTo.slice(0, 6)}…${agentPayTo.slice(-4)}`}</span>
              : <span className="dim" title="the agent hasn't published a receive address — its miner needs a wallet account (fez-wallet derive <name>)">◇ no receive address yet</span>}
            {payFrom.length ? (
              <button className="guest-hire-link" onClick={() => { setStarting(true); setHirePersona(payFrom[0]?.name ?? ""); }}>start a hire</button>
            ) : <span className="dim"> · no wallet to pay from</span>}
          </span>
        )}
        {/* Streaming lease — pay-per-time, buys PRIORITY. Shown when the
            agent advertises a rate. Paid from a persona (rent is root-free).
            Active → the priority meter; idle → a one-hour lease button. */}
        {(() => {
          const leasePayer = payFrom.find((a) => a.name !== "treasury")?.name;
          // Ticks, not a fixed hour: the lease is prepaid per-call, so a
          // thin allowance can still buy 15 minutes of priority. Costs are
          // hours × the announced rate, shown so the click IS the consent.
          const TICKS: [number, string][] = [[0.25, "15m"], [1, "1h"]];
          const cost = (h: number) => {
            const c = h * (agentRate ?? 0);
            return `${Number(c.toFixed(3))} tτ`;
          };
          if (leaseUntil > nowTick) {
            const t = new Date(leaseUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            return (
              <span className="guest-lease on" title="you have priority — the agent serves your asks first while the lease is live">
                {` · ⚡ priority through ${t}`}
                {agentRate && leasePayer
                  ? TICKS.map(([h, label]) => (
                      <button key={label} className="guest-hire-link" disabled={leasing} title={`extend ${label} for ${cost(h)}, paid from ${leasePayer}`} onClick={() => void startLease(h, leasePayer)}>
                        {leasing ? "…" : `+${label}`}
                      </button>
                    ))
                  : null}
              </span>
            );
          }
          if (agentRate && leasePayer) {
            return (
              <span className="guest-lease">
                {" · ⚡ lease"}
                {TICKS.map(([h, label]) => (
                  <button key={label} className="guest-hire-link" disabled={leasing} title={`${label} of priority for ${cost(h)}, paid from ${leasePayer}`} onClick={() => void startLease(h, leasePayer)}>
                    {leasing ? "…" : `${label} (${cost(h)})`}
                  </button>
                ))}
              </span>
            );
          }
          return null;
        })()}
        {hireErr ? <span className="guest-hire-err">{` · ${hireErr}`}</span> : null}
      </div>
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
