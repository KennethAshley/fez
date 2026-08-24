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
  | { type: "message"; text: string };

/** Called once at app boot so the bridge can answer queries. */
export function configureLiveBridge(client: FezClient): void {
  liveClient = client;
}

/** Wire the human consent prompt for write-back. Without it, `fez.act`
 * fails closed. */
export function configureLiveConsent(fn: (description: string) => Promise<boolean>): void {
  liveConsent = fn;
}

/** Validate + describe + (on consent) perform a proposed write. Read-only
 * data never comes near this path. */
async function performAction(raw: unknown): Promise<{ ok?: true; error?: string }> {
  if (!liveClient) return { error: "the fez bridge isn't ready" };
  if (!liveConsent) return { error: "writing isn't available here" };
  const channelId = liveClient.state.scope?.channelId;
  if (!channelId) return { error: "no channel in scope to act in" };
  const a = raw as Partial<ToolAction> & { type?: string };
  if (a?.type === "react" && typeof a.target === "string" && typeof a.emoji === "string") {
    const emoji = a.emoji.slice(0, 8);
    if (!(await liveConsent(`React ${emoji} — as you`))) return { error: "declined" };
    await liveClient.toggleReaction(channelId, a.target, emoji);
    return { ok: true };
  }
  if (a?.type === "message" && typeof a.text === "string" && a.text.trim()) {
    const text = a.text.slice(0, 2000);
    if (!(await liveConsent(`Post this to the channel — as you:\n\n"${text}"`))) return { error: "declined" };
    await liveClient.sendChannelMessage(text, { channelId });
    return { ok: true };
  }
  return { error: "unsupported action" };
}

/** How often a `subscribe` re-runs its query. Polling for v0 — a push of
 * deltas is the obvious follow-up, but this already reads as "streaming". */
const SUBSCRIBE_INTERVAL_MS = 4000;

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
    // id → interval, so a subscribe keeps re-running until unsubscribed.
    const timers = new Map<number, ReturnType<typeof setInterval>>();

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

    const onMessage = (e: MessageEvent) => {
      // Only this iframe, only our protocol.
      if (e.source !== frame.contentWindow) return;
      const m = e.data as { __fez?: number; type?: string; id?: number; q?: string; action?: unknown };
      if (!m || m.__fez !== 1 || typeof m.id !== "number") return;

      if (m.type === "query") {
        void run(m.q ?? "").then((r) => post({ type: "result", id: m.id, ...r }));
      } else if (m.type === "act") {
        void performAction(m.action).then((r) => post({ type: "result", id: m.id, ...r }));
      } else if (m.type === "subscribe") {
        const id = m.id;
        const qs = m.q ?? "";
        const tick = () => void run(qs).then((r) => post({ type: "update", id, ...r }));
        tick();
        timers.set(id, setInterval(tick, SUBSCRIBE_INTERVAL_MS));
      } else if (m.type === "unsubscribe") {
        const t = timers.get(m.id);
        if (t) {
          clearInterval(t);
          timers.delete(m.id);
        }
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      for (const t of timers.values()) clearInterval(t);
      timers.clear();
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
