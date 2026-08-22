import { cloneBase } from "./repo-name.js";
import { parseJournal, type PushEntry } from "./journal-format.js";
import { lineOf, rootMarker } from "./threads.js";
import type { El, GuiExtensionApi } from "@fezchat/extension-api/gui";

/**
 * The lane board — a ⑂ thread rendered as what it IS: a line of work
 * with lanes.
 *
 * Data comes from the transport, not from parsing chat: the push
 * journal says which branches exist on this line, who moved them and
 * when; the diff endpoint says what a lane actually changed; the merge
 * endpoint is the button. The thread's messages stay right below the
 * board — this is an index over the conversation, never a replacement
 * (the host renders thread views additively, by design).
 *
 * One thread, one owner: each lane row is one agent's branch. Watch
 * opens that agent's transcript; diff answers "what did it do"; merge
 * is the serialization point, refused politely by the relay when the
 * clicker may not (protection is server-side — the button carries no
 * authority of its own).
 */

interface Lane {
  branch: string;
  agent: string;
  tip: string;
  pusher: string;
  ts: number;
}

/** The line's lanes, newest activity last (stable reading order). */
export function lanesFor(entries: PushEntry[], line: string): Lane[] {
  const byBranch = new Map<string, Lane>();
  for (const entry of entries) {
    if (!entry.ref.startsWith("refs/heads/")) continue;
    const branch = entry.ref.slice("refs/heads/".length);
    if (branch !== line && lineOf(branch) !== line) continue;
    if (entry.new === "0".repeat(40)) {
      byBranch.delete(branch);
      continue;
    }
    byBranch.set(branch, {
      branch,
      agent: branch.includes("/") ? branch.slice(0, branch.indexOf("/")) : branch,
      tip: entry.new,
      pusher: entry.pusher,
      ts: entry.ts,
    });
  }
  return [...byBranch.values()].sort((a, b) => a.ts - b.ts);
}

