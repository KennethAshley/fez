import { Fragment, useEffect, useMemo, useState } from "react";
import type { ObserverEntry } from "@fezchat/client";
import { SPRITES } from "@fezchat/ui";
import { generateSprite } from "@fezchat/ui";
import { AnimatedSprite } from "@fezchat/ui";

/**
 * The agent transcript — Buzz's agentSession surface (tool classifier,
 * file-edit diffs, transcript grouping), fez-shaped. Raw observer
 * frames are folded first: tool_call_update frames merge into their
 * call by callId (ACP patch semantics), accumulated text/thought frames
 * collapse to their latest, and turn markers cut the stream into
 * groups — older turns render collapsed (<details>), the live one open.
 * Tool rows are classified by ACP ToolKind: a glyph, the path it
 * touches, a status mark, and an inline line-diff for edits.
 */

type ToolItem = {
  t: "tool";
  callId?: string;
  title?: string;
  status?: string;
  kind?: string;
  path?: string;
  diff?: { path: string; oldText?: string; newText: string };
};
type Item = ToolItem | { t: "thought"; text: string } | { t: "text"; text: string };
type TurnGroup = { outcome?: string; items: Item[]; firstTs?: number; lastTs?: number };

const KIND_GLYPH: Record<string, string> = {
  read: "≡",
  edit: "±",
  delete: "⌫",
  move: "→",
  search: "⌕",
  execute: "$",
  think: "…",
  fetch: "↓",
};

const STATUS_MARK: Record<string, string> = {
  pending: "·",
  in_progress: "▸",
  completed: "✓",
  failed: "✗",
};

function fold(entries: ObserverEntry[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let current: TurnGroup | undefined;
  const open = () => {
    current = { items: [] };
    groups.push(current);
    return current;
  };
  for (const entry of entries) {
    if (entry.type === "turn") {
      if (entry.status === "started") open().firstTs = entry.ts;
      else if (current) {
        current.outcome = entry.status;
        current.lastTs = entry.ts;
        current = undefined;
      }
      continue;
    }
    const group = current ?? open();
    group.firstTs ??= entry.ts;
    group.lastTs = entry.ts;
    const last = group.items.at(-1);
    if (entry.type === "tool") {
      // ACP patch semantics: updates carry only changed fields.
      const existing = entry.callId
        ? (group.items.find((item) => item.t === "tool" && item.callId === entry.callId) as ToolItem | undefined)
        : undefined;
      if (existing) {
        if (entry.title) existing.title = entry.title;
        if (entry.status) existing.status = entry.status;
        if (entry.kind) existing.kind = entry.kind;
        if (entry.path) existing.path = entry.path;
        if (entry.diff) existing.diff = entry.diff;
      } else {
        group.items.push({
          t: "tool",
          callId: entry.callId,
          title: entry.title,
          status: entry.status,
          kind: entry.kind,
          path: entry.path,
          diff: entry.diff,
        });
      }
    } else if (entry.type === "thought" || entry.type === "text") {
      // Accumulated text: each frame supersedes the previous of its type.
      if (last && last.t === entry.type) (last as { text: string }).text = entry.text ?? "";
      else group.items.push({ t: entry.type, text: entry.text ?? "" });
    }
  }
  return groups;
}

/** mm:ss for anything under an hour; a bare `12s` reads better below a minute. */
function fmtDur(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}:${String(s).padStart(2, "0")}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * The live turn's clock. Two clocks are involved and only one of them is
 * ours: the frames are stamped by the AGENT's machine, so an agent-vs-local
 * subtraction would show whatever the skew is. Differences within the
 * agent's own stream are sound, though — so the turn's run-so-far comes
 * from its frames, and the local clock only measures the gap since the
 * last frame landed here.
 */
function LiveElapsed({ baseMs }: { baseMs: number }) {
  const [ms, setMs] = useState(baseMs);
  useEffect(() => {
    const landed = Date.now();
    setMs(baseMs);
    const id = window.setInterval(() => setMs(baseMs + (Date.now() - landed)), 1000);
    return () => window.clearInterval(id);
  }, [baseMs]);
  return <span className="turn-elapsed">{fmtDur(ms)}</span>;
}

/**
 * How long since the agent last SAID anything — the signal that separates
 * "slow model, still streaming" from "turn died mid-air". Elapsed time
 * alone can't tell them apart (a Chutes TEE model can legitimately think
 * for minutes), but silence can: fresh frames = working, long quiet =
 * probably stuck. Silent under 15s (normal inter-frame gap); a dim
 * "quiet Ns" after that; past 90s it says the honest thing out loud.
 */
function LiveQuiet({ lastTs }: { lastTs: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const quietMs = now - lastTs;
  if (quietMs < 15_000) return null;
  const stale = quietMs > 90_000;
  return (
    <span className={stale ? "turn-quiet stale" : "turn-quiet"} title="time since the agent's last activity frame — long silence usually means the turn is stuck, not slow">
      · quiet {fmtDur(quietMs)}{stale ? " — likely stuck" : ""}
    </span>
  );
}

const OUTCOME_MARK: Record<string, string> = { done: "✓", failed: "✗", cancelled: "⊘" };

/** What a collapsed turn did: a tally per tool kind, most-used first. */
function tally(items: Item[]): { glyph: string; kind: string; n: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.t !== "tool") continue;
    const kind = item.kind ?? "tool";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => ({ glyph: KIND_GLYPH[kind] ?? "⚙", kind, n }));
}

