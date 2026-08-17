import { useCallback, useEffect, useState } from "react";
import type { FezClient, WireEvent } from "@fez/client";

/**
 * Channel docs — the 40100 surface: one living document per channel,
 * every version a signed event, the newest one the working copy.
 * Read renders markdown; edit opens the full text with the base
 * version pinned (the TUI and disk mirror see the same chain).
 */

export default function DocsPane({
  client,
  channelId,
  communityId,
  renderMd,
  onClose,
}: {
  client: FezClient;
  channelId: string;
  communityId: string;
  renderMd: (text: string) => React.ReactNode;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<WireEvent[] | undefined>();
  const [viewing, setViewing] = useState<string>(); // version event id; undefined = latest
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setVersions(await client.docVersions(channelId, communityId));
  }, [client, channelId, communityId]);

  useEffect(() => {
    void load();
  }, [load]);

  const latest = versions?.at(-1);
  const shown = viewing ? versions?.find((v) => v.id === viewing) : latest;
  const channelName = client.channelRef(channelId)?.name ?? channelId.slice(0, 8);

  const publish = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await client.publishDoc(channelId, communityId, draft, latest?.id);
      setEditing(false);
      setViewing(undefined);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="pane docs-pane">
      <header className="pane-head">
        <span>≡ #{channelName} doc</span>
        <div className="pane-actions">
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
          <button className="pane-close" onClick={onClose}>✕</button>
        </div>
      </header>
      <div className="pane-body">
        {!versions && <div className="pane-empty">loading…</div>}
        {versions?.length === 0 && !editing && (
          <div className="pane-empty">no doc yet — a channel doc is shared standing context for everyone here, agents included</div>
        )}

        {editing ? (
          <div className="doc-editor">
            <textarea
              className="doc-textarea"
              value={draft}
              autoFocus
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={"# " + channelName + "\n\nwhat this channel needs everyone to know…"}
            />
            <div className="agent-actions">
              <button className="agent-action" disabled={busy || !draft.trim()} onClick={() => void publish()}>
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
              </div>
              <div className="md doc-body">{renderMd(shown.content)}</div>
            </>
          )
        )}

        {!editing && (versions?.length ?? 0) > 1 && (
          <>
            <div className="manage-section">versions</div>
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
          </>
        )}
      </div>
    </aside>
  );
}
