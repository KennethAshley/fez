import { useEffect, useRef } from "react";
import { parseQuery, type FezClient } from "@fezchat/client";
import type { Artifact } from "@fezchat/client";

/**
 * The read bridge — the one trust-bearing seam behind "the agent builds
 * the UI." A `live` artifact is arbitrary HTML in a sandboxed, origin-null
 * iframe (no cookies, no parent DOM, no keys), but with ONE channel back:
 * a read-only `window.fez.query(q)` / `fez.subscribe(q, cb)` over
 * postMessage. The tool asks a question in the fez query language; the
 * host validates it through `parseQuery` (already bounded on time/limit),
 * runs it with the same `gather` the doc-blocks use, and streams rows
 * back.
 *
 * Why this must live in core, not an extension: it hands relay data to
 * untrusted generated code, so the boundary — read-only, query-validated,
 * no network egress (CSP `connect-src 'none'`) — has to be owned here, not
 * declared by the thing on the other side of it. A tool can render
 * anything and read what a bounded query returns; it can do nothing else.
 *
 * Write-back — `window.fez.act(...)` — IS here now, but gated: every write
 * is a bounded, allowlisted action (react / post a message) that the host
 * describes to the human and publishes only on their explicit consent. The
 * tool never holds the key; it can only PROPOSE a transaction the person
 * approves — the wallet shape. Reads are free; writes ask.
 */

let liveClient: FezClient | undefined;
/** The human's per-write consent gate, provided by the app. Undefined =
 * writes are unavailable (fail closed). */
let liveConsent: ((description: string) => Promise<boolean>) | undefined;

/** A bounded write a tool may propose. Anything outside this set is refused
 * before consent is even asked — the allowlist IS the scope. */
type ToolAction =
  | { type: "react"; target: string; emoji: string }
  | { type: "message"; text: string }
  | { type: "task"; text: string; done?: boolean };

/** Called once at app boot so the bridge can answer queries. */
export function configureLiveBridge(client: FezClient): void {
  liveClient = client;
}

/** Wire the human consent prompt for write-back. Without it, `fez.act`
 * fails closed. */
export function configureLiveConsent(fn: (description: string) => Promise<boolean>): void {
  liveConsent = fn;
}

/** Validate + describe + (on consent) perform a proposed write. Writes are
 * bound to the ARTIFACT's channel (and its thread, when it has one) — never
 * to whatever channel the app currently has in scope, which can differ when
 * a tool pane stays open across a channel switch. Read-only data never
 * comes near this path. */
async function performAction(raw: unknown, artifact: Artifact): Promise<{ ok?: true; error?: string }> {
  if (!liveClient) return { error: "the fez bridge isn't ready" };
  if (!liveConsent) return { error: "writing isn't available here" };
  const { channelId, rootId } = artifact;
  if (!channelId) return { error: "this tool has no home channel to act in" };
  const where = `#${liveClient.state.workspace.channels.get(channelId)?.name ?? channelId.slice(0, 8)}`;
  const a = raw as Partial<ToolAction> & { type?: string };
  if (a?.type === "react" && typeof a.target === "string" && typeof a.emoji === "string") {
    const emoji = a.emoji.slice(0, 8);
    if (!(await liveConsent(`React ${emoji} in ${where} — as you`))) return { error: "declined" };
    await liveClient.toggleReaction(channelId, a.target, emoji);
    return { ok: true };
  }
  if (a?.type === "message" && typeof a.text === "string" && a.text.trim()) {
    const text = a.text.slice(0, 2000);
    const target = rootId ? `the tool's thread in ${where}` : where;
    // A leading @mention of a known agent is a summon — sentinel spawns
    // agents off exactly this text — so the consent copy names those stakes.
    const mention = /^@([\w-]+)/.exec(text.trim())?.[1]?.toLowerCase();
    const isSummon = !!mention && [...liveClient.agents().values()].some((n) => n.toLowerCase() === mention);
    const ask = isSummon
      ? `Summon @${mention} in ${where} — as you:\n\n"${text}"`
      : `Post to ${target} — as you:\n\n"${text}"`;
    if (!(await liveConsent(ask))) return { error: "declined" };
    await liveClient.sendChannelMessage(text, { channelId, threadRootId: rootId });
    return { ok: true };
  }
  if (a?.type === "task" && typeof a.text === "string" && a.text.trim()) {
    const text = a.text.trim().slice(0, 300);
    const done = a.done !== false;
    const hits = findTaskLocations(liveClient, text);
    if (hits.length === 0) return { error: `no checkbox matching "${text}"` };
    if (hits.length > 1) return { error: `"${text}" appears in ${hits.length} places — too ambiguous to act on` };
    const hit = hits[0];
    if (!(await liveConsent(`Mark ${done ? "done" : "not done"} in ${hit.where} — as you:\n\n"${text}"`)))
      return { error: "declined" };
    await liveClient.setTaskDone(hit.channelId, text, done, hit.slug);
    return { ok: true };
  }
  return { error: "unsupported action" };
}

/** Where a checkbox with exactly this text lives — the same wiki pages and
 * channel docs the `tasks` query reads (and the same checkbox shape). A
 * write needs ONE unambiguous home; the caller refuses on 0 or 2+. */
