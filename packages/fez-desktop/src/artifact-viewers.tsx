import type { Artifact } from "@fezchat/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The artifact viewer REGISTRY — fez is extensible first, so even the
 * built-ins enter through the same door an npm-shipped viewer package
 * will use: registerArtifactViewer(type, component). A GUI extension
 * (future ~/.fez/gui-extensions loader) claims new types — "canvas",
 * "map", "chart" — without touching core. Unknown types fall back to
 * title + link, which is also exactly what bare clients (TUI/CLI)
 * render: the wire never depends on any viewer existing.
 */

export type ArtifactViewer = (props: { artifact: Artifact }) => React.ReactNode;

const registry = new Map<string, ArtifactViewer>();

export function registerArtifactViewer(type: string, viewer: ArtifactViewer): void {
  registry.set(type, viewer);
}

export function viewerFor(type: string): ArtifactViewer | undefined {
  return registry.get(type);
}

// ── built-ins ──────────────────────────────────────────────────────────

/** Sandboxed page: scripts allowed, origin isolated (no cookies, no
 * parent access, no same-origin) — a website/canvas agent gets a real
 * runtime without touching the app. */
registerArtifactViewer("html", ({ artifact }) =>
  artifact.content ? (
    <iframe
      className="artifact-frame"
      sandbox="allow-scripts"
      srcDoc={artifact.content}
      title={artifact.title ?? "artifact"}
    />
  ) : artifact.url ? (
    <iframe className="artifact-frame" sandbox="allow-scripts" src={artifact.url} title={artifact.title ?? "artifact"} />
  ) : null
);

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
