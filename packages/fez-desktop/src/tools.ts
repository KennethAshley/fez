import type { Artifact } from "@fezchat/client";

/**
 * Kept tools — the first rung of "crystallize". A live tool starts as a
 * throwaway artifact in a thread; keeping it lifts it out of scrollback
 * into a durable, reopenable thing that lives in the 🔧 tools view. This
 * is the local, this-machine rung; exporting a kept tool as a real
 * installable @fezchat extension is the next one up.
 *
 * Stored in localStorage (self-contained HTML, no relay needed to reopen),
 * and a `fez-tools-changed` event lets every surface re-read reactively.
 */

export interface KeptTool {
  id: string;
  title: string;
  type: string;
  content: string;
  ts: number;
}

const KEY = "fez-tools";

export function keptTools(): KeptTool[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as KeptTool[];
    return Array.isArray(raw) ? raw.sort((a, b) => b.ts - a.ts) : [];
  } catch {
    return [];
  }
}

function write(tools: KeptTool[]): void {
  localStorage.setItem(KEY, JSON.stringify(tools));
  window.dispatchEvent(new CustomEvent("fez-tools-changed"));
}

/** Is this artifact already kept? Matched on content, so re-keeping the
 * same tool is a no-op rather than a duplicate. */
export function isKept(artifact: Artifact): boolean {
  return keptTools().some((t) => t.content === artifact.content);
}

export function keepTool(artifact: Artifact): void {
  if (!artifact.content || isKept(artifact)) return;
  const tool: KeptTool = {
    id: artifact.id,
    title: artifact.title ?? "tool",
    type: artifact.type,
    content: artifact.content,
    ts: Math.floor(Date.now() / 1000),
  };
  write([tool, ...keptTools()]);
}

export function unkeepTool(id: string): void {
  write(keptTools().filter((t) => t.id !== id));
}

/** Reconstruct an Artifact from a kept tool so it renders in the pane. */
export function toolArtifact(tool: KeptTool): Artifact {
  return {
    id: tool.id,
    authorPk: "",
    authorName: "kept",
    type: tool.type,
    title: tool.title,
    content: tool.content,
    ts: tool.ts,
  };
}
