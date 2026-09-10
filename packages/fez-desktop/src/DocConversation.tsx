import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { bindMention, locateDocAnchor, type DocAnchor, type DocCommentThread, type FezClient, type MentionBindings, type WireEvent } from "@fezchat/client";
import MentionBox from "./MentionBox";
import { documentChange } from "./doc-workspace";

export interface DocFocus { threadId?: string; anchor?: DocAnchor }
interface Draft { text: string; bindings: MentionBindings; agent?: string }
const emptyDraft: Draft = { text: "", bindings: new Map() };
const messageTime = (ts: number) => new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export default function DocConversation({ client, pageKey, channelId, slug, versions, threads, focus, onFocus, onRefresh, onUndo, tab, onTab, onViewVersion }: {
  client: FezClient;
  pageKey: string;
  channelId: string;
  slug?: string;
  versions: WireEvent[];
  threads: DocCommentThread[];
  focus: DocFocus;
  onFocus: (focus: DocFocus) => void;
  onRefresh: () => Promise<void>;
  onUndo: (version: WireEvent) => Promise<void>;
  tab: "conversation" | "changes";
  onTab: (tab: "conversation" | "changes") => void;
  onViewVersion: (id: string | undefined) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [sending, setSending] = useState<Set<string>>(new Set());
  const [waiting, setWaiting] = useState<Record<string, { agents: string[]; seen: string[]; since: number }>>({});
  const [changeId, setChangeId] = useState<string>();
  const [undoing, setUndoing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const currentPage = useRef(pageKey);
  currentPage.current = pageKey;
  const endRef = useRef<HTMLDivElement>(null);
  const thread = threads.find(t => t.id === focus.threadId);
  const anchor = thread?.anchorContext ?? focus.anchor ?? (thread?.anchor ? { text: thread.anchor, prefix: "", suffix: "" } : undefined);
  const scopeKey = JSON.stringify([pageKey, focus.threadId ?? focus.anchor ?? "page"]);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const draft = drafts[scopeKey] ?? emptyDraft;
  const setDraft = (next: Partial<Draft>) => setDrafts(all => ({ ...all, [scopeKey]: { ...(all[scopeKey] ?? emptyDraft), ...next } }));
  const error = errors[scopeKey];
  const setError = (message?: string) => setErrors(all => ({ ...all, [scopeKey]: message }));
  const roster = client.mentionCandidates(channelId).filter(p => p.isMember);
  const agents = [...client.agents()].filter(([pk]) => roster.some(p => p.pubkey === pk) && pk !== client.pubkey);
  const selectedAgent = draft.agent ?? thread?.writerPk ?? agents[0]?.[0] ?? "";
  const activeAgent = agents.some(([pk]) => pk === selectedAgent) ? selectedAgent : "";
  const latest = versions.at(-1);
  const version = versions.find(v => v.id === changeId) ?? latest;
  const base = versions.find(v => v.id === version?.tags.find(t => t[0] === "base")?.[1]);
  const change = version && base ? documentChange(base.content, version.content) : undefined;
  const wait = focus.threadId ? waiting[focus.threadId] : undefined;
  const pendingAgents = wait?.agents.filter(pk => !thread?.replies.some(r => r.authorPk === pk && !wait.seen.includes(r.id))) ?? [];

  useEffect(() => { setChangeId(undefined); }, [pageKey]);
  useEffect(() => {
    if (!pendingAgents.length) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [pendingAgents.length]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }); }, [thread?.id, thread?.replies.length]);

  const send = async (body = draft.text) => {
    const text = body.trim();
    if (!text || sending.has(scopeKey) || (focus.threadId && !thread)) return;
    setError();
    setSending(keys => new Set(keys).add(scopeKey));
    try {
      const mentioned = client.resolveMentionsIn(text, channelId, draft.bindings).pubkeys;
      const recipients = [...new Set([...mentioned, ...(activeAgent ? [activeAgent] : [])])];
      const event = await client.publishDocComment(channelId, text, {
        slug, parentId: thread?.id, anchor: anchor?.text, anchorContext: anchor,
        mentionPks: recipients, writerPk: activeAgent || undefined,
      });
      const rootId = thread?.id ?? event.id;
      // Move a new thread's draft to its signed ID, including text typed while sending.
      setDrafts(all => {
        const current = all[scopeKey] ?? emptyDraft;
        const next = current.text === body ? { ...current, text: "", bindings: new Map() } : current;
        return { ...all, [scopeKey]: { ...current, text: "", bindings: new Map() }, [JSON.stringify([pageKey, rootId])]: next };
      });
      setWaiting(all => ({ ...all, [rootId]: { agents: recipients.filter(pk => agents.some(([id]) => id === pk)), seen: thread?.replies.map(r => r.id) ?? [], since: Date.now() } }));
      if (currentPage.current !== pageKey || currentScope.current === scopeKey) onFocus({ threadId: rootId, anchor });
      if (currentPage.current === pageKey) await onRefresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSending(keys => { const next = new Set(keys); next.delete(scopeKey); return next; }); }
  };

  const resolve = async () => {
    if (!thread || sending.has(scopeKey)) return;
    setError(); setSending(keys => new Set(keys).add(scopeKey));
    try {
      await client.publishDocComment(channelId, "", { slug, parentId: thread.id, resolve: !thread.resolved });
      if (currentPage.current === pageKey) await onRefresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSending(keys => { const next = new Set(keys); next.delete(scopeKey); return next; }); }
  };

  const undo = async () => {
    if (!version || undoing) return;
    setError(); setUndoing(true);
    try { await onUndo(version); setChangeId(undefined); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setUndoing(false); }
  };

  const messages = thread ? [thread, ...thread.replies] : [];
  return (
    <aside className="doc-conversation" aria-label="Document conversation">
      <div className="doc-activity-tabs" role="tablist" aria-label="Document activity">
        <button id="doc-conversation-tab" role="tab" aria-selected={tab === "conversation"} aria-controls="doc-conversation-panel" onClick={() => onTab("conversation")}>Conversation</button>
        <button id="doc-changes-tab" role="tab" aria-selected={tab === "changes"} aria-controls="doc-changes-panel" onClick={() => onTab("changes")}>Changes <span>{Math.max(0, versions.length - 1)}</span></button>
      </div>
      <div id="doc-conversation-panel" role="tabpanel" aria-labelledby="doc-conversation-tab" className="doc-discussion-scroll" hidden={tab !== "conversation"}>
        <div className="doc-discussion-scope">
          <button className="mini" onClick={() => onFocus({})}>{thread || anchor ? "← All discussions" : "Page discussions"}</button>
          {thread && <button className="mini" disabled={sending.has(scopeKey)} onClick={() => void resolve()}>{thread.resolved ? "Reopen" : "Resolve"}</button>}
        </div>
        {anchor && <blockquote className="doc-selected-quote"><span>{anchor.text}</span>
          {latest && !locateDocAnchor(latest.content, anchor) && <small>Passage changed · discussion preserved</small>}
        </blockquote>}
        {thread?.resolved && <div className="doc-discussion-notice">Resolved discussion</div>}
        {!thread && !focus.threadId && !anchor && <>
          <div className="doc-discussion-intro"><h3>Think together. Write here.</h3><p>Ask an agent about this page, or select a passage to discuss it.</p></div>
          {threads.length > 0 && <div className="doc-thread-list">{[...threads].reverse().map(t => (
            <button key={t.id} className="doc-thread-link" onClick={() => onFocus({ threadId: t.id, anchor: t.anchorContext })}>
              <span>{t.anchor || "Whole document"}</span><strong>{t.text}</strong><small>{client.displayName(t.authorPk)} · {t.replies.length} replies{t.resolved ? " · resolved" : ""}</small>
            </button>
          ))}</div>}
        </>}
        {!thread && focus.threadId && <div className="doc-discussion-notice" role="status">Loading conversation… <button className="mini" onClick={() => void onRefresh()}>Retry</button></div>}
        {messages.map(message => <div className="doc-discussion-message" key={message.id}>
          <div className="doc-discussion-author"><span className={client.agents().has(message.authorPk) ? "doc-person agent" : "doc-person"}>{client.displayName(message.authorPk).slice(0, 1).toUpperCase()}</span>
            <strong>{client.displayName(message.authorPk)}</strong><time dateTime={new Date(message.ts * 1000).toISOString()}>{messageTime(message.ts)}</time>
          </div>
          <div className="md doc-message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} onClick={event => { event.preventDefault(); if (href) void openUrl(href); }}>{children}</a> }}>{message.text}</ReactMarkdown></div>
        </div>)}
        {pendingAgents.length > 0 && <div className="doc-discussion-notice" role="status">{now - (wait?.since ?? now) >= 180_000 ? "Still waiting for " : "Waiting for "}{pendingAgents.map(pk => client.displayName(pk)).join(", ")}…{now - (wait?.since ?? now) >= 180_000 && " You can keep writing; their reply will appear here."}</div>}
        {thread && thread.replies.length > 0 && activeAgent && <button className="doc-rewrite" disabled={sending.has(scopeKey)} onClick={() => void send(anchor ? "Rewrite this passage using the feedback in this discussion. Preserve the rest of the document." : "Update this document using the feedback in this discussion.")}>Rewrite with this feedback</button>}
        <div ref={endRef} />
      </div>
      <div id="doc-changes-panel" role="tabpanel" aria-labelledby="doc-changes-tab" className="doc-discussion-scroll" hidden={tab !== "changes"}>
        {version && <>
          <div className="doc-change-heading"><strong>{client.displayName(version.pubkey)}</strong><span>{messageTime(version.created_at)}</span></div>
          {change ? <><div className="doc-change-label">Original</div><pre className="doc-change-before">{change.before || "(insertion)"}</pre><div className="doc-change-label">Updated</div><pre className="doc-change-after">{change.after || "(removed)"}</pre></> : <p className="doc-discussion-notice">{base ? "The text is unchanged in this version." : "The first available version of this document."}</p>}
          <div className="doc-change-actions"><button className="agent-action" onClick={() => onViewVersion(version.id === latest?.id ? undefined : version.id)}>View this version</button>
            {base && <button className="agent-action" disabled={undoing || version.id !== latest?.id} onClick={() => void undo()}>{undoing ? "Undoing…" : "Undo change"}</button>}
          </div>
          {base && version.id !== latest?.id && <p className="doc-discussion-notice">Newer edits exist. Review the latest version before making another change.</p>}
        </>}
        <div className="doc-version-list"><h3>Version history</h3>{[...versions].reverse().map((v, index) => <button className={v.id === version?.id ? "version-row active" : "version-row"} key={v.id} onClick={() => setChangeId(v.id)}><span>{client.displayName(v.pubkey)}{index === 0 ? " · latest" : ""}</span><time>{messageTime(v.created_at)}</time></button>)}</div>
      </div>
      {error && <div className="doc-discussion-error" role="alert">{error}</div>}
      <div className="doc-discussion-compose" hidden={tab !== "conversation"}>
        <div className="doc-discussion-compose-box"><MentionBox client={client} roster={roster} format rows={3} value={draft.text} onChange={text => setDraft({ text })} onMentionPick={(name, pk) => setDraft({ bindings: bindMention(draft.bindings, name, pk) })} onSubmit={() => void send()} placeholder={anchor ? "Discuss this passage, or ask for a change…" : "Ask a question, or ask for a change…"} />
          <div className="doc-discussion-compose-actions"><label>With <select aria-label="Lead agent" value={activeAgent} onChange={event => setDraft({ agent: event.target.value })}><option value="">Leave a note</option>{agents.map(([pk, name]) => <option key={pk} value={pk}>{name}</option>)}</select></label>
            <button className="agent-action" disabled={!draft.text.trim() || sending.has(scopeKey) || (!!focus.threadId && !thread)} onClick={() => void send()}>{sending.has(scopeKey) ? "Sending…" : "Send"}</button>
          </div>
        </div>
        <div className="doc-discussion-hint">{activeAgent ? "@mention others for feedback · Requested edits go into the doc" : "Choose an agent, or leave a note for your collaborators"}</div>
      </div>
    </aside>
  );
}
