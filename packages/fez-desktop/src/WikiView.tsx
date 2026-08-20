import React, { useCallback, useEffect, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  bindMention,
  parseQuery,
  taskKey,
  wikiSlug,
  type DocCommentThread,
  type FezClient,
  type MentionBindings,
  type MentionCandidate,
  type WireEvent,
} from "@fez/client";
import MentionBox from "./MentionBox";
import { blockRenderer, docMarkdownPlugins, pageViewsFor } from "./gui-extensions";
import QueryBlock from "./QueryBlock";
import SlashMenu, { caretPosition, slashAt, type SlashState } from "./SlashMenu";
import type { BlockMenuItem } from "./gui-extensions";

/**
 * Docs — the notion+obsidian surface over kind 40100. Two families in
 * one view: named wiki pages ([[linkable]], community-scoped, versioned)
 * and the per-channel docs that already exist. Same events, same member
 * gating, same signed version chains; agents edit pages with the
 * fez_wiki tools and their versions land here live. A [[link]] to a page
 * nobody has written yet opens a fresh editor — writing IS creating.
 */

type Sel =
  | { kind: "wiki"; slug: string }
  | { kind: "channel"; channelId: string };

/**
 * [[Page Name]] → a wiki: link our renderer intercepts.
 * [[Page Name#Section]] → the same, plus a heading anchor — which only
 * works because rehype-slug gives every heading a stable id.
 */
