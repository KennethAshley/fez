import { Fragment, useMemo } from "react";
import type { ObserverEntry } from "@fezchat/client";

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
type TurnGroup = { outcome?: string; items: Item[] };

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
      if (entry.status === "started") open();
      else if (current) {
        current.outcome = entry.status;
        current = undefined;
      }
      continue;
    }
    const group = current ?? open();
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

export default function ActivityFeed({ entries, emptyNote }: { entries: ObserverEntry[]; emptyNote: string }) {
  const groups = useMemo(() => fold(entries), [entries]);
  if (groups.length === 0) return <div className="pane-empty">{emptyNote}</div>;
  return (
    <>
      {groups.map((group, index) => {
        const live = index === groups.length - 1 && !group.outcome;
        const tools = group.items.filter((item) => item.t === "tool").length;
        return (
          <details key={index} className={`turn ${group.outcome ?? "live"}`} open={index === groups.length - 1}>
            <summary className="turn-head">
              <span className={`turn-status ${group.outcome ?? "live"}`}>
                {live ? "▸ working" : `turn ${group.outcome ?? "…"}`}
              </span>
              {tools > 0 && <span className="turn-count">{tools} tool{tools === 1 ? "" : "s"}</span>}
            </summary>
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
