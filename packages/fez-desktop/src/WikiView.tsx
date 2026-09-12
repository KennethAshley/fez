import React, { useCallback, useEffect, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  createDocAnchor,
  locateDocAnchor,
  taskKey,
  wikiSlug,
  type DocCommentThread,
  type FezClient,
  type WireEvent,
} from "@fezchat/client";
import DocConversation, { type DocFocus } from "./DocConversation";
import { docBlocks, documentChange, docSelectionRange } from "./doc-workspace";
import { FormatBar, markdownFormatOps } from "./format-bar";
import { blockRenderer, docMarkdownPlugins, pageViewsFor } from "./gui-extensions";
import { MountPoint } from "./MountPoint";
import type { MountRender } from "./mount-result";
import QueryBlock from "./QueryBlock";
import SlashMenu, { caretPosition, slashAt, type SlashState } from "./SlashMenu";
import { AnimatedSprite } from "@fezchat/ui";
import { SPRITES } from "@fezchat/ui";
import type { BlockMenuItem } from "./gui-extensions";

/**
 * Docs — the notion+obsidian surface over kind 40100. Two families in
 * one view: named wiki pages ([[linkable]], community-scoped, versioned)
 * and the per-channel docs that already exist. Same events, same member
 * gating, same signed version chains; agents edit pages with the
 * fez_wiki tools and their versions land here live. A [[link]] to a page
 * nobody has written yet opens a fresh editor — writing IS creating.
 */

export type WikiSelection =
  | { kind: "wiki"; slug: string; title?: string }
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