function linkifyWiki(text: string): string {
  return text.replace(/\[\[([^\]|]+)\]\]/g, (_m, raw: string) => {
    const [page, section] = raw.split("#");
    const label = raw.trim();
    const target = `wiki:${wikiSlug(page)}${section ? `#${wikiSlug(section)}` : ""}`;
    return `[${label}](${target})`;
  });
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
  roster,
  thread,
  onReply,
}: {
  client: FezClient;
  /** Who this doc's channel actually contains — the mention namespace. */
  roster: MentionCandidate[];
  thread: DocCommentThread;
  onReply: (text: string, resolve?: boolean, bindings?: MentionBindings) => void;
}) {
  const [draft, setDraft] = useState("");
  const [replying, setReplying] = useState(false);
  // Who each picked @name means, settled at the moment of picking.
  const [bindings, setBindings] = useState<MentionBindings>(new Map());
  const when = (ts: number) =>
    new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <div className={thread.resolved ? "comment-thread resolved" : "comment-thread"}>
      <div className="comment-head">
        <span className="comment-author">{client.displayName(thread.authorPk)}</span>
        <span className="time">{when(thread.ts)}</span>
        {thread.resolved && <span className="role-tag installed-tag">resolved</span>}
      </div>
      <div className="comment-text">{renderMentions(client, thread.text, thread.mentionPks)}</div>
      {thread.replies.map((reply) => (
        <div key={reply.id} className="comment-reply">
          <span className="comment-author">{client.displayName(reply.authorPk)}</span>
          <span className="time">{when(reply.ts)}</span>
          <div className="comment-text">{renderMentions(client, reply.text, reply.mentionPks)}</div>
        </div>
      ))}
      {replying ? (
        <div className="comment-compose">
          <MentionBox
            client={client}
            format
            roster={roster}
            value={draft}
            autoFocus
            placeholder="reply… @agent to hand it over"
            onChange={setDraft}
            onMentionPick={(name, pubkey) => setBindings((prev) => bindMention(prev, name, pubkey))}
            onSubmit={() => {
              if (!draft.trim()) return;
              onReply(draft, undefined, bindings);
              setDraft("");
              setBindings(new Map());
              setReplying(false);
            }}
            onEscape={() => setReplying(false)}
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

/** Flatten a list item's children to plain text — the task's identity. */
function liText(children: unknown): string {
  const walk = (node: unknown): string => {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(walk).join("");
    const props = (node as { props?: { children?: unknown } }).props;
    return props ? walk(props.children) : "";
  };
  return walk(children).trim();
}

/** GFM puts a disabled <input type=checkbox> first in a task item. */
function hasCheckbox(children: unknown[]): boolean {
  return children.some(
    (child) => (child as { props?: { type?: string } })?.props?.type === "checkbox"
  );
}

/** Drop that input — we render our own control. */
function stripCheckbox(children: React.ReactNode): React.ReactNode {
  if (!Array.isArray(children)) return children;
  return children.filter(
    (child) => (child as { props?: { type?: string } })?.props?.type !== "checkbox"
  ) as React.ReactNode;
}

/**
 * Style an @name only if the comment actually tagged someone by that
 * name. Highlighting every @word made a mention that reached nobody
 * look identical to one that worked — the same silence the send path
 * stopped producing, reappearing on the way back out.
 */
function renderMentions(client: FezClient, text: string, mentionPks: readonly string[]) {
  const tagged = new Set(mentionPks.map((pk) => client.displayName(pk).toLowerCase()));
  return text.split(/(@[\w-]+)/g).map((part, index) =>
    part.startsWith("@") && tagged.has(part.slice(1).toLowerCase()) ? (
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
  const [tasks, setTasks] = useState<Map<string, { done: boolean; byPk: string; ts: number }>>(new Map());
  const [commenting, setCommenting] = useState<string>(); // the block being commented on
  const [askDraft, setAskDraft] = useState("");
  const [ask, setAsk] = useState<string>();
  const [commentDraft, setCommentDraft] = useState("");
  const [commentBindings, setCommentBindings] = useState<MentionBindings>(new Map());
  /**
   * Which lens the open page is under. `undefined` means "nobody has
   * chosen" — so a board-shaped document may open as a board, while a
   * click on ▤ markdown sticks for as long as the page is open.
   */
  const [pageView, setPageView] = useState<string>();
  /** An outstanding request to an agent: which comment we're waiting on. */
  const [asking, setAsking] = useState<{ agent: string; commentId: string; since: number }>();
  const [proposal, setProposal] = useState<{ agent: string; markdown: string }>();
  const [composerError, setComposerError] = useState<string>();
  const [slash, setSlash] = useState<SlashState>();
  const editorRef = React.useRef<HTMLTextAreaElement>(null);

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
    const [nextVersions, nextThreads, nextTasks] = await Promise.all([
      sel.kind === "wiki"
        ? client.wikiVersions(sel.slug)
        : client.docVersions(sel.channelId),
      client.docComments(sel.kind === "wiki" ? { slug: sel.slug } : { channelId: sel.channelId }),
      client.docTasks(sel.kind === "wiki" ? { slug: sel.slug } : { channelId: sel.channelId }),
    ]);
    setVersions(nextVersions);
    setThreads(nextThreads);
    setTasks(nextTasks);
  }, [client, sel]);

  /**
   * Post a comment anchored to a block. @mentions become p tags — the
   * same summon path chat uses, so "@researcher fix this line" reaches
   * the agent with the line as its anchor.
   */
  const comment = async (
    text: string,
    anchor: string,
    parentId?: string,
    resolve?: boolean,
    bindings?: MentionBindings
  ) => {
    if (!sel) return;
    const body = text.trim();
    if (!body && !resolve) return;
    const channelId = sel.kind === "wiki" ? selPage?.channelId ?? homeChannel() : sel.channelId;
    if (!channelId) return;
    // Roster-scoped, like the channel composer: a doc comment that
    // @mentions a name nobody here has must not look like it worked.
    // Names picked from the autocomplete come with their pubkey already.
    const mentionPks = client.resolveMentionsIn(body, channelId, bindings).pubkeys;
    await client.publishDocComment(channelId, body, {
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
    setCommentBindings(new Map());
    await load();
  };

  useEffect(() => {
    setVersions(undefined);
    setViewing(undefined);
    setEditing(false);
    setPageView(undefined);
    void load();
  }, [load]);

  const pages = [...client.wikiDocs().values()];
  const channelDocs = [...client.docsByChannel().entries()]
    .map(([channelId, info]) => ({ channelId, info, ref: client.channelRef(channelId) }))
    .filter((d) => d.ref && d.info.latestContent);
  const communities = [...client.state.workspace.channels.values()];

  /**
   * Pages whose text links here. What makes a pile of notes a wiki: you
   * can see what refers to this without maintaining an index by hand.
   */
  const backlinks =
    sel?.kind === "wiki"
      ? [...client.wikiDocs().values()].filter(
          (page) =>
            client.state.workspace.relay === client.state.workspace.relay &&
            page.slug !== sel.slug &&
            [...page.latestContent.matchAll(/\[\[([^\]|]+)\]\]/g)].some((m) => wikiSlug(m[1]) === sel.slug)
        )
      : [];

  const latest = versions?.at(-1);
  const shown = viewing ? versions?.find((v) => v.id === viewing) : latest;
  const selPage = sel?.kind === "wiki" ? client.wikiDocs().get(`${client.state.workspace.relay}:${sel.slug}`) : undefined;

  // Which lenses recognize what's on screen. `pageView === ""` is an
  // explicit "show me the markdown"; undefined means nobody has chosen,
  // so a document that declares itself a board opens as one.
  const shownViews = shown ? pageViewsFor(shown.content) : { views: [], preferred: undefined };
  const activeView = pageView === undefined ? shownViews.preferred : pageView || undefined;
  const activeViewImpl = shownViews.views.find((view) => view.name === activeView);

  /** Any member-visible channel works as the page's home; prefer where you are. */
  const homeChannel = (): string | undefined => {
    // Prefer where you already are; any channel in the workspace works.
    return client.state.scope?.channelId ?? [...client.state.workspace.channels.keys()][0];
  };

  /**
   * The mention namespace for comments on this page: whoever is on the
   * roster of the channel the comment will be published to. A wiki page
   * belongs to a community, so it borrows the channel it lands in.
   */
  const commentChannelId = sel
    ? sel.kind === "wiki"
      ? selPage?.channelId ?? homeChannel()
      : sel.channelId
    : undefined;
  const commentRoster: MentionCandidate[] = commentChannelId ? client.mentionCandidates(commentChannelId) : [];

  const openWiki = (slug: string, title?: string) => {
    setSel({ kind: "wiki", slug });
    const exists = client.wikiDocs().has(slug);
    if (!exists) {
      // an unwritten page opens as a fresh editor — obsidian's move
      setDraft(`# ${title ?? slug}\n\n`);
      setEditing(true);
    }
  };

  /**
   * The one write path for this document. Everything that produces new
   * markdown — the editor, "keep in page", a board dragging a card —
   * goes through here, so none of them has to know whether this is a
   * wiki page or a channel doc, or what the base version was.
   */
  const publish = async (next: string) => {
    if (!sel) return;
    if (sel.kind === "wiki") {
      const channelId = selPage?.channelId ?? homeChannel();
      if (!channelId) return;
      await client.publishWikiDoc(channelId, selPage?.title ?? sel.slug, next, latest?.id);
    } else {
      await client.publishDoc(sel.channelId, next, latest?.id);
    }
    setViewing(undefined);
    await load();
  };

  const save = async () => {
    if (!sel || !draft.trim()) return;
    setBusy(true);
    try {
      await publish(draft);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  /** Tick/untick: one small signed event, then re-read. */
  const toggleTask = async (itemText: string, done: boolean) => {
    if (!sel) return;
    const channelId = sel.kind === "wiki" ? selPage?.channelId ?? homeChannel() : sel.channelId;
    if (!channelId) return;
    await client.setTaskDone(channelId, itemText, done, sel.kind === "wiki" ? sel.slug : undefined);
    setTasks(
      await client.docTasks(sel.kind === "wiki" ? { slug: sel.slug } : { channelId: sel.channelId })
    );
  };

  /** The open page's community, or every joined one when nothing is open. */

  /** Promote a scratch query into the open page as a real block. */
  const keepAsk = async () => {
    if (!sel || !ask || !latest) return;
    const block = ["```fez:query", ask, "```"].join("\n");
    await publish(`${latest.content.trimEnd()}\n\n${block}\n`);
    setAsk(undefined);
    setAskDraft("");
  };

  /**
   * Which agent to hand a request to: whoever you @mentioned, else the
   * first agent in this community. Named explicitly in the UI either
   * way — "an agent did something" is not a thing anyone should have to
   * accept on faith.
   */
  const pickAgent = (text: string): string | undefined => {
    const mentioned = /@([\w-]+)/.exec(text)?.[1];
    if (mentioned && client.pkByName(mentioned)) return mentioned;
    // agents(): pubkey → persona name
    for (const [, name] of client.agents()) {
      if (name && client.pkByName(name)) return name;
    }
    return undefined;
  };

  /**
   * Send. A sentence the query vocabulary fully understands is answered
   * on the spot; anything it does not is a request for an agent.
   *
   * The split is on `unknown`, not on a mode switch, because the person
   * typing does not know which kind of thing they are typing — and
   * should not have to. The cost of guessing wrong is a query that
   * quietly ignores half your words, which is exactly what the parser
   * reports instead of hiding.
   */
  const submitComposer = async () => {
    const text = askDraft.trim();
    if (!text || asking) return;
    setComposerError(undefined);
    setProposal(undefined);

    const parsed = parseQuery(text);
    if (parsed.unknown.length === 0) {
      setAsk(text);
      return;
    }

    // …otherwise it is a request. Agents already treat a doc comment as
    // work, so this is that, with the reply rendered here instead of
    // buried in a thread.
    setAsk(undefined);
    if (!sel) {
      setComposerError(`open a page first — "${parsed.unknown.join(", ")}" isn't query vocabulary, so this needs an agent, and an agent needs a page to work on.`);
      return;
    }
    const agent = pickAgent(text);
    if (!agent) {
      setComposerError("no agents here yet — invite one, or phrase it in query vocabulary (open tasks, by page).");
      return;
    }
    const channelId = sel.kind === "wiki" ? selPage?.channelId ?? homeChannel() : sel.channelId;
    if (!channelId) return;

    const request = [
      `@${agent} ${text}`,
      "",
      "Reply with the markdown to insert into this page, wrapped in a four-backtick fence so any three-backtick blocks inside it survive:",
      "",
      "````markdown",
      "...your markdown...",
      "````",
      "",
      `Live blocks are available: \`\`\`fez:query\`\`\` (an English sentence from the query vocabulary), \`\`\`fez:board\`\`\`, \`\`\`fez:live\`\`\`. Plain GFM (tables, task lists) is fine too. Do NOT edit the page yourself — the person asking will decide whether to add this.`,
    ].join("\n");

    const pk = client.pkByName(agent);
    const since = Math.floor(Date.now() / 1000) - 5;
    try {
      await client.publishDocComment(channelId, request, {
        anchor: selPage?.title ?? (sel.kind === "wiki" ? sel.slug : client.channelRef(sel.channelId)?.name ?? "page"),
        slug: sel.kind === "wiki" ? sel.slug : undefined,
        mentionPks: pk ? [pk] : [],
      });
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : String(err));
      return;
    }
    setAskDraft("");
    setAsking({ agent, commentId: "", since });
  };

  /** Pull the proposed markdown out of the agent's reply. */
  const extractMarkdown = (reply: string): string | undefined => {
    const fenced = /````[a-z]*\s*\n([\s\S]*?)````/i.exec(reply);
    if (fenced) return fenced[1].trimEnd();
    // No fence: only treat the reply as a block if it actually looks
    // like markup rather than an agent explaining why it can't help.
    const trimmed = reply.trim();
    return /^(#|\||-\s|\*\s|```)/m.test(trimmed) ? trimmed : undefined;
  };

  // Watch for the agent's answer and bring it back to the composer.
  useEffect(() => {
    if (!asking || !sel) return;
    let live = true;
    const poll = async () => {
      const threads = await client.docComments(
        sel.kind === "wiki" ? { slug: sel.slug } : { channelId: sel.channelId }
      );
      const agentPk = client.pkByName(asking.agent);
      for (const thread of threads) {
        for (const reply of [...(thread.replies ?? []), thread]) {
          const event = reply as { pubkey?: string; created_at?: number; content?: string };
          if (!event.pubkey || event.pubkey !== agentPk) continue;
          if ((event.created_at ?? 0) < asking.since) continue;
          const markdown = extractMarkdown(event.content ?? "");
          if (!live) return;
          if (markdown) {
            setProposal({ agent: asking.agent, markdown });
          } else {
            setComposerError(`@${asking.agent} replied without markdown to insert — see the comment thread on this page.`);
          }
          setAsking(undefined);
          return;
        }
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    // Agents can take a while, but a spinner with no end is a lie.
    const giveUp = setTimeout(() => {
      if (!live) return;
      setAsking(undefined);
      setComposerError(`@${asking.agent} hasn't answered in 3 minutes — the request is still in this page's comments.`);
    }, 180_000);
    return () => {
      live = false;
      clearInterval(timer);
      clearTimeout(giveUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asking?.since, asking?.agent, sel]);

  const acceptProposal = async () => {
    if (!proposal || !sel || !latest) return;
    setBusy(true);
    try {
      await publish(`${latest.content.trimEnd()}\n\n${proposal.markdown}\n`);
      setProposal(undefined);
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** Track whether the caret is sitting in a `/command`. */
  const updateSlash = (textarea: HTMLTextAreaElement) => {
    const found = slashAt(textarea.value, textarea.selectionStart);
    if (!found) {
      setSlash(undefined);
      return;
    }
    const { top, left } = caretPosition(textarea, found.start);
    setSlash({ ...found, top: top + 22, left });
  };

  /**
   * Replace the typed `/query` with the block's markdown and put the
   * caret where the template says. The inserted text is ordinary
   * markdown — nothing about it remembers that a menu was involved.
   */
  const insertBlock = (item: BlockMenuItem) => {
    const textarea = editorRef.current;
    if (!textarea || !slash) return;
    const end = slash.start + 1 + slash.query.length;
    const caretMark = item.template.indexOf("$0");
    const body = item.template.replace("$0", "");
    // Templates are blocks: make sure one starts on its own line.
    const before = draft.slice(0, slash.start);
    const needsBreak = before.length > 0 && !before.endsWith("\n") && item.template.includes("\n");
    const prefix = needsBreak ? "\n" : "";
    const next = before + prefix + body + draft.slice(end);
    setDraft(next);
    setSlash(undefined);
    const caret = slash.start + prefix.length + (caretMark >= 0 ? caretMark : body.length);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  };

  const create = () => {
    const title = newTitle?.trim();
    setNewTitle(undefined);
    if (!title) return;
    openWiki(wikiSlug(title), title);
  };

  const md = (text: string) => (
    <ReactMarkdown
      // extensions extend parsing (callouts, math…) through the seam
      remarkPlugins={[remarkGfm, ...(docMarkdownPlugins() as [])]}
      // Stable heading ids (rehype-slug) + a quiet ¶ permalink on hover
      // (rehype-autolink-headings). Ids are what make [[Page#Section]]
      // resolvable and what a table of contents would link to.
      rehypePlugins={[
        rehypeSlug,
        [
          rehypeAutolinkHeadings,
          { behavior: "append", // hast wants className as an ARRAY — a bare string silently produced
          // an anchor with no class, so every ¶ showed instead of hiding.
          properties: { className: ["heading-anchor"], ariaHidden: true, tabIndex: -1 }, content: { type: "text", value: "¶" } },
        ],
      ]}
      // react-markdown's default sanitizer strips unknown schemes — our
      // wiki: links died there before any click handler ran.
      urlTransform={(url) => (url.startsWith("wiki:") ? url : defaultUrlTransform(url))}
      components={{
        /**
         * GFM already renders `- [ ] thing` as a checkbox; react-markdown
         * ships it disabled. We make it real: the tick is a signed event
         * keyed to the item's TEXT (client.setTaskDone), never a rewrite
         * of the page — so two people ticking different boxes don't
         * collide, and the markdown still reads correctly in any client.
         */
        input: ({ type, checked, ...rest }) => {
          if (type !== "checkbox") return <input type={type} {...rest} />;
          return <input type="checkbox" checked={!!checked} readOnly {...rest} />;
        },
        li: ({ children, className, ...rest }) => {
          const text = liText(children);
          const key = text ? taskKey(text) : undefined;
          const state = key ? tasks.get(key) : undefined;
          const isTask = /task-list-item/.test(className ?? "") || (Array.isArray(children) && hasCheckbox(children));
          if (!isTask || !key || !sel) return <li className={className} {...rest}>{children}</li>;
          const done = state?.done ?? false;
          return (
            <li className={`task-item${done ? " done" : ""}`}>
              <button
                className="task-box"
                title={state ? `${done ? "done" : "open"} · ${client.displayName(state.byPk)}` : "not started"}
                onClick={() => void toggleTask(text, !done)}
              >
                {done ? "✓" : ""}
              </button>
              <span className="task-text">{stripCheckbox(children)}</span>
            </li>
          );
        },
        // A fenced block whose language an extension owns renders as that
        // extension's component (```fez:live …```), everything else stays code.
        code: ({ className, children, ...rest }) => {
          const lang = /language-([\w:.-]+)/.exec(className ?? "")?.[1];
          // fez:query ships with the app rather than as an extension —
          // it is the doc surface's own vocabulary, like [[links]].
          if (lang === "fez:query" && sel) {
            return <QueryBlock client={client} source={String(children ?? "")} />;
          }
          const render = lang ? blockRenderer(lang) : undefined;
          if (render && sel) {
            const body = String(children ?? "").replace(/\n$/, "");
            const infoLine = text.split("\n").find((l) => l.trim().startsWith("```" + lang)) ?? "```" + lang;
            return (
              <>
                {render({
                  info: infoLine.trim().slice(3 + lang!.length).trim(),
                  body,
                  raw: `${infoLine}\n${body}\n\`\`\``,
                  channelId: sel.kind === "wiki" ? selPage?.channelId ?? homeChannel() ?? "" : sel.channelId,
                  slug: sel.kind === "wiki" ? sel.slug : undefined,
                })}
              </>
            );
          }
          return <code className={className} {...rest}>{children}</code>;
        },
        a: ({ href, children, className }) => {
          if (href?.startsWith("wiki:")) {
            const [slug, section] = href.slice(5).split("#");
            const exists = client.wikiDocs().has(slug);
            return (
              <a
                href={href}
                className={exists ? "wiki-link" : "wiki-link missing"}
                onClick={(e) => {
                  e.preventDefault();
                  openWiki(slug, String(children));
                  // the page renders after this tick — scroll once it exists
                  if (section) {
                    setTimeout(() => document.getElementById(section)?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
                  }
                }}
              >
                {children}
              </a>
            );
          }
          // Keep className: rehype-autolink-headings marks its ¶ links
          // with one, and dropping it left every anchor permanently
          // visible instead of hover-only.
          return (
            <a
              href={href}
              className={className}
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
            .sort((a, b) => a.title.localeCompare(b.title));
          const communityChannelDocs = channelDocs;
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
                    if (e.key === "Enter") create();
                    if (e.key === "Escape") setNewTitle(undefined);
                  }}
                />
              )}
              {communityPages.map((page) => (
                <button
                  key={page.slug}
                  className={
                    sel?.kind === "wiki" && client.state.workspace.relay === client.state.workspace.relay && sel.slug === page.slug
                      ? "channel active"
                      : "channel"
                  }
                  onClick={() => openWiki(page.slug)}
                >
                  ▤ {page.title}
                </button>
              ))}
              {communityChannelDocs.map(({ channelId, ref }) => (
                <button
                  key={channelId}
                  className={sel?.kind === "channel" && sel.channelId === channelId ? "channel active" : "channel"}
                  onClick={() => setSel({ kind: "channel", channelId })}
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
        {sel && (
          <header className="topbar">
            <div className="topbar-row wiki-page-head">
              <span className="wiki-title">
                {sel.kind === "wiki"
                  ? `▤ ${selPage?.title ?? sel.slug}`
                  : `# ${client.channelRef(sel.channelId)?.name ?? ""} doc`}
              </span>
              {/**
               * Lenses an extension offers for THIS document (a board, a
               * calendar…). Markdown is always here and always one click
               * away: the document is the truth, a view is a way of
               * looking at it — and of editing it, since a view writes
               * back through the same publish path the editor uses.
               */}
              {!editing && shownViews.views.length > 0 && (
                <div className="page-views">
                  <button
                    className={activeView ? "page-view" : "page-view active"}
                    onClick={() => setPageView("")}
                    title="the document as written"
                  >
                    ▤ markdown
                  </button>
                  {shownViews.views.map((view) => (
                    <button
                      key={view.name}
                      className={activeView === view.name ? "page-view active" : "page-view"}
                      onClick={() => setPageView(view.name)}
                    >
                      {view.name}
                    </button>
                  ))}
                </div>
              )}
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
            </div>
          </header>
        )}
        <div className="wiki-scroll">
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
            {editing ? (
              <div className="doc-editor wiki-editor">
                <div className="doc-textarea-wrap">
                  <textarea
                    ref={editorRef}
                    className="doc-textarea"
                    value={draft}
                    autoFocus
                    spellCheck={false}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      updateSlash(e.target);
                    }}
                    onKeyUp={(e) => updateSlash(e.currentTarget)}
                    onClick={(e) => updateSlash(e.currentTarget)}
                    onBlur={() => setSlash(undefined)}
                    placeholder="# title — type / for blocks, [[their name]] to link a page"
                  />
                  {slash && <SlashMenu state={slash} onPick={insertBlock} onClose={() => setSlash(undefined)} />}
                </div>
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
                  {activeViewImpl ? (
                    <div className="page-view-body">
                      {activeViewImpl.render({
                        content: shown.content,
                        save: publish,
                        comment: async (text, anchor, mentions) => {
                          if (!sel) return;
                          const channelId =
                            sel.kind === "wiki" ? selPage?.channelId ?? homeChannel() : sel.channelId;
                          if (!channelId) return;
                          await client.publishDocComment(channelId, text, {
                            anchor,
                            slug: sel.kind === "wiki" ? sel.slug : undefined,
                            mentionPks: mentions
                              .map((name) => client.pkByName(name))
                              .filter((pk): pk is string => !!pk),
                          });
                          await load();
                        },
                        title: sel.kind === "wiki" ? selPage?.title ?? sel.slug : client.channelRef(sel.channelId)?.name ?? "",
                        channelId: sel.kind === "wiki" ? selPage?.channelId ?? homeChannel() ?? "" : sel.channelId,
                        slug: sel.kind === "wiki" ? sel.slug : undefined,
                        editable: shown.id === latest?.id,
                      })}
                    </div>
                  ) : (
                  <div className="md doc-body wiki-body">
                    {blocksOf(shown.content).map((block, index) => {
                      const anchored = threads.filter((t) => t.anchor && block.includes(t.anchor));
                      const open = anchored.filter((t) => !t.resolved);
                      return (
                        <div key={index} className={commenting === block ? "doc-line commenting" : "doc-line"}>
                          <div className="doc-line-body">{md(block)}</div>
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
                                  roster={commentRoster}
                                  onReply={(text, resolve, bindings) =>
                                    void comment(text, block, thread.id, resolve, bindings)
                                  }
                                />
                              ))}
                              {commenting === block && (
                                <div className="comment-compose">
                                  <MentionBox
                                    client={client}
                                    format
                                    roster={commentRoster}
                                    value={commentDraft}
                                    autoFocus
                                    placeholder="comment… @agent to give them this line as work"
                                    onChange={setCommentDraft}
                                    onMentionPick={(name, pubkey) =>
                                      setCommentBindings((prev) => bindMention(prev, name, pubkey))
                                    }
                                    onSubmit={() => void comment(commentDraft, block, undefined, undefined, commentBindings)}
                                    onEscape={() => setCommenting(undefined)}
                                  />
                                  {/* The way out. There wasn't one: the
                                      only exits were Escape (needs focus
                                      in the textarea, and the mention
                                      popup eats the first press) and
                                      re-clicking the ✎, which is
                                      opacity:0 unless you happen to be
                                      hovering that exact line. A box you
                                      can open and not close is a trap. */}
                                  <div className="comment-compose-actions">
                                    <button
                                      className="agent-action"
                                      disabled={!commentDraft.trim()}
                                      onClick={() => void comment(commentDraft, block, undefined, undefined, commentBindings)}
                                    >
                                      comment
                                    </button>
                                    <button
                                      className="mini"
                                      onClick={() => {
                                        setCommenting(undefined);
                                        setCommentDraft("");
                                      }}
                                    >
                                      cancel
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  )}
                </>
              )
            )}
            {!editing && sel.kind === "wiki" && backlinks.length > 0 && (
              <div className="wiki-backlinks">
                <div className="manage-section">linked from</div>
                {backlinks.map((page) => (
                  <button key={page.slug} className="version-row" onClick={() => openWiki(page.slug)}>
                    ▤ {page.title}
                  </button>
                ))}
              </div>
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
        </div>

        {/**
         * The composer. It sits at the bottom because that is where a
         * composer sits everywhere else in this app, and because the
         * previous version — a bar floating above the document — was a
         * control nobody could place: not part of the page, not part of
         * chat, just hovering.
         *
         * Two speeds, and which one you get depends on what you typed
         * rather than on which control you picked. A sentence the query
         * vocabulary fully understands answers instantly, from the relay,
         * with no agent and no cost. Anything else is a request, and goes
         * to an agent as a doc comment — the same summons a comment on any
         * line already is, so nothing new was invented to carry it.
         */}
        <div className="doc-composer">
          {ask && (
            <div className="doc-composer-result">
              <QueryBlock client={client} source={ask} />
              <div className="doc-composer-actions">
                {sel && latest && (
                  <button className="mini" title="append this query to the open page" onClick={() => void keepAsk()}>
                    keep in page
                  </button>
                )}
                <button className="mini" onClick={() => { setAsk(undefined); setAskDraft(""); }}>dismiss</button>
              </div>
            </div>
          )}

          {asking && (
            <div className="doc-composer-pending">
              <span className="doc-composer-spin">⟳</span> @{asking.agent} is working on it…
              <button className="mini" onClick={() => setAsking(undefined)}>stop waiting</button>
            </div>
          )}

          {/**
           * A proposal is shown AS MARKDOWN and lands in the page only
           * when you say so. An agent editing the document you are
           * reading, without showing you first, is the wrong feeling
           * entirely — and it is the one thing that would make people
           * stop trusting this surface.
           */}
          {proposal && (
            <div className="doc-composer-proposal">
              <div className="doc-composer-from">@{proposal.agent} suggests</div>
              <pre className="doc-composer-md">{proposal.markdown}</pre>
              <div className="doc-composer-actions">
                <button className="agent-action" disabled={busy} onClick={() => void acceptProposal()}>
                  add to page
                </button>
                <button className="mini" onClick={() => setProposal(undefined)}>discard</button>
              </div>
            </div>
          )}

          {composerError && <div className="doc-composer-error">{composerError}</div>}

          <div className="doc-composer-row">
            <textarea
              className="doc-composer-input"
              value={askDraft}
              rows={1}
              placeholder={
                sel
                  ? "ask about this page, or describe a block to add — open tasks by page · a table of last week's spend"
                  : "ask across your docs — unfinished tasks by page · approvals waiting on me"
              }
              onChange={(e) => setAskDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submitComposer();
                }
                if (e.key === "Escape") {
                  setAsk(undefined);
                  setProposal(undefined);
                  setComposerError(undefined);
                  setAskDraft("");
                }
              }}
            />
            <button
              className="composer-send"
              disabled={!askDraft.trim() || !!asking}
              title="enter to send"
              onClick={() => void submitComposer()}
            >
              ↵
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
