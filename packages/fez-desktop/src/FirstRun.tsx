import { useEffect, useState } from "react";
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

const ROUTER_URL = "http://127.0.0.1:8080/v1/models";

type RouterState = "checking" | "up" | "down";

export default function FirstRun({
  client,
  channelName,
  onOpenAgents,
}: {
  client: FezClient;
  channelName: string;
  onOpenAgents: () => void;
}) {
  const [router, setRouter] = useState<RouterState>("checking");
  const [copied, setCopied] = useState(false);

  // @fez runs on a local 26M-param router, so this is a question about
  // this machine — not about credentials, and not about the network.
  useEffect(() => {
    let live = true;
    const check = async () => {
      try {
        const response = await fetch(ROUTER_URL, { signal: AbortSignal.timeout(2500) });
        if (live) setRouter(response.ok ? "up" : "down");
      } catch {
        if (live) setRouter("down");
      }
    };
    void check();
    const timer = setInterval(() => void check(), 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  const agents = [...client.agents().values()].filter(Boolean);
  const hasFez = agents.some((name) => name.toLowerCase() === "fez");
  const others = agents.filter((name) => name.toLowerCase() !== "fez");

  const commands = "brew install cactus-compute/cactus/cactus\ncactus serve Cactus-Compute/needle --no-cloud-handoff";

  return (
    <div className="channel-intro first-run">
      <div className="intro-hash">#</div>
      <h2>{channelName}</h2>

      {hasFez ? (
        <>
          <p>
            <span className="fr-agent">@fez</span> is here. Mention it with anything you want done and it finds
            whoever's best for the job — that's its whole purpose, so you never have to remember who does what.
          </p>

          {router === "up" && (
            <p className="fr-ok">
              ✓ Its router is running locally. Try <span className="fr-try">@fez what can you do?</span>
            </p>
          )}

          {router === "down" && (
            <div className="fr-blocked">
              <p>
                It can't answer yet — its router isn't running on this machine. It's a 26M-parameter model that
                runs locally, so there's no API key and nothing leaves your laptop:
              </p>
              <pre
                className="fr-cmd"
                title="click to copy"
                onClick={() => {
                  void navigator.clipboard.writeText(commands);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? "✓ copied" : commands}
              </pre>
              <p className="fr-note">This panel notices on its own once it's up.</p>
            </div>
          )}

          {router === "checking" && <p className="fr-dim">checking whether its router is running…</p>}
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
