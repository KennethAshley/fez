import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { wikiSlug, type FezClient, type WireEvent } from "@fez/client";

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

export default function WikiView({ client }: { client: FezClient }) {
  const [sel, setSel] = useState<Sel>();
  const [versions, setVersions] = useState<WireEvent[]>();
  const [viewing, setViewing] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [newTitle, setNewTitle] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [, bump] = useState(0);

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
    setVersions(
      sel.kind === "wiki"
        ? await client.wikiVersions(sel.communityId, sel.slug)
        : await client.docVersions(sel.channelId, sel.communityId)
    );
  }, [client, sel]);

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
                  </div>
                  <div className="md doc-body wiki-body">{md(shown.content, sel.communityId)}</div>
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
