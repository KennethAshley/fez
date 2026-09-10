import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The artifact viewer REGISTRY, extracted from fez-desktop so the
 * fez.chat share pages render an artifact with the same code the app
 * does. fez is extensible first: even the built-ins enter through the
 * same door an npm-shipped viewer package uses —
 * registerArtifactViewer(type, component). Hosts re-register over the
 * built-ins to specialize (fez-desktop swaps "html" for its
 * artifact://-staged frame and adds "live"); later registration wins.
 * Unknown types fall back to title + link — exactly what bare clients
 * (TUI/CLI) render, so the wire never depends on any viewer existing.
 */

/** The renderable slice of a kind-40300 artifact — structural, so hosts
 * with richer artifact objects (fez-client's Artifact) pass them as-is. */
export interface ViewableArtifact {
  type: string;
  title?: string;
  url?: string;
  content?: string;
}

export type ArtifactViewer = (props: { artifact: ViewableArtifact }) => ReactNode;

const registry = new Map<string, ArtifactViewer>();

export function registerArtifactViewer(type: string, viewer: ArtifactViewer): void {
  registry.set(type, viewer);
}

export function viewerFor(type: string): ArtifactViewer | undefined {
  return registry.get(type);
}

/** Capture the host's viewers before loading extensions, including ones they may override. */
export function snapshotArtifactViewers(): () => void {
  const snapshot = new Map(registry);
  return () => {
    registry.clear();
    for (const [type, viewer] of snapshot) registry.set(type, viewer);
  };
}

// ── portable built-ins ────────────────────────────────────────────────

/** Sandboxed page: scripts allowed, origin isolated (no cookies, no
 * parent access, no same-origin) — srcDoc under sandbox="allow-scripts"
 * runs in an opaque origin. fez-desktop re-registers this type with its
 * artifact:// staged frame (the webview's CSP would otherwise govern the
 * artifact's own scripts); everywhere else the plain sandbox is right. */
function HtmlArtifact({ artifact }: { artifact: ViewableArtifact }) {
  if (artifact.content) {
    return (
      <iframe
        className="artifact-frame"
        sandbox="allow-scripts"
        srcDoc={artifact.content}
        title={artifact.title ?? "artifact"}
      />
    );
  }
  if (artifact.url) {
    return <iframe className="artifact-frame" sandbox="allow-scripts" src={artifact.url} title={artifact.title ?? "artifact"} />;
  }
  return null;
}
registerArtifactViewer("html", HtmlArtifact);

registerArtifactViewer("image", ({ artifact }) => {
  const src = artifact.url ?? (artifact.content?.startsWith("data:") ? artifact.content : undefined);
  return src ? <img className="md-img" src={src} alt={artifact.title ?? ""} /> : null;
});

registerArtifactViewer("pdf", ({ artifact }) => {
  const src = artifact.url ?? (artifact.content?.startsWith("data:application/pdf") ? artifact.content : undefined);
  return src ? <embed className="artifact-frame artifact-pdf" src={src} type="application/pdf" /> : null;
});

registerArtifactViewer("markdown", ({ artifact }) =>
  artifact.content ? (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{artifact.content}</ReactMarkdown>
    </div>
  ) : null
);

/** JSON array of flat objects → table. The agent-friendliest data shape. */
registerArtifactViewer("table", ({ artifact }) => {
  try {
    const rows = JSON.parse(artifact.content ?? "[]") as Record<string, unknown>[];
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 12);
    return (
      <div className="artifact-table-wrap">
        <table className="artifact-table">
          <thead>
            <tr>{columns.map((col) => <th key={col}>{col}</th>)}</tr>
          </thead>
          <tbody>
            {rows.slice(0, 100).map((row, index) => (
              <tr key={index}>{columns.map((col) => <td key={col}>{String(row[col] ?? "")}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  } catch {
    return null;
  }
});