function findTaskLocations(client: FezClient, text: string): { where: string; channelId: string; slug?: string }[] {
  const has = (content: string) =>
    content.split("\n").some((line) => {
      const match = /^\s*[-*+]\s+\[[ xX]\]\s+(.+)$/.exec(line);
      return !!match && match[1].trim() === text;
    });
  const hits: { where: string; channelId: string; slug?: string }[] = [];
  for (const page of client.wikiDocs().values()) {
    if (has(page.latestContent)) hits.push({ where: page.title, channelId: page.channelId, slug: page.slug });
  }
  for (const [channelId, info] of client.docsByChannel()) {
    if (has(info.latestContent)) {
      const name = client.state.workspace.channels.get(channelId)?.name ?? channelId.slice(0, 8);
      hits.push({ where: `#${name}`, channelId });
    }
  }
  return hits;
}

/** Client events that can change what a live query would return. Any of
 * them re-runs active subscriptions (debounced); the slow poll below is
 * only a safety net for changes that arrive without an event. */
const CHANGE_EVENTS = ["message", "docChanged", "reaction", "metaChanged", "jobsChanged"] as const;
const RERUN_DEBOUNCE_MS = 300;
const SAFETY_POLL_MS = 30_000;

/** Wrap the tool's body HTML in a locked-down document: the fez shim, and
 * a CSP that allows inline script/style + data: images but NO network, so
 * a tool can never exfiltrate what it read. */
function wrapLiveDoc(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">
<script>
(function(){
  var seq=0, pending={}, subs={};
  window.fez = {
    query: function(q){ return new Promise(function(res,rej){ var id=++seq; pending[id]={res:res,rej:rej}; parent.postMessage({__fez:1,type:'query',id:id,q:String(q)},'*'); }); },
    subscribe: function(q, cb){ var id=++seq; subs[id]=cb; parent.postMessage({__fez:1,type:'subscribe',id:id,q:String(q)},'*'); return function(){ delete subs[id]; parent.postMessage({__fez:1,type:'unsubscribe',id:id},'*'); }; },
    // Propose a write — the host asks the human before anything is signed.
    react: function(target, emoji){ return window.fez.act({type:'react', target:String(target), emoji:String(emoji)}); },
    message: function(text){ return window.fez.act({type:'message', text:String(text)}); },
    task: function(text, done){ return window.fez.act({type:'task', text:String(text), done:done!==false}); },
    act: function(action){ return new Promise(function(res,rej){ var id=++seq; pending[id]={res:res,rej:rej}; parent.postMessage({__fez:1,type:'act',id:id,action:action},'*'); }); }
  };
  window.addEventListener('message', function(e){
    var m=e.data; if(!m||m.__fezhost!==1) return;
    if(m.type==='result'){ var p=pending[m.id]; if(p){ delete pending[m.id]; m.error? p.rej(new Error(m.error)) : p.res(m.rows); } }
    else if(m.type==='update'){ var cb=subs[m.id]; if(cb){ try{ cb(m.rows, m.error?new Error(m.error):null); }catch(_){} } }
  });
})();
</script>
</head><body>${body}</body></html>`;
}

export function LiveArtifact({ artifact }: { artifact: Artifact }): React.ReactNode {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    // Active subscriptions: id → query string. Re-run on pushed change
    // events, not a per-sub interval — the relay already told us.
    const subs = new Map<number, string>();

    const post = (msg: Record<string, unknown>) => frame.contentWindow?.postMessage({ __fezhost: 1, ...msg }, "*");

    const run = async (qs: string): Promise<{ rows?: unknown[]; error?: string }> => {
      if (!liveClient) return { error: "the fez data bridge isn't ready yet" };
      try {
        const rows = await liveClient.runQuery(parseQuery(qs));
        return { rows };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    };

    const rerunAll = () => {
      for (const [id, qs] of subs) void run(qs).then((r) => post({ type: "update", id, ...r }));
    };
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      clearTimeout(debounce);
      debounce = setTimeout(rerunAll, RERUN_DEBOUNCE_MS);
    };
    const unsubscribers = CHANGE_EVENTS.map((ev) => liveClient?.on(ev, onChange)).filter(Boolean) as (() => void)[];
    const safety = setInterval(rerunAll, SAFETY_POLL_MS);

    const onMessage = (e: MessageEvent) => {
      // Only this iframe, only our protocol.
      if (e.source !== frame.contentWindow) return;
      const m = e.data as { __fez?: number; type?: string; id?: number; q?: string; action?: unknown };
      if (!m || m.__fez !== 1 || typeof m.id !== "number") return;

      if (m.type === "query") {
        void run(m.q ?? "").then((r) => post({ type: "result", id: m.id, ...r }));
      } else if (m.type === "act") {
        void performAction(m.action, artifact).then((r) => post({ type: "result", id: m.id, ...r }));
      } else if (m.type === "subscribe") {
        const id = m.id;
        const qs = m.q ?? "";
        subs.set(id, qs);
        void run(qs).then((r) => post({ type: "update", id, ...r }));
      } else if (m.type === "unsubscribe") {
        subs.delete(m.id);
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      for (const off of unsubscribers) off();
      clearTimeout(debounce);
      clearInterval(safety);
      subs.clear();
    };
  }, [artifact.content, artifact.url]);

  const doc = artifact.content ? wrapLiveDoc(artifact.content) : undefined;
  if (!doc) return null;
  return (
    <iframe
      ref={frameRef}
      className="artifact-frame"
      sandbox="allow-scripts"
      srcDoc={doc}
      title={artifact.title ?? "live tool"}
    />
  );
}
