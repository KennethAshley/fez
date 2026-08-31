/**
 * fez-loom, gui part — the crystallize surface for live tools.
 *
 * @loom weaves throwaway tools in threads; core renders them (the
 * sandbox and its read/consent bridge are core's trust boundary, and any
 * agent can emit a live artifact). What LOOM owns is what happens when a
 * tool is worth keeping:
 *
 *   ★ keep     — an artifact-pane action that lifts a tool out of
 *                scrollback into the durable gallery (localStorage rung)
 *   ▣ tools    — a rail view listing kept tools; reopen, forget
 *   ⇪ share    — publish a kept tool back into its home channel
 *   ⤓ export   — scaffold it into a real, publishable fez extension
 *
 * Enters through three seams: registerArtifactAction (the ★),
 * registerNavView (the gallery), and the host's openTool/exportTool
 * capabilities. Uninstall loom and the surface vanishes; the sandbox and
 * tool handles in threads stay, because those were never loom's.
 *
 * Own React (bundled), the mount model: every seam gets a `host` node,
 * mounts its own root into it, and hands back a disposer — no injected
 * `api.React`, no `h()` factory.
 */

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { keptTools, isKept, keepTool, unkeepTool, toolArtifact, type ArtifactLike, type KeptTool } from "./store.js";
import { exportFiles } from "./export.js";

interface ClientLike {
  state: {
    scope?: { channelId: string };
    workspace: { channels: ReadonlyMap<string, { name: string }> };
  };
  publishArtifact(channelId: string, artifact: { type: string; title: string; content: string }): Promise<unknown>;
}

interface GuiApi {
  client: ClientLike;
  registerNavView(name: string, opts: { glyph: string; label: string }, render: (host?: HTMLElement) => () => void): void;
  registerArtifactAction(
    name: string,
    render: (props: { artifact: ArtifactLike }, host?: HTMLElement) => (() => void) | void
  ): void;
  openTool(artifact: ArtifactLike): void;
  exportTool(files: { slug: string; guiJs: string; pkgJson: string; readme: string }): Promise<string>;
}

