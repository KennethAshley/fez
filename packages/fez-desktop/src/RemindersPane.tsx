import { useEffect, useState } from "react";
import type { FezClient } from "@fezchat/client";
import type { BrowserWire } from "./wire";

/**
 * Reminders — Buzz's RemindersPanel over fez's encrypted 40007s. Note,
 * fire time, and subject are NIP-44 self-encrypted (the relay sees
 * nothing), so listing is: query your own events, decrypt with your own
 * key. The sentinel is the executor; this pane is the ledger — upcoming
 * first, recent past dimmed below.
 */

const KIND_REMINDER = 40007;

interface ReminderRow {
  id: string;
  note: string;
  remindAt: number; // seconds
  about?: string;
}

export default function RemindersPane({
  client,
  wire,
  onJumpToMessage,
  onClose,
}: {
  client: FezClient;
  wire: BrowserWire;
  onJumpToMessage: (msgId: string) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<ReminderRow[] | undefined>();

  useEffect(() => {
    void (async () => {
      const events = await wire.query([{ kinds: [KIND_REMINDER], authors: [client.pubkey], "#p": [client.pubkey], limit: 200 }]);
      const mapped: ReminderRow[] = [];
      for (const event of events) {
        try {
          const body = JSON.parse(wire.decrypt(client.pubkey, event.content)) as {
            note?: string;
            remind_at?: number;
            about?: string;
          };
          if (!body.remind_at) continue;
          mapped.push({ id: event.id, note: body.note ?? "(reminder)", remindAt: body.remind_at, about: body.about });
        } catch {
          /* not decryptable — not ours */
        }
      }
      mapped.sort((a, b) => a.remindAt - b.remindAt);
      setRows(mapped);
    })();
  }, [wire, client]);

  const nowS = Math.floor(Date.now() / 1000);
  const upcoming = rows?.filter((row) => row.remindAt > nowS) ?? [];
  const past = (rows?.filter((row) => row.remindAt <= nowS) ?? []).slice(-10).reverse();

  const when = (ts: number) => {
    const date = new Date(ts * 1000);
    const today = new Date().toDateString() === date.toDateString();
    return today
      ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  const row = (reminder: ReminderRow, dim: boolean) => (
    <button
      key={reminder.id}
      className={dim ? "reminder-row dim" : "reminder-row"}
      title={reminder.about ? "jump to the message" : undefined}
      onClick={() => reminder.about && onJumpToMessage(reminder.about)}
    >
      <span className="reminder-when">◷ {when(reminder.remindAt)}</span>
      <span className="reminder-note">{reminder.note}</span>
    </button>
  );

  return (
    <aside className="pane">
      <header className="pane-head">
        <span>◷ reminders</span>
        <button className="pane-close" onClick={onClose}>✕</button>
      </header>
      <div className="pane-body">
        {!rows && <div className="pane-empty">decrypting…</div>}
        {rows && upcoming.length === 0 && (
          <div className="pane-empty">nothing scheduled — hover a message and hit ◷. The sentinel delivers them.</div>
        )}
        {upcoming.map((reminder) => row(reminder, false))}
        {past.length > 0 && (
          <>
            <div className="manage-section">delivered</div>
            {past.map((reminder) => row(reminder, true))}
          </>
        )}
      </div>
    </aside>
  );
}