export default function ActivityFeed({
  entries,
  emptyNote,
  agent,
  agentPk,
}: {
  entries: ObserverEntry[];
  emptyNote: string;
  /** Name of the watched agent — its creature holds the room while empty. */
  agent?: string;
  agentPk?: string;
}) {
  const groups = useMemo(() => fold(entries), [entries]);
  const sprite = (agent && SPRITES[agent.toLowerCase()]) || (agentPk ? generateSprite(agentPk) : undefined);
  if (groups.length === 0) {
    return (
      <div className="feed-empty">
        {sprite && (
          <span className="feed-empty-face">
            <AnimatedSprite sprite={sprite} scale={4} />
          </span>
        )}
        <div className="feed-empty-line">{emptyNote}</div>
      </div>
    );
  }
  return (
    <>
      {groups.map((group, index) => {
        const live = index === groups.length - 1 && !group.outcome;
        const kinds = tally(group.items);
        const tools = group.items.filter((item) => item.t === "tool").length;
        // What it is doing RIGHT NOW: the call still in flight, else the
        // most recent one — the head should never say only "working".
        const running = live
          ? ([...group.items].reverse().find((item) => item.t === "tool" && item.status === "in_progress") ??
             [...group.items].reverse().find((item) => item.t === "tool")) as ToolItem | undefined
          : undefined;
        const doing = running?.title ?? running?.path?.split("/").at(-1);
        const last = [...group.items].reverse().find((item) => item.t === "tool" && item.path) as ToolItem | undefined;
        const dur = group.firstTs !== undefined && group.lastTs !== undefined ? group.lastTs - group.firstTs : undefined;
        return (
          <details key={index} className={`turn ${group.outcome ?? "live"}`} open={index === groups.length - 1}>
            <summary className="turn-head">
              <span className={`turn-status ${group.outcome ?? "live"}`}>
                {/* A finished-looking group with NO outcome is a turn whose
                    stream died unclosed (agent restarted, superseded) —
                    "turn …" read like it was still coming. Say what it is. */}
                {live ? "▸ working" : `${OUTCOME_MARK[group.outcome ?? ""] ?? "·"} turn ${group.outcome ?? "interrupted"}`}
              </span>
              {live && <LiveElapsed baseMs={dur ?? 0} />}
              {live && group.lastTs !== undefined && <LiveQuiet lastTs={group.lastTs} />}
              {!live && dur !== undefined && dur > 0 && <span className="turn-elapsed">{fmtDur(dur)}</span>}
              {live && doing && (
                <span className="turn-doing">
                  {running?.kind && <span className="turn-doing-kind">{KIND_GLYPH[running.kind] ?? "⚙"}</span>} {doing}
                </span>
              )}
              {!live && kinds.length > 0 && (
                <span className="turn-tally" title={kinds.map((k) => `${k.n} ${k.kind}`).join(" · ")}>
                  {kinds.map((k) => (
                    <span key={k.kind} className="turn-tally-item">
                      <span className="turn-tally-glyph">{k.glyph}</span>{k.n}
                    </span>
                  ))}
                </span>
              )}
              {!live && last?.path && <span className="turn-last">{last.path.split("/").at(-1)}</span>}
              {live && tools > 0 && <span className="turn-count">{tools} tool{tools === 1 ? "" : "s"}</span>}
            </summary>
            {/* The starved moment: a live turn whose frames haven't landed
                yet (harness booting) used to render a bare "working" line.
                The creature holds the room and says what's coming. */}
            {live && group.items.length === 0 && (
              <div className="turn-warming">
                {sprite && <AnimatedSprite sprite={sprite} scale={3} />}
                <span>@{agent ?? "agent"} is spinning up — thoughts and tool calls stream here as they happen</span>
              </div>
            )}
            {group.items.map((item, itemIndex) => (
              <Fragment key={itemIndex}>
                {item.t === "tool" && <ToolRow item={item} />}
                {item.t === "thought" && <div className="thought">{item.text.slice(-600)}</div>}
                {item.t === "text" && <div className="reply-preview">{item.text.slice(-600)}</div>}
              </Fragment>
            ))}
          </details>
        );
      })}
    </>
  );
}

