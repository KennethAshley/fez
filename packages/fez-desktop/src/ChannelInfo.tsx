import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FezClient } from "@fez/client";
import { blockRenderer, docMarkdownPlugins } from "./gui-extensions";

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
}: {
  client: FezClient;
  channelId: string;
    channelName: string;
  onJump: (msgId: string) => void;
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
  if (!hasDoc && pins.length === 0 && !editing) {
    return (
      <div className="channel-info empty">
        {/* Same bar as the filled state: without it this row got no
            horizontal padding and sat left of the topbar and every
            message, which read as a misalignment rather than a hint. */}
        <div className="channel-info-bar">
          <button className="channel-info-toggle" onClick={() => { setDraft(`# ${channelName}\n\n`); setEditing(true); }}>
            ▤ add channel info — what everyone here should know
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
        <button className="channel-info-toggle" onClick={() => setOpen(!open)}>
          <span className="channel-info-caret">{open ? "▾" : "▸"}</span> ▤ channel info
          {!open && firstLine && <span className="channel-info-peek">{firstLine.slice(0, 90)}</span>}
          {!open && pins.length > 0 && <span className="channel-info-count">⚑ {pins.length}</span>}
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
                  code: ({ className, children, ...rest }) => {
                    const lang = /language-([\w:.-]+)/.exec(className ?? "")?.[1];
                    const render = lang ? blockRenderer(lang) : undefined;
                    if (render) {
                      const body = String(children ?? "").replace(/\n$/, "");
                      const infoLine =
                        doc!.latestContent.split("\n").find((l) => l.trim().startsWith("```" + lang)) ?? "```" + lang;
                      return (
                        <>
                          {render({
                            info: infoLine.trim().slice(3 + lang!.length).trim(),
                            body,
                            raw: `${infoLine}\n${body}\n\`\`\``,
                            channelId,
                          })}
                        </>
                      );
                    }
                    return <code className={className} {...rest}>{children}</code>;
                  },
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
          {pins.length > 0 && (
            <>
              <div className="channel-info-section">⚑ pinned</div>
              {pins.map(([msgId, pin]) => {
                const msg = client.messages(channelId).find((m) => m.id === msgId);
                return (
                  <button key={msgId} className="channel-info-pin" onClick={() => onJump(msgId)}>
                    <span className="comment-author">{client.displayName(msg?.authorPk ?? pin.by)}</span>
                    <span className="channel-info-pin-text">
                      {msg ? msg.content.replace(/\s+/g, " ").slice(0, 120) : "(older message — click to jump)"}
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
