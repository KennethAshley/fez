import { useCallback, useEffect, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { wikiSlug, type DocCommentThread, type FezClient, type WireEvent } from "@fez/client";

/**
 * Docs — the notion+obsidian surface over kind 40100. Two families in
 * one view: named wiki pages ([[linkable]], community-scoped, versioned)
 * and the per-channel docs that already exist. Same events, same member
 * gating, same signed version chains; agents edit pages with the
 * fez_wiki tools and their versions land here live. A [[link]] to a page
 * nobody has written yet opens a fresh editor — writing IS creating.
 */

type Sel =
  | { kind: "wiki"; communityId: string; slug: string }
  | { kind: "channel"; channelId: string; communityId: string };

/** [[Page Name]] → markdown links on a wiki: scheme our renderer intercepts. */
function linkifyWiki(text: string): string {
  return text.replace(/\[\[([^\]|]+)\]\]/g, (_m, name: string) => `[${name.trim()}](wiki:${wikiSlug(name)})`);
}

/**
 * Split a doc into commentable blocks — paragraphs, list items,
 * headings, fenced code. Each block renders as markdown on its own so a
 * comment can anchor to it by TEXT (surviving edits elsewhere).
 */
function blocksOf(markdown: string): string[] {
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let fence: string[] | undefined;
  const flush = () => {
    if (paragraph.length) blocks.push(paragraph.join("\n"));
    paragraph = [];
  };
  for (const line of markdown.split("\n")) {
    if (line.trim().startsWith("```")) {
      if (fence) {
        fence.push(line);
        blocks.push(fence.join("\n"));
        fence = undefined;
      } else {
        flush();
        fence = [line];
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // headings and list items stand alone so each is separately commentable
    if (/^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s)/.test(line.trim())) {
      flush();
      blocks.push(line);
      continue;
    }
    paragraph.push(line);
  }
  flush();
  if (fence) blocks.push(fence.join("\n"));
  return blocks;
}

/** One anchored thread: the note, its replies, resolve, and a reply box. */
function CommentThread({
  client,
  thread,
  onReply,
}: {
  client: FezClient;
  thread: DocCommentThread;
  onReply: (text: string, resolve?: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const [replying, setReplying] = useState(false);
  const when = (ts: number) =>
    new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <div className={thread.resolved ? "comment-thread resolved" : "comment-thread"}>
      <div className="comment-head">
        <span className="comment-author">{client.displayName(thread.authorPk)}</span>
        <span className="time">{when(thread.ts)}</span>
        {thread.resolved && <span className="role-tag installed-tag">resolved</span>}
      </div>
      <div className="comment-text">{renderMentions(thread.text)}</div>
      {thread.replies.map((reply) => (
        <div key={reply.id} className="comment-reply">
          <span className="comment-author">{client.displayName(reply.authorPk)}</span>
          <span className="time">{when(reply.ts)}</span>
          <div className="comment-text">{renderMentions(reply.text)}</div>
        </div>
      ))}
      {replying ? (
        <div className="comment-compose">
          <textarea
            className="manage-input comment-input"
            value={draft}
            autoFocus
            rows={2}
            placeholder="reply… @agent to hand it over"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (draft.trim()) {
                  onReply(draft);
                  setDraft("");
                  setReplying(false);
                }
              }
              if (e.key === "Escape") setReplying(false);
            }}
          />
        </div>
      ) : (
        <div className="comment-actions">
          <button className="mini" onClick={() => setReplying(true)}>reply</button>
          {!thread.resolved && (
            <button className="mini" onClick={() => onReply("", true)}>resolve</button>
          )}
        </div>
      )}
    </div>
  );
}

function renderMentions(text: string) {
  return text.split(/(@[\w-]+)/g).map((part, index) =>
    part.startsWith("@") ? (
      <span key={index} className="mention">{part}</span>
    ) : (
      <span key={index}>{part}</span>
    )
  );
}

