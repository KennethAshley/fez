import type { Artifact } from "@fezchat/client";
import { registerArtifactViewer } from "@fezchat/artifact-viewers";
import { LiveArtifact } from "./live-artifact";
import { useArtifactDoc } from "./artifact-url";

/**
 * The registry and portable viewers (html, image, pdf, markdown, table)
 * live in @fezchat/artifact-viewers — shared with the fez.chat share
 * pages so a shared artifact renders with the same code the app uses.
 * This module keeps only what needs the desktop: the artifact://-staged
 * html frame (the webview's CSP would govern srcDoc scripts) and the
 * live read-bridge viewer. Re-registering a type overrides the built-in.
 */

export { registerArtifactViewer, viewerFor } from "@fezchat/artifact-viewers";
export type { ArtifactViewer } from "@fezchat/artifact-viewers";

/** Sandboxed page: scripts allowed, origin isolated. Inline content goes
 * through the artifact:// stage (useArtifactDoc) rather than srcDoc, so
 * the app's CSP doesn't govern the artifact's own scripts. */
function HtmlArtifact({ artifact }: { artifact: Artifact }) {
  const stagedUrl = useArtifactDoc(artifact.content ?? undefined);
  if (artifact.content) {
    if (!stagedUrl) return null; // staging — a frame flash later beats a dead one
    return (
      <iframe
        className="artifact-frame"
        sandbox="allow-scripts"
        src={stagedUrl}
        title={artifact.title ?? "artifact"}
      />
    );
  }
  if (artifact.url) {
    return <iframe className="artifact-frame" sandbox="allow-scripts" src={artifact.url} title={artifact.title ?? "artifact"} />;
  }
  return null;
}
registerArtifactViewer("html", ({ artifact }) => <HtmlArtifact artifact={artifact as Artifact} />);

/** Like "html", but wired to the read bridge: the sandboxed tool can ask
 * the relay read-only questions (window.fez.query/subscribe) and stream
 * the answers, with no network egress. See live-artifact.tsx. */
registerArtifactViewer("live", ({ artifact }) => <LiveArtifact artifact={artifact as Artifact} />);