/** `⑂ \`name\`` at the start of a root — the marker every ⑂ thread carries. */
export const lineOfRoot = (rootContent: string): string | undefined =>
  rootContent.match(/^⑂ `([^`]+)`/)?.[1];

export function makeLaneBoard(api: GuiExtensionApi) {
  const h = api.React.createElement;
  const { useState, useEffect, useCallback } = api.React;
  const { client } = api;

  return function LaneBoard({ channelId, rootContent }: { channelId: string; rootId: string; rootContent: string }): El {
    const [lanes, setLanes] = useState<Lane[]>([]);
    const [error, setError] = useState<string | undefined>(undefined);
    const [diffOpen, setDiffOpen] = useState<string | undefined>(undefined);
    const [diffText, setDiffText] = useState<string | undefined>(undefined);
    const [merging, setMerging] = useState<string | undefined>(undefined);
    const [notice, setNotice] = useState<string | undefined>(undefined);

    const line = lineOfRoot(rootContent);
    const repo = client.channelsFrom("fez-git").find((c) => c.id === channelId)?.meta?.repo;
    const base = cloneBase(client.relayInfo());

    /** GET a gated relay endpoint. Sign the PATH-ONLY url (the server's verifier strips queries). */
    const gated = useCallback(async (pathUrl: string, query: string, method = "GET"): Promise<Response | undefined> => {
      const header = client.httpAuthHeader(pathUrl, method);
      if (!header) return undefined;
      return fetch(`${pathUrl}${query}`, { method, headers: { Authorization: header } });
    }, []);

    const refresh = useCallback(async () => {
      if (!base || !repo || !line) return;
      try {
        const res = await gated(`${base}/${repo}.git/fez-push-journal`, "");
        if (!res) {
          setError("this client cannot sign requests — the board needs a newer desktop build");
          return;
        }
        if (!res.ok) {
          setError(`journal fetch: relay answered ${res.status}`);
          return;
        }
        setError(undefined);
        setLanes(lanesFor(parseJournal(await res.text()), line));
      } catch (err) {
        // Named, not swallowed: a silent catch here hid a CORS failure
        // as "0 lanes" while the journal sat on the relay. Stale data
        // stays on screen; the reason sits beside it.
        setError(`journal fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, [base, repo, line]);

    useEffect(() => {
      void refresh();
      const timer = setInterval(() => void refresh(), 20_000);
      return () => clearInterval(timer);
    }, [refresh]);

    async function showDiff(lane: Lane): Promise<void> {
      if (diffOpen === lane.branch) {
        setDiffOpen(undefined);
        return;
      }
      setDiffOpen(lane.branch);
      setDiffText(undefined);
      const res = await gated(`${base}/${repo}.git/fez-diff`, `?from=${encodeURIComponent(line ?? "")}&to=${encodeURIComponent(lane.branch)}`);
      setDiffText(res && res.ok ? await res.text() : `could not load the diff (${res?.status ?? "unreachable"})`);
    }

    async function merge(lane: Lane): Promise<void> {
      setMerging(lane.branch);
      setError(undefined);
      try {
        const res = await gated(`${base}/${repo}.git/fez-merge`, `?branch=${encodeURIComponent(lane.branch)}&into=${encodeURIComponent(line ?? "")}`, "POST");
        const body = (await res?.json().catch(() => undefined)) as { merged?: boolean; sha?: string; reason?: string } | undefined;
        if (body?.merged) setNotice(`✓ merged \`${lane.branch}\` → ${body.sha?.slice(0, 8)}`);
        else setError(body?.reason ?? `merge failed (${res?.status ?? "unreachable"})`);
      } finally {
        setMerging(undefined);
        void refresh();
      }
    }

    if (!line || !repo || !base) return null;
    const working = client.workingAgents();

    return h(
      "div",
      { className: "lane-board" },
      h(
        "div",
        { className: "lane-board-head" },
        h("span", { className: "skill-name" }, `line ${line}`),
        h("span", { className: "skill-desc" }, ` · ${lanes.filter((l) => l.branch !== line).length} lane(s)`)
      ),
      error ? h("p", { className: "ob-error" }, error) : null,
      notice ? h("p", { className: "settings-hint" }, notice) : null,
      lanes.length === 0
        ? h("p", { className: "settings-hint" }, "no pushes on this line yet — mention an agent in this thread to put it to work here")
        : lanes.map((lane) => {
            const isLine = lane.branch === line;
            const busy = working.has(lane.agent);
            return h(
              "div",
              { key: lane.branch, className: "lane-row" },
              h("span", { className: busy ? "working" : "agent-ghost" }, busy ? "⚙" : "○"),
              h("code", null, lane.branch),
              h("span", { className: "skill-desc" }, ` ${client.displayName(lane.pusher)} · `),
              h("code", null, lane.tip.slice(0, 8)),
              h(
                "span",
                { className: "lane-actions" },
                // The tree's edge: a lane row opens the lane's OWN
                // thread. Found by its root marker among the channel's
                // absorbed messages — the same join the thread task
                // writes by.
                (() => {
                  const laneRoot = client
                    .messages(channelId)
                    .find((m) => !m.rootId && m.content.includes(rootMarker(lane.branch)));
                  return laneRoot && lane.branch !== line
                    ? h("button", { className: "skill-link", onClick: () => api.openThread(channelId, laneRoot.id) }, "thread")
                    : null;
                })(),
                h("button", { className: "skill-link", onClick: () => api.watchAgent(lane.agent) }, "watch"),
                isLine
                  ? null
                  : h("button", { className: "skill-link", onClick: () => void showDiff(lane) }, diffOpen === lane.branch ? "hide diff" : "diff"),
                isLine
                  ? null
                  : h(
                      "button",
                      { className: "skill-link", disabled: merging === lane.branch, onClick: () => void merge(lane) },
                      merging === lane.branch ? "merging…" : "merge"
                    )
              ),
              diffOpen === lane.branch
                ? h("pre", { className: "lane-diff" }, diffText ?? "loading diff…")
                : null
            );
          })
    );
  };
}