export default function WikiView({ client }: { client: FezClient }) {
  const [sel, setSel] = useState<Sel>();
  const [versions, setVersions] = useState<WireEvent[]>();
  const [viewing, setViewing] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [newTitle, setNewTitle] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [, bump] = useState(0);
  const [threads, setThreads] = useState<DocCommentThread[]>([]);
  const [commenting, setCommenting] = useState<string>(); // the block being commented on
  const [commentDraft, setCommentDraft] = useState("");

  // live: agent/other-client versions repaint the list and the open page
  useEffect(() => {
    return client.on("docChanged", () => {
      bump((n) => n + 1);
      void load();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, sel]);

  const load = useCallback(async () => {
    if (!sel) return;
    const [nextVersions, nextThreads] = await Promise.all([
      sel.kind === "wiki"
        ? client.wikiVersions(sel.communityId, sel.slug)
        : client.docVersions(sel.channelId, sel.communityId),
      client.docComments(sel.communityId, sel.kind === "wiki" ? { slug: sel.slug } : { channelId: sel.channelId }),
    ]);
    setVersions(nextVersions);
    setThreads(nextThreads);
  }, [client, sel]);

  /**
   * Post a comment anchored to a block. @mentions become p tags — the
   * same summon path chat uses, so "@researcher fix this line" reaches
   * the agent with the line as its anchor.
   */
  const comment = async (text: string, anchor: string, parentId?: string, resolve?: boolean) => {
    if (!sel) return;
    const body = text.trim();
    if (!body && !resolve) return;
    const channelId = sel.kind === "wiki" ? selPage?.channelId ?? homeChannel(sel.communityId) : sel.channelId;
    if (!channelId) return;
    const mentionPks = [...body.matchAll(/@([\w-]+)/g)]
      .map((match) => client.pkByName(match[1]))
      .filter((pk): pk is string => !!pk);
    await client.publishDocComment(channelId, sel.communityId, body, {
      anchor,
      slug: sel.kind === "wiki" ? sel.slug : undefined,
      parentId,
      mentionPks,
      resolve,
    });
    // No channel message: agents subscribe to 40101 directly, so a doc
    // comment stays in the document — the agent answers in this thread.
    setCommenting(undefined);
    setCommentDraft("");
    await load();
  };

  useEffect(() => {
    setVersions(undefined);
    setViewing(undefined);
    setEditing(false);
    void load();
  }, [load]);

  const pages = [...client.wikiDocs().values()];
  const channelDocs = [...client.docsByChannel().entries()]
    .map(([channelId, info]) => ({ channelId, info, ref: client.channelRef(channelId) }))
    .filter((d) => d.ref && d.info.latestContent);
  const communities = [...client.state.communities.values()].filter((c) => client.state.joined.has(c.id));

  const latest = versions?.at(-1);
  const shown = viewing ? versions?.find((v) => v.id === viewing) : latest;
  const selPage = sel?.kind === "wiki" ? client.wikiDocs().get(`${sel.communityId}:${sel.slug}`) : undefined;

  /** Any member-visible channel works as the page's home; prefer where you are. */
  const homeChannel = (communityId: string): string | undefined => {
    const scope = client.state.scope;
    if (scope && scope.communityId === communityId) return scope.channelId;
    return [...(client.state.community(communityId)?.channels.keys() ?? [])][0];
  };

  const openWiki = (communityId: string, slug: string, title?: string) => {
    setSel({ kind: "wiki", communityId, slug });
    const exists = client.wikiDocs().has(`${communityId}:${slug}`);
    if (!exists) {
      // an unwritten page opens as a fresh editor — obsidian's move
      setDraft(`# ${title ?? slug}\n\n`);
      setEditing(true);
    }
  };

  const save = async () => {
    if (!sel || !draft.trim()) return;
    setBusy(true);
    try {
      if (sel.kind === "wiki") {
        const channelId = selPage?.channelId ?? homeChannel(sel.communityId);
        if (!channelId) return;
        await client.publishWikiDoc(channelId, sel.communityId, selPage?.title ?? sel.slug, draft, latest?.id);
      } else {
        await client.publishDoc(sel.channelId, sel.communityId, draft, latest?.id);
      }
      setEditing(false);
      setViewing(undefined);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const create = (communityId: string) => {
    const title = newTitle?.trim();
    setNewTitle(undefined);
    if (!title) return;
    openWiki(communityId, wikiSlug(title), title);
  };

  const md = (text: string, communityId: string) => (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      // react-markdown's default sanitizer strips unknown schemes — our
      // wiki: links died there before any click handler ran.
      urlTransform={(url) => (url.startsWith("wiki:") ? url : defaultUrlTransform(url))}
      components={{
        a: ({ href, children }) => {
          if (href?.startsWith("wiki:")) {
            const slug = href.slice(5);
            const exists = client.wikiDocs().has(`${communityId}:${slug}`);
            return (
              <a
                href={href}
                className={exists ? "wiki-link" : "wiki-link missing"}
                onClick={(e) => {
                  e.preventDefault();
                  openWiki(communityId, slug, String(children));
                }}
              >
                {children}
              </a>
            );
          }
          return (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href) void openUrl(href);
              }}
            >
              {children}
            </a>
          );
        },
      }}
    >
      {linkifyWiki(text)}
    </ReactMarkdown>
  );

  return (
    <main className="main wiki-main">
      <aside className="wiki-list">
        <div className="wiki-list-head">docs</div>
        {communities.map((community) => {
          const communityPages = pages
            .filter((p) => p.communityId === community.id)
            .sort((a, b) => a.title.localeCompare(b.title));
          const communityChannelDocs = channelDocs.filter((d) => d.ref!.communityId === community.id);
          return (
            <div key={community.id} className="wiki-group">
              <div className="wiki-group-name">
                {community.name}
                <button
                  className="community-add"
                  title="new page"
                  onClick={() => setNewTitle(newTitle === undefined ? "" : undefined)}
                >
                  +
                </button>
              </div>
              {newTitle !== undefined && (
                <input
                  className="manage-input wiki-new"
                  value={newTitle}
                  autoFocus
                  placeholder="page title…"
                  onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") create(community.id);
                    if (e.key === "Escape") setNewTitle(undefined);
                  }}
                />
              )}
              {communityPages.map((page) => (
                <button
                  key={page.slug}
                  className={
                    sel?.kind === "wiki" && sel.communityId === page.communityId && sel.slug === page.slug
                      ? "channel active"
                      : "channel"
                  }
                  onClick={() => openWiki(page.communityId, page.slug)}
                >
                  ▤ {page.title}
                </button>
              ))}
              {communityChannelDocs.map(({ channelId, ref }) => (
                <button
                  key={channelId}
                  className={sel?.kind === "channel" && sel.channelId === channelId ? "channel active" : "channel"}
                  onClick={() => setSel({ kind: "channel", channelId, communityId: ref!.communityId })}
                >
                  <span className="hash">#</span> {ref!.name} doc
                </button>
              ))}
              {communityPages.length === 0 && communityChannelDocs.length === 0 && (
                <div className="wiki-empty-group">no docs yet</div>
              )}
            </div>
          );
        })}
      </aside>

      <section className="wiki-page">
        {!sel && (
          <div className="channel-intro">
            <div className="intro-hash">▤</div>
            <h2>docs</h2>
            <p>
              Living pages your whole community — agents included — can read, edit, and version. Write [[page name]]
              anywhere in a doc to link pages together; a link to an unwritten page starts it. Channel docs live here
              too. Agents use fez_wiki_read / fez_wiki_write on the same pages.
            </p>
          </div>
        )}
        {sel && (
          <>
            <header className="wiki-page-head">
              <span className="wiki-title">
                {sel.kind === "wiki"
                  ? `▤ ${selPage?.title ?? sel.slug}`
                  : `# ${client.channelRef(sel.channelId)?.name ?? ""} doc`}
              </span>
              {!editing && (
                <button
                  className="agent-action"
                  onClick={() => {
                    setDraft(latest?.content ?? "");
                    setEditing(true);
                  }}
                >
                  ✎ {latest ? "edit" : "write"}
                </button>
              )}
            </header>
            {editing ? (
              <div className="doc-editor wiki-editor">
                <textarea
                  className="doc-textarea"
                  value={draft}
                  autoFocus
                  spellCheck={false}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="# title\n\nlink other pages with [[their name]]…"
                />
                <div className="agent-actions">
                  <button className="agent-action" disabled={busy || !draft.trim()} onClick={() => void save()}>
                    {busy ? "publishing…" : latest ? "publish new version" : "publish"}
                  </button>
                  <button className="agent-action" onClick={() => setEditing(false)}>cancel</button>
                </div>
              </div>
            ) : (
              shown && (
                <>
                  <div className="doc-meta">
                    {client.displayName(shown.pubkey)} ·{" "}
                    {new Date(shown.created_at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    {shown.id !== latest?.id && <span className="doc-old"> · old version</span>}
                    {(versions?.length ?? 0) > 1 && ` · ${versions!.length} versions`}
                    {threads.length > 0 && ` · ${threads.filter((t) => !t.resolved).length} open comment${threads.filter((t) => !t.resolved).length === 1 ? "" : "s"}`}
                  </div>
                  <div className="md doc-body wiki-body">
                    {blocksOf(shown.content).map((block, index) => {
                      const anchored = threads.filter((t) => t.anchor && block.includes(t.anchor));
                      const open = anchored.filter((t) => !t.resolved);
                      return (
                        <div key={index} className={commenting === block ? "doc-line commenting" : "doc-line"}>
                          <div className="doc-line-body">{md(block, sel.communityId)}</div>
                          <button
                            className={open.length ? "line-comment has" : "line-comment"}
                            title={open.length ? `${open.length} comment${open.length === 1 ? "" : "s"}` : "comment on this line — @mention an agent to give it work here"}
                            onClick={() => {
                              setCommenting(commenting === block ? undefined : block);
                              setCommentDraft("");
                            }}
                          >
                            ✎{open.length > 0 && <span className="line-comment-count">{open.length}</span>}
                          </button>
                          {(commenting === block || anchored.length > 0) && (
                            <div className="line-threads">
                              {anchored.map((thread) => (
                                <CommentThread
                                  key={thread.id}
                                  client={client}
                                  thread={thread}
                                  onReply={(text, resolve) => void comment(text, block, thread.id, resolve)}
                                />
                              ))}
                              {commenting === block && (
                                <div className="comment-compose">
                                  <textarea
                                    className="manage-input comment-input"
                                    value={commentDraft}
                                    autoFocus
                                    rows={2}
                                    placeholder="comment… @agent to give them this line as work"
                                    onChange={(e) => setCommentDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" && !e.shiftKey) {
                                        e.preventDefault();
                                        void comment(commentDraft, block);
                                      }
                                      if (e.key === "Escape") setCommenting(undefined);
                                    }}
                                  />
                                  <button className="agent-action" disabled={!commentDraft.trim()} onClick={() => void comment(commentDraft, block)}>
                                    comment
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )
            )}
            {!editing && (versions?.length ?? 0) > 1 && (
              <div className="wiki-versions">
                {[...versions!].reverse().map((version) => (
                  <button
                    key={version.id}
                    className={version.id === (shown?.id ?? "") ? "version-row active" : "version-row"}
                    onClick={() => setViewing(version.id === latest?.id ? undefined : version.id)}
                  >
                    {client.displayName(version.pubkey)} ·{" "}
                    {new Date(version.created_at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
