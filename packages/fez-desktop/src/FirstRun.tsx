import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FezClient } from "@fezchat/client";
import { readiness } from "./welcome";
import { FIRST_TASKS } from "./welcome-core";

/** Suggestions fill a draft; only the user's normal Send action publishes it. */
export function FirstTask({ onDraft, onConnect }: { onDraft: (text: string) => void; onConnect: () => void }) {
  const [ready, setReady] = useState<boolean>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    setReady(undefined);
    const check = () => void readiness().then((r) => { if (alive) setReady(r.authed && r.runner); });
    check();
    window.addEventListener("focus", check);
    window.addEventListener("fez-ai-connected", check);
    return () => { alive = false; window.removeEventListener("focus", check); window.removeEventListener("fez-ai-connected", check); };
  }, [revision]);
  return <div className="first-task">
    {ready === undefined ? <p role="status">Checking your AI connection…</p> : ready ? <>
      <p>Try a first task. Pick one, edit the message, and send it to @fez.</p>
      <div className="first-task-actions">
        {FIRST_TASKS.map((task) => <button key={task.label} className="mini" onClick={() => onDraft(task.prompt)}>{task.label}</button>)}
      </div>
    </> : <>
      <p>Your workspace is ready. Connect AI so your agents can reply.</p>
      <button className="mini" onClick={onConnect}>Connect AI</button>{" "}
      <button className="mini" onClick={() => setRevision((n) => n + 1)}>Check connection</button>
    </>}
  </div>;
}

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