function ToolRow({ item }: { item: ToolItem }) {
  const glyph = KIND_GLYPH[item.kind ?? ""] ?? "⚙";
  const mark = STATUS_MARK[item.status ?? ""] ?? "·";
  const base = item.path?.split("/").at(-1);
  return (
    <div className={`tool-line ${item.status ?? ""}`}>
      <span className="tool-kind" title={item.kind ?? "tool"}>{glyph}</span>{" "}
      {item.title ?? item.kind ?? "tool"}
      {base && !item.title?.includes(base) && <span className="tool-path"> {base}</span>}
      <span className={`tool-mark ${item.status ?? ""}`}> {mark}</span>
      {item.diff && <DiffBlock diff={item.diff} />}
    </div>
  );
}

/**
 * Compact line diff. LCS up to 120×120 lines; beyond that (or on
 * new files) it degrades to a plain removed/added listing. Unchanged
 * runs collapse to ±2 lines of context.
 */
const LCS_CAP = 120;
const SHOWN_CAP = 40;

type DiffLine = { sign: " " | "-" | "+"; line: string };

function diffLines(oldText: string | undefined, newText: string): DiffLine[] {
  const a = oldText === undefined ? [] : oldText.split("\n");
  const b = newText.split("\n");
  if (a.length === 0) return b.map((line) => ({ sign: "+" as const, line }));
  if (a.length > LCS_CAP || b.length > LCS_CAP) {
    return [...a.map((line) => ({ sign: "-" as const, line })), ...b.map((line) => ({ sign: "+" as const, line }))];
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ sign: " ", line: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ sign: "-", line: a[i] }); i++; }
    else { out.push({ sign: "+", line: b[j] }); j++; }
  }
  while (i < a.length) out.push({ sign: "-", line: a[i++] });
  while (j < b.length) out.push({ sign: "+", line: b[j++] });
  return out;
}

/** Collapse unchanged runs to ±context lines around changes. */
function withContext(lines: DiffLine[], context = 2): (DiffLine | { sign: "…"; line: string })[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.sign === " ") return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
  });
  const out: (DiffLine | { sign: "…"; line: string })[] = [];
  let skipping = 0;
  for (let index = 0; index < lines.length; index++) {
    if (keep[index]) {
      if (skipping > 0) out.push({ sign: "…", line: `⋯ ${skipping} unchanged` });
      skipping = 0;
      out.push(lines[index]);
    } else skipping++;
  }
  if (skipping > 0) out.push({ sign: "…", line: `⋯ ${skipping} unchanged` });
  return out;
}

function DiffBlock({ diff }: { diff: { path: string; oldText?: string; newText: string } }) {
  const lines = useMemo(() => withContext(diffLines(diff.oldText, diff.newText)), [diff]);
  const shown = lines.slice(0, SHOWN_CAP);
  return (
    <div className="diff">
      <div className="diff-path">{diff.path.split("/").slice(-2).join("/")}</div>
      {shown.map((line, index) => (
        <div key={index} className={line.sign === "+" ? "diff-line add" : line.sign === "-" ? "diff-line del" : line.sign === "…" ? "diff-line skip" : "diff-line"}>
          <span className="diff-sign">{line.sign}</span>
          {line.line || " "}
        </div>
      ))}
      {lines.length > SHOWN_CAP && <div className="diff-line skip">⋯ {lines.length - SHOWN_CAP} more (truncated at source)</div>}
    </div>
  );
}
