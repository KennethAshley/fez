import { useState } from "react";
import type { FezClient } from "@fez/client";

/**
 * What an empty channel says on someone's first day.
 *
 * The alternative shapes were both bad. A fabricated greeting "from" an
 * agent is a puppet, and people find that out in about ten seconds — at
 * which point every other agent in the room is suspect too. And an
 * empty room with a member count is technically honest and completely
 * useless: it tells you where you are and nothing about what to do.
 *
 * So the app talks in its own voice, and says only true things: who is
 * actually in this room, whether the thing that answers you is actually
 * running, and the exact command if it isn't. No events are published —
 * this is a panel, not a message, so nobody's history gets a fake line
 * in it.
 */

export default function FirstRun({
  client,
  channelName,
  onOpenAgents,
}: {
  client: FezClient;
  channelName: string;
  onOpenAgents: () => void;
}) {
  const [copied, setCopied] = useState(false);

  // @fez's brain is a seam — any OpenAI-compatible endpoint, local or
  // hosted — so the app cannot (and should not) probe it: a remote
  // endpoint is CORS-blocked from the webview, and "reachable from your
  // laptop" is not the question. Presence on the roster is: if @fez has
  // announced, it is configured and running somewhere.
  const copyHint = async () => {
    await navigator.clipboard.writeText("~/.fez/personas/fez.md");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const agents = [...client.agents().values()].filter(Boolean);
  const hasFez = agents.some((name) => name.toLowerCase() === "fez");
  const others = agents.filter((name) => name.toLowerCase() !== "fez");

  return (
    <div className="channel-intro first-run">
      {/* One line — "#" and the name are the channel's name, not a
          glyph with a heading under it. Stacked, the # read as
          decoration sitting above an unrelated title. */}
      <h2><span className="intro-hash">#</span>{channelName}</h2>

      {hasFez ? (
        <>
          <p>
            <span className="fr-agent">@fez</span> is here. Mention it with anything you want done and it finds
            whoever's best for the job — that's its whole purpose, so you never have to remember who does what.
          </p>

          <p className="fr-ok">
            Mention it with anything — <span className="fr-try">@fez what can you do?</span> — and it routes to
            whoever's best, or answers about fez itself.
          </p>
          <p className="fr-note">
            @fez runs on any OpenAI-compatible endpoint — a hosted router, ollama, llama.cpp, or a cloud model.
            Set <code>url:</code> in <code>~/.fez/personas/fez.md</code> and restart it.{' '}
            <button className="fr-link" onClick={() => void copyHint()}>{copied ? '✓ copied' : 'copy the path'}</button>
          </p>
        </>
      ) : (
        <p>
          No agents here yet. <button className="fr-link" onClick={onOpenAgents}>Add one</button> and mention it by
          name — it'll answer in this channel.
        </p>
      )}

      {others.length > 0 && (
        <p className="fr-roster">
          Also here: {others.slice(0, 6).map((name) => `@${name}`).join(", ")}
          {others.length > 6 && ` and ${others.length - 6} more`}
        </p>
      )}
    </div>
  );
}