export default function activate(api: GuiApi): void {
  const { client } = api;

  /** Re-render whenever the kept set changes, whoever changed it. */
  function useKept(): KeptTool[] {
    const [tools, setTools] = useState(keptTools);
    useEffect(() => {
      const update = () => setTools(keptTools());
      window.addEventListener("fez-tools-changed", update);
      return () => window.removeEventListener("fez-tools-changed", update);
    }, []);
    return tools;
  }

  // ★ keep — mounted in the tool pane's header by core, next to ✕.
  function KeepStar({ artifact }: { artifact: ArtifactLike }) {
    const kept = useKept().some((t) => t.content === artifact.content);
    const toggle = () => {
      const existing = keptTools().find((t) => t.content === artifact.content);
      if (existing) unkeepTool(existing.id);
      else keepTool(artifact);
    };
    return (
      <button
        className="pane-close"
        title={kept ? "kept — click to remove from ▣ artifacts" : "keep this artifact (adds it to ▣ artifacts)"}
        onClick={toggle}
      >
        {kept ? "★" : "☆"}
      </button>
    );
  }

  api.registerArtifactAction("keep", ({ artifact }, host) => {
    const root = createRoot(host!);
    root.render(<KeepStar artifact={artifact} />);
    return () => root.unmount();
  });

  // ▣ tools — the gallery, as a rail view.
  function ToolsGallery() {
    const tools = useKept();
    // Share/export outcomes land here — a gui part has no host toast, and
    // a line under the heading is enough for a you-just-clicked result.
    const [status, setStatus] = useState<string | undefined>(undefined);

    // Crystallize, rung 2: publish the kept tool back into its home channel
    // (fallback: the one in scope) as a user-signed artifact — it lands as a
    // normal tool handle anyone there can open and ★ keep.
    const share = async (t: KeptTool) => {
      const channelId = t.channelId ?? client.state.scope?.channelId;
      if (!channelId) {
        setStatus("no channel to share into — open a channel first");
        return;
      }
      const name = client.state.workspace.channels.get(channelId)?.name ?? "the channel";
      if (!confirm(`Share "${t.title}" into #${name}? Everyone there can open and keep it.`)) return;
      try {
        await client.publishArtifact(channelId, { type: t.type, title: t.title, content: t.content });
        setStatus(`Shared "${t.title}" to #${name}`);
      } catch (e) {
        setStatus(`Share failed: ${String((e as Error)?.message ?? e)}`);
      }
    };

    const doExport = async (t: KeptTool) => {
      try {
        const path = await api.exportTool(exportFiles(t));
        setStatus(`Exported to ${path} — build & publish to share`);
      } catch (e) {
        setStatus(`Export failed: ${String((e as Error)?.message ?? e)}`);
      }
    };

    return (
      // The app's page grammar, so a kept-tools gallery sits at the same
      // measure as every other page instead of running the window's width.
      // The host already wraps a nav view in <main className="main">
      // (gui-extensions.ts: "the host owns the button and the <main>
      // shell"), so this stays the bare fez-page div AgentsPage/SkillsView
      // use — @fezchat/ui's <Page> would nest a second <main>, and its
      // <PageHeader>/<EmptyState> only carry one page-fact / two lines,
      // short of the two simultaneous facts and the ghost-card-first empty
      // state this gallery has always shown. Reusing them here would
      // change what the page shows, not just how it's built — this
      // migration is presentation-only, so the page-head/page-empty
      // markup below is hand-kept instead, on the identical classNames.
      <div className="fez-page wide tools-scroll">
        <div className="page-head">
          <h2 className="page-title">Artifacts</h2>
          <div className="page-sub">Artifacts you kept. Open one in the pane, or ask @loom to weave another.</div>
          <div className="page-rule">
            {/* Nothing when the page is empty: the block below says so once,
                at full size. The rule still draws — it is the column's edge. */}
            {tools.length === 0 ? null : <span className="page-fact">{tools.length} kept</span>}
            {status ? <span className="page-fact">{status}</span> : null}
          </div>
        </div>
        {tools.length === 0 ? (
          <div className="page-empty">
            {/* The frame a kept tool will occupy, drawn empty — the room
                holds its shape before anyone lives in it. */}
            <div className="tool-card ghost">
              <div className="tool-card-preview">
                <span className="tool-ghost-glyph">▣</span>
              </div>
              <div className="tool-card-meta">
                <span className="tool-card-sub">your first tool lives here</span>
              </div>
            </div>
            <div className="page-empty-line">You haven't kept a tool yet.</div>
            <div className="page-empty-how">
              Ask @loom in any channel to build one — a chart, a tracker, a small app. Open what it makes, and hit ★
              to keep it here.
            </div>
          </div>
        ) : (
          <div className="tools-grid">
            {tools.map((t) => {
              const home = t.channelId ? client.state.workspace.channels.get(t.channelId)?.name : undefined;
              const woven = new Date(t.ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" });
              return (
                <div key={t.id} className="tool-card">
                  <button
                    className="tool-card-open"
                    title="open in the pane"
                    onClick={() => api.openTool(toolArtifact(t))}
                  >
                    <div className="tool-card-preview">
                      {/* The tool itself, running at quarter scale — the same
                          sandbox the pane grants, nothing more. Pointer events
                          stop at the container; the whole card is one button. */}
                      <iframe
                        className="tool-card-live"
                        sandbox="allow-scripts"
                        srcDoc={t.content}
                        tabIndex={-1}
                        aria-hidden={true}
                        title=""
                      />
                    </div>
                    <div className="tool-card-meta">
                      <span className="tool-card-title">{t.title}</span>
                      <span className="tool-card-sub">{home ? `woven ${woven} · #${home}` : `woven ${woven}`}</span>
                    </div>
                  </button>
                  <div className="tool-card-actions">
                    <button className="tool-card-act" title="share into its channel" onClick={() => void share(t)}>
                      ⇪
                    </button>
                    <button
                      className="tool-card-act"
                      title="export as a publishable fez extension"
                      onClick={() => void doExport(t)}
                    >
                      ⤓
                    </button>
                    <button className="tool-card-act danger" title="forget this tool" onClick={() => unkeepTool(t.id)}>
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  api.registerNavView("loom-tools", { glyph: "▣", label: "artifacts" }, (host) => {
    const root = createRoot(host!);
    root.render(<ToolsGallery />);
    return () => root.unmount();
  });
}
