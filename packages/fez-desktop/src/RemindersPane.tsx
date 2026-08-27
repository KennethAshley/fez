import { useCallback, useEffect, useState } from "react";
import { latestPerAddress, relativeWhen, type FezClient, type ReminderRecord } from "@fezchat/client";
import { AnimatedSprite } from "./pixel-sprite";
import { SPRITES } from "./sprites";
import type { BrowserWire } from "./wire";
import { toast } from "./toast";

/**
 * Reminders — Buzz's RemindersPanel over fez's encrypted reminders. Note,
 * fire time and status are NIP-44 self-encrypted (the relay sees only
 * WHEN, from the public `due` tag), so listing is: query your own events,
 * decrypt with your own key, fold to the newest write per address.
 *
 * Three actions, all one operation underneath — snooze, complete and
 * cancel republish the same address with a different status, because the
 * event is replaceable. Legacy 40007 reminders still list and still fire,
 * but have no address to republish over, so they carry no actions.
 */

const KIND_REMINDER = 40007;
const KIND_REMINDER_V2 = 30176;

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
  const [rows, setRows] = useState<ReminderRecord[] | undefined>();

  const load = useCallback(async () => {
    // `authors` alone — the same filter the client's own arming
    // subscription uses, and Buzz's author-only model for the same event.
    // A reminder is addressed to ITSELF, so a `#p` clause could only ever
    // exclude; it did, for every reminder written while the signer was
    // stripping the self `p` tag.
    const events = await wire.query([
      { kinds: [KIND_REMINDER, KIND_REMINDER_V2], authors: [client.pubkey], limit: 200 },
    ]);
    const decoded: ReminderRecord[] = [];
    for (const event of events) {
      try {
        const body = JSON.parse(await wire.decrypt(client.pubkey, event.content)) as {
          note?: string;
          remind_at?: number;
          about?: string;
          status?: ReminderRecord["status"];
        };
        if (!body.remind_at) continue;
        const address = event.tags?.find((t) => t[0] === "d")?.[1];
        decoded.push({
          key: address ?? event.id,
          id: event.id,
          note: body.note ?? "(reminder)",
          remindAt: body.remind_at,
          about: body.about,
          // A legacy reminder has no status field and cannot gain one.
          status: body.status ?? "pending",
          createdAt: event.created_at,
          editable: address !== undefined,
        });
      } catch {
        /* not decryptable — not ours */
      }
    }
    setRows(latestPerAddress(decoded).sort((a, b) => a.remindAt - b.remindAt));
  }, [wire, client]);

  useEffect(() => {
    void load();
    // Re-read when one lands — from this window, another device, or an
    // agent. The pane used to answer only for the moment it opened.
    return client.on("remindersChanged", () => void load());
  }, [client, load]);

  /** Every action ends the same way: write, then re-read. */
  const act = (what: string, run: () => Promise<void>) => {
    void run()
      .then(load)
      .catch((err: unknown) => toast.error(`✗ ${what} failed — ${err instanceof Error ? err.message : String(err)}`));
  };

  // The list counts down, so it has to re-render. Every 20s is enough
  // for minute-granularity text and cheap enough to leave running.
  const [tick, setTick] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setTick(Math.floor(Date.now() / 1000)), 20_000);
    return () => window.clearInterval(id);
  }, []);
  const nowS = tick;
  const live = rows?.filter((r) => r.status === "pending") ?? [];
  const upcoming = live.filter((r) => r.remindAt > nowS);
  const past = live.filter((r) => r.remindAt <= nowS).slice(-10).reverse();
  const done = (rows?.filter((r) => r.status === "done") ?? []).slice(-10).reverse();

  const exact = (ts: number) =>
    new Date(ts * 1000).toLocaleString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const row = (reminder: ReminderRecord, dim: boolean) => {
    // Under an hour is the one distinction worth a colour: it changes
    // what you do about it. Phosphor is the app's "live" already.
    const soon = !dim && reminder.remindAt - nowS < 3600;
    return (
    <div key={reminder.key} className={dim ? "reminder-row dim" : "reminder-row"}>
      <button
        className="reminder-open"
        title={reminder.about ? `${exact(reminder.remindAt)} — jump to the message` : exact(reminder.remindAt)}
        onClick={() => reminder.about && onJumpToMessage(reminder.about)}
      >
        {/* Time gets its own column so the whole list is scannable down
            one edge, and the notes start at a single left margin. */}
        <span className={soon ? "reminder-when soon" : "reminder-when"}>{relativeWhen(reminder.remindAt, tick)}</span>
        <span className="reminder-note">{reminder.note}</span>
      </button>
      {/* Destructive and secondary actions appear on hover, the same
          idiom the agent pencil and the kick control use. */}
      {reminder.editable && reminder.status === "pending" && (
        <span className="reminder-actions">
          <button className="mini" title="in an hour" onClick={() => act("snooze", () => client.snoozeReminder(reminder, nowS + 3600))}>
            +1h
          </button>
          <button className="mini" title="tomorrow morning" onClick={() => act("snooze", () => client.snoozeReminder(reminder, tomorrow9()))}>
            tmrw
          </button>
          <button className="mini" title="mark done" onClick={() => act("complete", () => client.completeReminder(reminder))}>
            ✓
          </button>
          <button className="reminder-drop" title="cancel this reminder" onClick={() => act("cancel", () => client.cancelReminder(reminder))}>
            ✕
          </button>
        </span>
      )}
    </div>
    );
  };

  return (
    <aside className="pane">
      <header className="pane-head">
        <span>◷ reminders</span>
        <button className="pane-close" onClick={onClose}>✕</button>
      </header>
      <div className="pane-body">
        {!rows && <div className="pane-empty">decrypting…</div>}
        {rows && upcoming.length === 0 && past.length === 0 && (
          <div className="feed-empty">
            <span className="feed-empty-face">
              <AnimatedSprite sprite={SPRITES.quill} scale={4} />
            </span>
            <div className="feed-empty-line">
              nothing waiting — hover a message and hit ◷ to put one here.
            </div>
          </div>
        )}
        {upcoming.length > 0 && <div className="manage-section">waiting</div>}
        {upcoming.map((reminder) => row(reminder, false))}
        {past.length > 0 && (
          <>
            <div className="manage-section">delivered</div>
            {past.map((reminder) => row(reminder, true))}
          </>
        )}
        {done.length > 0 && (
          <>
            <div className="manage-section">done</div>
            {done.map((reminder) => row(reminder, true))}
          </>
        )}
      </div>
    </aside>
  );
}

/** Tomorrow at 9am, in seconds — the one snooze that is a time, not a delay. */
function tomorrow9(): number {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}
