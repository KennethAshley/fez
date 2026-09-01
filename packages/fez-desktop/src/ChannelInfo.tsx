import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FezClient } from "@fezchat/client";
import { blockRenderer, docMarkdownPlugins } from "./gui-extensions";
import { MountPoint } from "./MountPoint";
import Avatar from "./Avatar";

/**
 * The channel's standing information, always reachable from inside the
 * channel: its shared markdown doc (the thing everyone — humans and
 * agents — should read first) plus its pinned messages. Collapsed by
 * default to a one-line summary; the open state is remembered per
 * channel. Agents write this doc with fez_doc_append / fez doc set, so
 * "record that in the doc" lands here and stays visible.
 */
export default function ChannelInfo({
  client,
  channelId,
  channelName,
  onJump,
  quiet = false,
}: {
  client: FezClient;
  channelId: string;
  channelName: string;
  onJump: (msgId: string) => void;
  /** Suppress the empty-state CTA. On an empty channel the FirstRun hero
   * owns the screen and already introduces the room — an "add channel
   * info" nag above it is a second info section saying less. The CTA
   * earns its place once conversation exists; a REAL doc still renders
   * regardless (information is never quiet, only the nag is). */
  quiet?: boolean;
}) {
  const key = `fez-chinfo-${channelId}`;
  const [open, setOpenState] = useState(() => localStorage.getItem(key) === "1");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [, bump] = useState(0);

  const setOpen = (next: boolean) => {
    setOpenState(next);
    localStorage.setItem(key, next ? "1" : "0");
  };

  // Agent edits land as new 40100 versions — repaint when they do.
  useEffect(() => client.on("docChanged", () => bump((n) => n + 1)), [client]);

  const doc = client.docsByChannel().get(channelId);
  const pins = [...client.pins(channelId).entries()];
  const hasDoc = !!doc?.latestContent?.trim();

  // react-markdown resolves each fenced block's component fresh from
  // `components.code` on every render pass — an inline arrow there would
  // be a NEW type each time, so React tears down and remounts the whole
  // block (MountPoint included) on every unrelated ChannelInfo re-render,
  // not just when the doc actually changed. Stable across renders where
  // the doc/channel haven't changed; CodeBlock is capitalized because
  // react-markdown calls it as a real component (via createElement), so
  // the nested useCallback below is a legitimate hook call on ITS fiber.
  const CodeBlock = useCallback(
    ({ className, children, ...rest }: React.ComponentPropsWithoutRef<"code">) => {
      const lang = /language-([\w:.-]+)/.exec(className ?? "")?.[1];
      const blockRender = lang ? blockRenderer(lang) : undefined;
      const body = String(children ?? "").replace(/\n$/, "");
      const infoLine =
        lang && doc ? doc.latestContent.split("\n").find((l) => l.trim().startsWith("```" + lang)) ?? "```" + lang : "";
      const raw = `${infoLine}\n${body}\n\`\`\``;
      // Keyed on the block's own content (not just the doc), so THIS
      // block's mount survives while a SIBLING block in the same doc
      // remounting for its own reasons doesn't disturb it.
      const mountRender = useCallback(
        (host?: HTMLElement) =>
          blockRender!({ info: infoLine.trim().slice(3 + (lang?.length ?? 0)).trim(), body, raw, channelId }, host),
        [blockRender, raw, channelId]
      );
      if (!blockRender || !doc) return <code className={className} {...rest}>{children}</code>;
      return <MountPoint render={mountRender} />;
    },
    [doc?.latestContent, channelId]
  );

  if (!hasDoc && pins.length === 0 && !editing) {
    if (quiet) return null;
    return (
      <div className="channel-info empty">
        {/* Same bar as the filled state: without it this row got no
            horizontal padding and sat left of the topbar and every
            message, which read as a misalignment rather than a hint. */}
        <div className="channel-info-bar">
          <button className="channel-info-toggle" onClick={() => { setDraft(`# ${channelName}\n\n`); setEditing(true); }}>
            <span className="channel-info-glyph">≡</span> add channel info — what everyone here should know
          </button>
        </div>
      </div>
    );
  }

  const publish = async () => {
    setBusy(true);
    try {
      await client.publishDoc(channelId, draft, doc?.latestId);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const firstLine = (doc?.latestContent ?? "").split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim();

  return (
    <div className={open || editing ? "channel-info open" : "channel-info"}>
      <div className="channel-info-bar">
        {/* Collapsed, the room's one subtitle line carries the DOC's first
            line — what the room is for — not the system's name for the
            widget. The name lives where system names belong: as the
            expanded state's section heading (mono caps, hairline running
            out — the app's label grammar), and as the hover hint that
            fades in on the collapsed line, the rail's reveal idiom. */}
        <button className="channel-info-toggle" onClick={() => setOpen(!open)} title="channel info">
          {open ? (
            <>
              <span className="channel-info-caret">▾</span>
              <span className="channel-info-label">channel info</span>
              <span className="channel-info-rule" />
            </>
          ) : (
            <>
              <span className="channel-info-glyph">≡</span>
              <span className="channel-info-peek">{firstLine ?? "channel info"}</span>
              {pins.length > 0 && <span className="channel-info-count">⚑ {pins.length}</span>}
              <span className="channel-info-hint">channel info ▾</span>
            </>
          )}
        </button>
        {(open || editing) && !editing && (
          <button
            className="mini"
            onClick={() => {
              setDraft(doc?.latestContent ?? `# ${channelName}\n\n`);
              setEditing(true);
            }}
          >
            {hasDoc ? "edit" : "write"}
          </button>
        )}
      </div>

      {editing && (
        <div className="channel-info-body">
          <textarea
            className="doc-textarea channel-info-editor"
            value={draft}
            autoFocus
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={"# " + channelName + "\n\nlinks, standing rules, who does what…"}
          />
          <div className="agent-actions">
            <button className="agent-action" disabled={busy || !draft.trim()} onClick={() => void publish()}>
              {busy ? "publishing…" : "publish"}
            </button>
            <button className="agent-action" onClick={() => setEditing(false)}>cancel</button>
          </div>
        </div>
      )}

      {open && !editing && (
        <div className="channel-info-body">
          {hasDoc && (
            <div className="md channel-info-doc">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, ...(docMarkdownPlugins() as [])]}
                components={{
                  // extension-owned fenced blocks (live blocks, diagrams…)
                  code: CodeBlock,
                }}
              >
                {doc!.latestContent}
              </ReactMarkdown>
            </div>
          )}
          {hasDoc && (
            <div className="channel-info-meta">
              last edited by {client.displayName(doc!.latestAuthor)} ·{" "}
              {new Date(doc!.latestTs * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            </div>
          )}
          {/* No "PINNED" section head — each row carries its own ⚑, so
              a lone pin doesn't get a heading taller than itself. The
              author is a face, per the grammar. */}
          {pins.map(([msgId, pin]) => {
            const msg = client.messages(channelId).find((m) => m.id === msgId);
            const authorPk = msg?.authorPk ?? pin.by;
            return (
              <button key={msgId} className="channel-info-pin" onClick={() => onJump(msgId)}>
                <span className="channel-info-pin-mark">⚑</span>
                <Avatar pk={authorPk} size={16} title={client.displayName(authorPk)} quip={false} />
                <span className="comment-author">{client.displayName(authorPk)}</span>
                <span className="channel-info-pin-text">
                  {msg ? msg.content.replace(/\s+/g, " ").slice(0, 120) : "(older message — click to jump)"}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