export default function WikiView({ client, initialSelection }: { client: FezClient; initialSelection?: WikiSelection }) {
  const [sel, setSel] = useState<WikiSelection | undefined>(initialSelection);
  const [versionState, setVersions] = useState<WireEvent[]>();
  const [loadedPage, setLoadedPage] = useState("");
  const [viewing, setViewing] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [newTitle, setNewTitle] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [, bump] = useState(0);
  const [threadState, setThreads] = useState<DocCommentThread[]>([]);
  const [tasks, setTasks] = useState<Map<string, { done: boolean; byPk: string; ts: number }>>(new Map());
  const [focusByPage, setFocusByPage] = useState<Record<string, DocFocus>>({});
  const [activityTab, setActivityTab] = useState<"conversation" | "changes">("conversation");
  const [conversationOpen, setConversationOpen] = useState(false);
  const conversationToggle = React.useRef<HTMLButtonElement>(null);
  const [loadError, setLoadError] = useState<string>();
  const [writeError, setWriteError] = useState<string>();
  const selectionKey = sel ? JSON.stringify([client.state.workspace.relay, sel.kind, sel.kind === "wiki" ? sel.slug : sel.channelId]) : "";
  const versions = loadedPage === selectionKey ? versionState : undefined;
  const threads = loadedPage === selectionKey ? threadState : [];
  const currentSelection = React.useRef(selectionKey);
  currentSelection.current = selectionKey;
  const loadSequence = React.useRef(0);
  const editBase = React.useRef<string | undefined>(undefined);
  const editSelection = React.useRef(selectionKey);
  const editDrafts = React.useRef(new Map<string, { text: string; baseId: string | undefined }>());
  if (editing) editDrafts.current.set(editSelection.current, { text: draft, baseId: editBase.current });
  const focus = focusByPage[selectionKey] ?? {};
  const setFocus = (next: DocFocus) => {
    setFocusByPage(all => ({ ...all, [selectionKey]: next }));
    if (currentSelection.current === selectionKey) {
      setActivityTab("conversation");
      setConversationOpen(true);
    }
  };
  /**
   * Which lens the open page is under. `undefined` means "nobody has
   * chosen" — so a board-shaped document may open as a board, while a
   * click on ▤ markdown sticks for as long as the page is open.
   */
  const [pageView, setPageView] = useState<string>();
  const [slash, setSlash] = useState<SlashState>();
  const editorRef = React.useRef<HTMLTextAreaElement>(null);
  // The document body gets the same markdown toolbar the channel
  // composer and the comment boxes use — one implementation, three
  // places you write prose here (format-bar.tsx).
  const docFormat = markdownFormatOps(editorRef, draft, setDraft);

  const load = useCallback(async () => {
    if (!sel) return;
    const sequence = ++loadSequence.current;
    const scope = sel.kind === "wiki" ? { slug: sel.slug } : { channelId: sel.channelId };
    try {
      const [nextVersions, nextThreads, nextTasks] = await Promise.all([
        sel.kind === "wiki" ? client.wikiVersions(sel.slug) : client.docVersions(sel.channelId),
        client.docComments(scope), client.docTasks(scope),
      ]);
      if (currentSelection.current !== selectionKey || sequence !== loadSequence.current) return;
      setVersions(nextVersions); setThreads(nextThreads); setTasks(nextTasks); setLoadedPage(selectionKey); setLoadError(undefined);
    } catch (err) {
      if (currentSelection.current === selectionKey && sequence === loadSequence.current)
        setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [client, sel, selectionKey]);

  useEffect(() => {
    setVersions(undefined); setThreads([]); setViewing(undefined); setPageView(undefined);
    setLoadError(undefined); setWriteError(undefined); setActivityTab("conversation");
    const saved = editDrafts.current.get(selectionKey);
    editSelection.current = selectionKey;
    setDraft(saved?.text ?? ""); editBase.current = saved?.baseId;
    setEditing(!!saved);
    void load();
    const refresh = () => { bump(n => n + 1); void load(); };
    const offDoc = client.on("docChanged", refresh);
    const offComments = client.on("docCommentsChanged", refresh);
    return () => { offDoc(); offComments(); loadSequence.current++; };
  }, [client, load, selectionKey]);

  useEffect(() => {
    if (sel && versions?.length === 0 && !editDrafts.current.has(selectionKey)) {
      editBase.current = undefined;
      setDraft(`# ${sel.kind === "wiki" ? sel.title ?? sel.slug : client.channelRef(sel.channelId)?.name ?? "Document"}\n\n`);
      setEditing(true);
    }
  }, [versions, sel, selectionKey, client]);

  const pages = [...client.wikiDocs().values()];
  const channelDocs = [...client.docsByChannel().entries()]
    .map(([channelId, info]) => ({ channelId, info, ref: client.channelRef(channelId) }))
    .filter((d) => d.ref && d.info.latestContent);

  /**
   * Pages whose text links here. What makes a pile of notes a wiki: you
   * can see what refers to this without maintaining an index by hand.
   */
  const backlinks =
    sel?.kind === "wiki"
      ? [...client.wikiDocs().values()].filter(
          (page) =>
            page.slug !== sel.slug &&
            [...page.latestContent.matchAll(/\[\[([^\]|]+)\]\]/g)].some((m) => wikiSlug(m[1]) === sel.slug)
        )
      : [];

  const latest = versions?.at(-1);
  const shown = viewing ? versions?.find((v) => v.id === viewing) : latest;
  const selPage = sel?.kind === "wiki" ? client.wikiDocs().get(sel.slug) : undefined;

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
  const openWiki = (slug: string, title?: string) => setSel({ kind: "wiki", slug, title });

  const publish = async (next: string, baseId: string | undefined) => {
    if (!sel || !commentChannelId) throw new Error("Create a channel before writing a document.");
    if (sel.kind === "wiki") {
      await client.publishWikiDoc(commentChannelId, selPage?.title ?? sel.title ?? sel.slug, next, baseId, sel.slug);
    } else {
      await client.publishDoc(sel.channelId, next, baseId);
    }
    if (currentSelection.current === selectionKey) { setViewing(undefined); await load(); }
  };

  const save = async () => {
    if (!sel || !draft.trim() || busy) return;
    setBusy(true); setWriteError(undefined);
    try {
      await publish(draft, editBase.current);
      editDrafts.current.delete(selectionKey);
      if (currentSelection.current === selectionKey) setEditing(false);
    } catch (err) {
      if (currentSelection.current === selectionKey) setWriteError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  const undo = async (version: WireEvent) => {
    if (busy) throw new Error("A document change is still being saved.");
    const baseId = version.tags.find(t => t[0] === "base")?.[1];
    const base = versions?.find(v => v.id === baseId);
    if (!base) throw new Error("The original version is not available. Reload the document history.");
    if (version.id !== latest?.id) throw new Error("Newer edits exist. Review the latest version first.");
    setBusy(true);
    try { await publish(base.content, version.id); }
    finally { setBusy(false); }
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

  // `md` builds a fresh `components.code` function every time it runs —
  // once per markdown block, on every WikiView render — so react-markdown
  // sees a new component TYPE at that position each time and tears the
  // block (MountPoint included) down and back up regardless of whether
  // the block's content changed. Unlike ChannelInfo's single ReactMarkdown
  // instance, this handler is built inside a plain per-block factory
  // (`md`, called from a `.map()`), not at a stable per-render hook call
  // site — so it's cached by hand (doc identity + block text) rather than
  // memoized with useCallback. Cleared whenever the open page changes, so
  // it doesn't grow across an entire session of browsing many pages.
  //
  // Caching `handler` alone isn't enough: react-markdown calls handler's
  // BODY fresh on every WikiView re-render even though its TYPE is now
  // stable (that's normal function-component behavior), so the `render`
  // passed to MountPoint would still be a new closure each time unless
  // it's ALSO cached — keyed on `raw` (the block's actual content), one
  // level down, so a same-content re-render reuses it and only a real
  // content change produces a new one.
  //
  // No residual staleness on selPage/homeChannel resolving async: docKey's
  // own tail is `selPage?.channelId ?? homeChannel()` — the EXACT same
  // expression the cached mountRender resolves channelId from below. Any
  // change that would give a block a different channelId also changes
  // docKey, which clears both caches above before the block is asked for
  // again.
  const docKeyRef = React.useRef<string | undefined>(undefined);
  const codeHandlers = React.useRef(new Map<string, (props: React.ComponentPropsWithoutRef<"code">) => React.ReactNode>());
  const mountRenders = React.useRef(new Map<string, MountRender>());
  const docKey = sel
    ? `${sel.kind}:${sel.kind === "wiki" ? sel.slug : sel.channelId}:${
        sel.kind === "wiki" ? selPage?.channelId ?? homeChannel() ?? "" : ""
      }`
    : "";
  if (docKeyRef.current !== docKey) {
    docKeyRef.current = docKey;
    codeHandlers.current = new Map();
    mountRenders.current = new Map();
  }
  const codeHandlerFor = (blockText: string) => {
    let handler = codeHandlers.current.get(blockText);
    if (!handler) {
      handler = ({ className, children, ...rest }) => {
        const lang = /language-([\w:.-]+)/.exec(className ?? "")?.[1];
        // fez:query ships with the app rather than as an extension —
        // it is the doc surface's own vocabulary, like [[links]].
        if (lang === "fez:query" && sel) {
          return <QueryBlock client={client} source={String(children ?? "")} />;
        }
        const blockRender = lang ? blockRenderer(lang) : undefined;
        if (blockRender && sel) {
          const body = String(children ?? "").replace(/\n$/, "");
          const infoLine = blockText.split("\n").find((l) => l.trim().startsWith("```" + lang)) ?? "```" + lang;
          const raw = `${infoLine}\n${body}\n\`\`\``;
          // docKey is already folded into `raw`'s cache being cleared
          // wholesale on a doc-identity change (above), so a plain
          // `raw` key can't collide across pages the way it could if
          // this cache outlived the doc it was built for.
          let mountRender = mountRenders.current.get(raw);
          if (!mountRender) {
            mountRender = (host) =>
              blockRender(
                {
                  info: infoLine.trim().slice(3 + (lang?.length ?? 0)).trim(),
                  body,
                  raw,
                  channelId: sel.kind === "wiki" ? selPage?.channelId ?? homeChannel() ?? "" : sel.channelId,
                  slug: sel.kind === "wiki" ? sel.slug : undefined,
                },
                host
              );
            mountRenders.current.set(raw, mountRender);
          }
          return <MountPoint render={mountRender} />;
        }
        return <code className={className} {...rest}>{children}</code>;
      };
      codeHandlers.current.set(blockText, handler);
    }
    return handler;
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
        code: codeHandlerFor(text),
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

  // The object literal below used to be built inline at the render site —
  // a fresh closure every WikiView render, so MountPoint's mount effect
  // (keyed on the render prop's identity) refired, and any state a
  // mount-form page view holds was lost, on every unrelated WikiView
  // re-render (a comment loading, a keystroke elsewhere) — not just when
  // the page actually changed. Keyed on the doc identity, not the
  // save/comment closures rebuilt every render (those would defeat the
  // memo) — a real content edit lands as a new `shown.id`, which is
  // itself in the key, so a republish still remounts the view.
  const pageViewRender = useCallback(
    (host?: HTMLElement) => {
      if (!sel || !shown || !activeViewImpl) return undefined;
      return activeViewImpl.render(
        {
          content: shown.content,
          save: (next) => publish(next, shown.id),
          comment: async (text, anchor, mentions) => {
            if (!sel) return;
            const channelId = sel.kind === "wiki" ? selPage?.channelId ?? homeChannel() : sel.channelId;
            if (!channelId) return;
            await client.publishDocComment(channelId, text, {
              anchor,
              slug: sel.kind === "wiki" ? sel.slug : undefined,
              mentionPks: mentions.map((name) => client.pkByName(name)).filter((pk): pk is string => !!pk),
            });
            await load();
          },
          title: sel.kind === "wiki" ? selPage?.title ?? sel.title ?? sel.slug : client.channelRef(sel.channelId)?.name ?? "",
          channelId: sel.kind === "wiki" ? selPage?.channelId ?? homeChannel() ?? "" : sel.channelId,
          slug: sel.kind === "wiki" ? sel.slug : undefined,
          editable: shown.id === latest?.id,
        },
        host
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately doc-identity, not every closed-over value: see comment above
    [activeViewImpl?.name, sel?.kind, sel?.kind === "wiki" ? sel.slug : sel?.channelId, selPage?.channelId, shown?.id]
  );

  const currentBase = versions?.find(v => v.id === shown?.tags.find(t => t[0] === "base")?.[1]);
  const change = shown && currentBase ? documentChange(currentBase.content, shown.content) : undefined;
  const selectedThread = threads.find(t => t.id === focus.threadId);
  const selectedAnchor = selectedThread?.anchorContext ?? focus.anchor;
  const selectedRange = shown && selectedAnchor ? locateDocAnchor(shown.content, selectedAnchor) : undefined;

  const discuss = (start: number, end: number, openContained = false) => {
    if (!shown) return;
    const anchor = createDocAnchor(shown.content, start, end);
    const existing = threads.find(thread => {
      const range = locateDocAnchor(shown.content, thread.anchorContext ?? { text: thread.anchor, prefix: "", suffix: "" });
      return range && (openContained ? range.start >= start && range.end <= end : range.start === start && range.end === end);
    });
    setFocus({ anchor, threadId: existing?.id });
  };

  const selectPassage = (event: React.MouseEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !shown || !event.currentTarget.contains(selection.anchorNode) || !event.currentTarget.contains(selection.focusNode)) return;
    const range = selection.getRangeAt(0);
    const blockFor = (node: Node) => (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest<HTMLElement>("[data-doc-start]");
    const first = blockFor(range.startContainer), last = blockFor(range.endContainer);
    if (!first || !last || !selection.toString().trim()) return;
    const source = (element: HTMLElement) => {
      const start = Number(element.dataset.docStart), end = Number(element.dataset.docEnd);
      return { start, end, text: shown.content.slice(start, end) };
    };
    let leading = selection.toString(), trailing = leading;
    if (first !== last) {
      const firstBody = first.querySelector(".doc-line-body")!, lastBody = last.querySelector(".doc-line-body")!;
      const head = range.cloneRange(), tail = range.cloneRange();
      head.setEnd(firstBody, firstBody.childNodes.length);
      tail.setStart(lastBody, 0);
      leading = head.toString(); trailing = tail.toString();
    }
    const selected = docSelectionRange(source(first), source(last), leading, trailing);
    discuss(selected.start, selected.end);
  };

  const blockOccurrences = new Map<string, number>();

  return (
    <main className="main wiki-main">
      <aside className="wiki-list">
        <div className="wiki-list-head">
          Pages
          <button className="community-add" title="new page" onClick={() => setNewTitle(newTitle === undefined ? "" : undefined)}>
            +
          </button>
        </div>
        {/* One list. Flattening (#108) made the relay the workspace, so
            grouping by channel here meant looping channels and rendering
            the SAME full doc list inside each — three groups, identical
            contents. Pages are workspace-level; a channel doc names its
            channel, which is all the grouping that was ever doing. */}
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
        {[...pages]
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((page) => (
            <button
              key={page.slug}
              className={sel?.kind === "wiki" && sel.slug === page.slug ? "channel active" : "channel"}
              onClick={() => openWiki(page.slug)}
            >
              ▤ {page.title}
            </button>
          ))}
        {channelDocs.map(({ channelId, ref }) => (
          <button
            key={channelId}
            className={sel?.kind === "channel" && sel.channelId === channelId ? "channel active" : "channel"}
            onClick={() => setSel({ kind: "channel", channelId })}
          >
            <span className="hash">#</span> {ref!.name} doc
          </button>
        ))}
        {pages.length === 0 && channelDocs.length === 0 && <div className="wiki-empty-group">no docs yet</div>}
      </aside>

      <section className="wiki-page">
        {sel && (
          <header className="topbar">
            <div className="topbar-row wiki-page-head">
              <h1 className="wiki-title">
                {sel.kind === "wiki"
                  ? selPage?.title ?? sel.title ?? sel.slug
                  : `# ${client.channelRef(sel.channelId)?.name ?? ""} doc`}
              </h1>
              <div className="wiki-page-tools">
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
                    aria-pressed={!activeView}
                    onClick={() => setPageView("")}
                    title="the document as written"
                  >
                    ▤ markdown
                  </button>
                  {shownViews.views.map((view) => (
                    <button
                      key={view.name}
                      className={activeView === view.name ? "page-view active" : "page-view"}
                      aria-pressed={activeView === view.name}
                      onClick={() => setPageView(view.name)}
                    >
                      {view.name}
                    </button>
                  ))}
                </div>
              )}
              {commentChannelId && <button ref={conversationToggle} className="agent-action wiki-conversation-toggle"
                aria-label="Conversation" aria-expanded={conversationOpen} aria-controls="wiki-conversation"
                onClick={() => setConversationOpen(open => !open)}>
                Conversation{threads.some(t => !t.resolved) && <span className="wiki-discussion-count">{threads.filter(t => !t.resolved).length}</span>}
              </button>}
              {!editing && (
                <button
                  className="agent-action"
                  onClick={() => {
                    editBase.current = latest?.id;
                    setDraft(latest?.content ?? "");
                    setWriteError(undefined);
                    setEditing(true);
                  }}
                >
                  ✎ {latest ? "edit" : "write"}
                </button>
              )}
              </div>
            </div>
          </header>
        )}
        <div className="wiki-document-layout">
        <div className="wiki-document">
        <div className="wiki-scroll">
        {loadError && <div className="doc-load-error" role="alert">Couldn’t load this document. {loadError} <button className="mini" onClick={() => void load()}>Retry</button></div>}
        {writeError && <div className="doc-load-error" role="alert">{writeError}{editing ? " Your draft is kept." : ""}</div>}
        {sel && !versions && !loadError && <div className="pane-empty" role="status">Loading document…</div>}
        {!sel && (
          <div className="channel-intro doc-intro">
            {/* An empty page is an invitation, not a notice: quill (the
                writing agent) waits here, and the way to start a page
                is on the page rather than a + in the column beside it. */}
            <span className="doc-intro-sprite">
              <AnimatedSprite sprite={SPRITES.quill} scale={5} />
            </span>
            <h2><span className="intro-hash">▤</span> docs</h2>
            <p>
              Living pages your whole community — agents included — can read, edit, and version. Write [[page name]]
              anywhere in a doc to link pages together; a link to an unwritten page starts it. Channel docs live here
              too. Select a passage to discuss it, or ask an agent to help write the page.
            </p>
            <button className="agent-action" onClick={() => setNewTitle(newTitle === undefined ? "" : undefined)}>
              + new page
            </button>
          </div>
        )}
        {sel && (
          <>
            {editing ? (
              <fieldset disabled={busy} className="doc-editor wiki-editor">
                <div className="doc-textarea-wrap">
                  {/* Persistent here, unlike the comment box: this is a
                      full-page editor, so a bar that appears only on
                      selection would be hide-and-seek. */}
                  <FormatBar ops={docFormat} className="format-bar doc-format-bar" />
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
                  <button className="agent-action" onClick={() => { editDrafts.current.delete(selectionKey); setEditing(false); setWriteError(undefined); }}>cancel</button>
                </div>
              </fieldset>
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
                      <MountPoint render={pageViewRender} />
                    </div>
                  ) : (
                  <div className="md doc-body wiki-body" onMouseUp={selectPassage}>
                    {docBlocks(shown.content).map((block) => {
                      // Identical blocks use occurrence order; unrelated text edits preserve extension state.
                      const occurrence = blockOccurrences.get(block.text) ?? 0;
                      blockOccurrences.set(block.text, occurrence + 1);
                      const anchored = threads.filter(t => {
                        if (!t.anchor) return false;
                        const range = locateDocAnchor(shown.content, t.anchorContext ?? { text: t.anchor, prefix: "", suffix: "" });
                        return range && range.start >= block.start && range.start < block.end;
                      });
                      const open = anchored.filter(t => !t.resolved);
                      const selected = selectedRange && selectedRange.start < block.end && selectedRange.end > block.start;
                      const changed = change && (change.start === change.end
                        ? change.start >= block.start && change.start <= block.end
                        : change.start < block.end && change.end > block.start);
                      return <div key={`${occurrence}:${block.text}`} data-doc-start={block.start} data-doc-end={block.end} className={`doc-line${selected ? " commenting" : ""}${changed ? " doc-line-changed" : ""}`}>
                        <div className="doc-line-body">{changed && <div className="doc-edit-receipt"><span>{client.displayName(shown.pubkey)} edited this passage</span><button onClick={() => { setActivityTab("changes"); setConversationOpen(true); }}>Review</button>{shown.id === latest?.id && <button disabled={busy} onClick={() => void undo(shown).catch(err => setWriteError(err instanceof Error ? err.message : String(err)))}>Undo</button>}</div>}{md(block.text)}</div>
                        <button className={open.length ? "line-comment has" : "line-comment"} aria-label={`Discuss passage${open.length ? ` · ${open.length} open discussions` : ""}`} onClick={() => discuss(block.start, block.end, true)}>☷{open.length > 0 && <span className="line-comment-count">{open.length}</span>}</button>
                      </div>;
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

          </>
        )}
        </div>

        </div>
        {sel && commentChannelId && <DocConversation hidden={!conversationOpen} onClose={() => { setConversationOpen(false); conversationToggle.current?.focus(); }} client={client} pageKey={selectionKey} channelId={commentChannelId} slug={sel.kind === "wiki" ? sel.slug : undefined} versions={versions ?? []} threads={threads} focus={focus} onFocus={setFocus} onRefresh={load} onUndo={undo} tab={activityTab} onTab={setActivityTab} onViewVersion={setViewing} />}
        </div>
      </section>
    </main>
  );
}
