import { useCallback, useEffect, useState } from "react";
import type { FezClient, ReportEntry } from "@fezchat/client";
import Avatar from "./Avatar";
import { flash } from "./toast";

/**
 * Where flagged messages come to you. Every moderator sees the same queue
 * (reports encrypt to each of them), and resolution is derived from the
 * signed record — one moderator acts, it clears for the whole team, with
 * attribution. Full view, moderators only.
 */
export default function ModerationQueue({
  client,
  onOpenChannel,
}: {
  client: FezClient;
  onOpenChannel: (channelId: string, msgId?: string) => void;
}) {
  const [entries, setEntries] = useState<ReportEntry[]>([]);
  const [tab, setTab] = useState<"open" | "resolved">("open");

  const refresh = useCallback(() => {
    void client.listReports().then(setEntries).catch(() => setEntries([]));
  }, [client]);
  useEffect(refresh, [refresh]);

  const open = entries.filter((e) => !e.resolved);
  const resolved = entries.filter((e) => e.resolved);
  const shown = tab === "open" ? open : resolved;

  const act = (label: string, fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      flash(label);
    } catch (err) {
      flash(`✗ ${err instanceof Error ? err.message : String(err)}`);
    }
    refresh();
  };

  const channelName = (id?: string) => (id ? client.state.workspace.channels.get(id)?.name ?? id.slice(0, 8) : "?");

  return (
    <div className="modq">
      <div className="modq-head">
        <h2>Moderation queue</h2>
        {open.length > 0 && <span className="modq-count">{open.length} open</span>}
        <span className="modq-who">visible to all moderators · owner + admins</span>
      </div>
      <p className="modq-sub">
        Flagged messages, encrypted to every moderator. Act once — remove, ban, or dismiss — and it clears for the whole team.
      </p>
      <div className="modq-tabs">
        <button className={tab === "open" ? "on" : ""} onClick={() => setTab("open")}>Open · {open.length}</button>
        <button className={tab === "resolved" ? "on" : ""} onClick={() => setTab("resolved")}>Resolved · {resolved.length}</button>
      </div>

      {shown.length === 0 && (
        <div className="modq-empty">
          {tab === "open" ? "Nothing flagged. When someone reports a message, it lands here." : "Nothing resolved yet."}
        </div>
      )}

      {shown.map((entry) => {
        const preview = client.msgById(entry.targetId)?.content;
        return (
          <div key={entry.targetId} className={entry.resolved ? "modq-rep resolved" : "modq-rep"}>
            <div className="modq-flag">
              {entry.authorPk && <Avatar pk={entry.authorPk} size={24} quip={false} />}
              <div className="modq-fmsg">
                <div className="modq-fwho">
                  {entry.authorPk ? client.displayName(entry.authorPk) : "unknown author"}
                  <span className="modq-loc">in #{channelName(entry.channelId)}</span>
                </div>
                <div className="modq-ftxt">
                  {entry.resolved?.action === "removed" ? "⌫ removed by a moderator" : preview ?? "(message not loaded — jump to see it)"}
                </div>
              </div>
              <span className={entry.reporters.length > 1 ? "modq-sev many" : "modq-sev"}>
                {entry.reporters.length} report{entry.reporters.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="modq-reporters">
              {entry.reporters.map((r) => (
                <span key={r.pk + r.at} className="modq-r">
                  <b>{client.displayName(r.pk)}</b> “{r.reason}”
                </span>
              ))}
            </div>
            <div className="modq-actions">
              {entry.channelId && (
                <button onClick={() => onOpenChannel(entry.channelId!, entry.targetId)}>
                  <span className="g">→</span>Jump to message
                </button>
              )}
              {!entry.resolved && (
                <>
                  <button
                    className="danger"
                    onClick={act("removed the message", () => client.removeMessage(entry.targetId, entry.reporters[0]?.reason))}
                  >
                    <span className="g">⊘</span>Remove message
                  </button>
                  {entry.authorPk && (
                    <button
                      className="danger"
                      onClick={act(`banned ${client.displayName(entry.authorPk!)}`, () =>
                        client.banUser(entry.authorPk!, undefined, entry.reporters[0]?.reason)
                      )}
                    >
                      <span className="g">⊘</span>Ban {client.displayName(entry.authorPk)}
                    </button>
                  )}
                  <button onClick={act("dismissed — letting it stand", () => client.dismissReport(entry.targetId))}>
                    <span className="g">×</span>Dismiss
                  </button>
                </>
              )}
              {entry.resolved?.action === "removed" && (
                <button onClick={act("restored the message", () => client.restoreMessage(entry.targetId))}>
                  <span className="g">↩</span>Restore
                </button>
              )}
              {entry.resolved && (
                <span className="modq-resolvedby">
                  {entry.resolved.action}
                  {entry.resolved.by ? <> by <b>{client.displayName(entry.resolved.by)}</b></> : null}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
