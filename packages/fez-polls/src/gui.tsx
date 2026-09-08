/**
 * fez-polls, gui part — enters through the message-decorator seam.
 * Renders any poll message as a card: option buttons (vote = reaction,
 * change-of-vote swaps your reaction), live member-only tallies, and a
 * closed state with the winner. Also registers /poll for the composer.
 *
 * JSX with `--jsx-factory=h` (the shared-React shape): the markup reads
 * as markup while the compiled output is the same host-React
 * createElement calls — the page keeps one React, nothing bundled.
 */

import { formatPoll, parsePoll, parsePollCommand, tallyPoll, OPTION_EMOJI } from "./format.js";

interface ClientLike {
  pubkey: string;
  reactions(targetId: string): ReadonlyMap<string, ReadonlySet<string>> | undefined;
  toggleReaction(channelId: string, targetId: string, emoji: string): Promise<void>;
  sendChannelMessage(text: string, opts?: object): Promise<unknown>;
  state: {
    scope?: { channelId: string };
    communities: Map<string, { channels: Map<string, { members: Map<string, string> }> }>;
  };
}

interface GuiApi {
  React: { createElement: typeof h; useState: <T>(v: T) => [T, (v: T) => void] };
  client: ClientLike;
  registerMessageDecorator(
    match: (content: string) => boolean,
    render: (props: { content: string; msgId: string; channelId: string; authorName: string }) => unknown
  ): void;
  registerGuiCommand(name: string, run: (args: string) => Promise<string> | string): void;
  toast?(message: string, variant?: "success" | "error" | "warn" | "info"): void;
}

// h is bound at activate() time to the host page's React
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let h: any;

export default function activate(api: GuiApi): void {
  h = api.React.createElement;
  const { client } = api;

  const members = (channelId: string): ReadonlySet<string> => {
    for (const community of client.state.communities.values()) {
      const channel = community.channels.get(channelId);
      if (channel) return new Set(channel.members.keys());
    }
    return new Set();
  };

  api.registerMessageDecorator(
    (content) => content.startsWith("📊 poll: "),
    ({ content, msgId, channelId }) => {
      const poll = parsePoll(content);
      if (!poll) return null;
      const roster = members(channelId);
      const reactionMap = client.reactions(msgId);
      const ballots: { pk: string; content: string }[] = [];
      const mine = new Set<string>();
      if (reactionMap) {
        for (const [emoji, who] of reactionMap.entries()) {
          for (const pk of who) {
            ballots.push({ pk, content: emoji });
            if (pk === client.pubkey) mine.add(emoji);
          }
        }
      }
      const tally = tallyPoll(poll.options.length, ballots, roster);
      const closed = poll.closesAtMs > 0 && Date.now() > poll.closesAtMs;
      const total = Math.max(1, tally.voters);

      const vote = async (index: number) => {
        if (closed) return;
        const target = OPTION_EMOJI[index];
        try {
          // change-of-vote: clear my other option reactions first
          for (const emoji of OPTION_EMOJI.slice(0, poll.options.length)) {
            if (emoji !== target && mine.has(emoji)) await client.toggleReaction(channelId, msgId, emoji);
          }
          if (!mine.has(target)) await client.toggleReaction(channelId, msgId, target);
        } catch (err) {
          // A failed publish means the vote didn't register — without this
          // the click just does nothing and the user assumes it counted.
          api.toast?.(`vote failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
      };

      return (
        <div className="poll-card">
          <div className="poll-question">📊 {poll.question}</div>
          {poll.options.map((option, index) => (
            <button
              key={index}
              className={`poll-option${mine.has(OPTION_EMOJI[index]) ? " mine" : ""}${closed && tally.winner === index ? " winner" : ""}`}
              disabled={closed}
              onClick={() => void vote(index)}
            >
              <span className="poll-option-label">{`${OPTION_EMOJI[index]} ${option}`}</span>
              <span className="poll-bar" style={{ width: `${(tally.counts[index] / total) * 100}%` }} />
              <span className="poll-count">{String(tally.counts[index])}</span>
            </button>
          ))}
          <div className="poll-meta">
            {closed
              ? tally.winner !== undefined
                ? `closed — "${poll.options[tally.winner]}" wins (${tally.voters} voter${tally.voters === 1 ? "" : "s"})`
                : `closed — no winner (${tally.voters} voter${tally.voters === 1 ? "" : "s"}${tally.counts.some((c) => c > 0) ? ", tie" : ""})`
              : `${tally.voters} vote${tally.voters === 1 ? "" : "s"} · members only · closes ${poll.closesAtMs ? new Date(poll.closesAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "never"}${tally.ambiguous ? ` · ${tally.ambiguous} ambiguous (multi-vote) excluded` : ""}`}
          </div>
        </div>
      );
    }
  );

  api.registerGuiCommand("poll", async (args) => {
    const parsed = parsePollCommand(args);
    if ("error" in parsed) return `📊 ${parsed.error}`;
    if (!client.state.scope) return "📊 open a channel first.";
    await client.sendChannelMessage(formatPoll(parsed.question, parsed.options, Date.now() + parsed.durationMs));
    return "";
  });
}
