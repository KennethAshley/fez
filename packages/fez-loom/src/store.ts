/**
 * Kept tools — the first rung of "crystallize". A live tool starts as a
 * throwaway artifact in a thread; keeping it lifts it out of scrollback
 * into a durable, reopenable thing in the ▣ tools gallery. This is the
 * local, this-machine rung; exporting a kept tool as a real installable
 * @fezchat extension is the next one up.
 *
 * Stored in localStorage (self-contained HTML, no relay needed to
 * reopen) under the SAME key core used before this moved into loom, so
 * tools kept before the move survive it. A `fez-tools-changed` event
 * lets every surface re-read reactively.
 */

/** The slice of a fez artifact the gallery needs — mirrors
 * @fezchat/client's Artifact, which a gui part doesn't import. */
export interface ArtifactLike {
  id: string;
  channelId: string;
  authorPk: string;
  authorName: string;
  type: string;
  title?: string;
  content: string;
  ts: number;
  rootId?: string;
}

export interface KeptTool {
  id: string;
  title: string;
  type: string;
  content: string;
  ts: number;
  /** Home channel/thread, so a kept tool's write-back still targets where
   * it was born. Absent on tools kept before this field existed — those
   * fail closed on writes (reads are unaffected). */
  channelId?: string;
  rootId?: string;
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
export function isKept(artifact: ArtifactLike): boolean {
  return keptTools().some((t) => t.content === artifact.content);
}

export function keepTool(artifact: ArtifactLike): void {
  if (!artifact.content || isKept(artifact)) return;
  const tool: KeptTool = {
    id: artifact.id,
    title: artifact.title ?? "tool",
    type: artifact.type,
    content: artifact.content,
    ts: Math.floor(Date.now() / 1000),
    channelId: artifact.channelId,
    rootId: artifact.rootId,
  };
  write([tool, ...keptTools()]);
}

export function unkeepTool(id: string): void {
  write(keptTools().filter((t) => t.id !== id));
}

/** Reconstruct an artifact from a kept tool so it renders in the pane. */
export function toolArtifact(tool: KeptTool): ArtifactLike {
  return {
    id: tool.id,
    channelId: tool.channelId ?? "",
    authorPk: "",
    authorName: "kept",
    type: tool.type,
    title: tool.title,
    content: tool.content,
    ts: tool.ts,
    rootId: tool.rootId,
  };
}
