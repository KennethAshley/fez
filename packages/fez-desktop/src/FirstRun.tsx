import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FezClient } from "@fezchat/client";
import { readiness } from "./welcome";

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
  // Whether a mention of @fez can actually produce a reply on this
  // machine (model + watcher). undefined while probing, so the panel
  // never flashes a promise the probe hasn't backed yet.
  const [ready, setReady] = useState<boolean>();
  // In a fresh LOCAL workspace @fez exists as a persona before it has
  // ever announced on the roster — the sentinel spawns it on mention,
  // so "is a persona" is as real as "has announced".
  const [localFez, setLocalFez] = useState(false);
  useEffect(() => {
    let alive = true;
    void readiness().then((r) => { if (alive) setReady(r.authed && r.runner); }).catch(() => {});
    void invoke<string[]>("list_personas")
      .then((names) => { if (alive) setLocalFez(names.some((n) => n.toLowerCase() === "fez")); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

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
  const hasFez = localFez || agents.some((name) => name.toLowerCase() === "fez");
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
            <span className="fr-agent">@fez</span> is your guide. Ask it anything about fez — how git works, what an
            extension does, how to set something up — and it answers. Hand it a task and it brings in the right agent.
          </p>

          {ready === false ? (
            <p className="fr-ok">
              @fez needs a model to think with — connect one in{' '}
              <button className="fr-link" onClick={onOpenAgents}>Settings → Agents</button>, then mention{' '}
              <span className="fr-try">@fez</span> here.
            </p>
          ) : (
            <p className="fr-ok">
              Try <span className="fr-try">@fez what can you do?</span> — or ask it to set you up, like{' '}
              <span className="fr-try">@fez install polls</span> (you confirm before anything installs).
            </p>
          )}
          <p className="fr-note">
            @fez is a persona at <code>~/.fez/personas/fez.md</code> — swap its <code>harness:</code> to run it on any
            model, or the hosted router for a cheap local option.{' '}
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
