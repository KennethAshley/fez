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
 */

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  React: any;
  client: ClientLike;
  registerNavView(name: string, opts: { glyph: string; label: string }, render: () => unknown): void;
  registerArtifactAction(name: string, render: (props: { artifact: ArtifactLike }) => unknown): void;
  openTool(artifact: ArtifactLike): void;
  exportTool(files: { slug: string; guiJs: string; pkgJson: string; readme: string }): Promise<string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let h: any;

export default function activate(api: GuiApi): void {
  const React = api.React;
  h = React.createElement;
  const { client } = api;

  /** Re-render whenever the kept set changes, whoever changed it. */
  function useKept(): KeptTool[] {
    const [tools, setTools] = React.useState(keptTools);
    React.useEffect(() => {
      const update = () => setTools(keptTools());
      window.addEventListener("fez-tools-changed", update);
      return () => window.removeEventListener("fez-tools-changed", update);
    }, []);
    return tools;
  }

  // ★ keep — mounted in the tool pane's header by core, next to ✕.
  api.registerArtifactAction("keep", ({ artifact }) => h(KeepStar, { artifact }));
  function KeepStar({ artifact }: { artifact: ArtifactLike }) {
    const kept = useKept().some((t) => t.content === artifact.content);
    const toggle = () => {
      const existing = keptTools().find((t) => t.content === artifact.content);
      if (existing) unkeepTool(existing.id);
      else keepTool(artifact);
    };
    return h(
      "button",
      {
        className: "pane-close",
        title: kept ? "kept — click to remove from ▣ tools" : "keep this tool (adds it to ▣ tools)",
        onClick: toggle,
      },
      kept ? "★" : "☆"
    );
  }

  // ▣ tools — the gallery, as a rail view.
  api.registerNavView("loom-tools", { glyph: "▣", label: "tools" }, () => h(ToolsGallery));
  function ToolsGallery() {
    const tools = useKept();
    // Share/export outcomes land here — a gui part has no host toast, and
    // a line under the heading is enough for a you-just-clicked result.
    const [status, setStatus] = React.useState(undefined as string | undefined);

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

    return h(
      "div",
      // The app's page grammar, so a kept-tools gallery sits at the same
      // measure as every other page instead of running the window's width.
      { className: "fez-page wide tools-scroll" },
      h(
        "div",
        { className: "page-head" },
        h("h2", { className: "page-title" }, "Tools"),
        h("div", { className: "page-sub" },
          "Tools you kept. Open one in the pane, or ask @loom to build another."),
        h("div", { className: "page-rule" },
          // Nothing when the page is empty: the block below says so once,
          // at full size. The rule still draws — it is the column's edge.
          tools.length === 0 ? null : h("span", { className: "page-fact" }, `${tools.length} kept`),
          status ? h("span", { className: "page-fact" }, status) : null
        )
      ),
      tools.length === 0
        ? h(
            "div",
            { className: "page-empty" },
            // The frame a kept tool will occupy, drawn empty — the room
            // holds its shape before anyone lives in it.
            h(
              "div",
              { className: "tool-card ghost" },
              h("div", { className: "tool-card-preview" }, h("span", { className: "tool-ghost-glyph" }, "▣")),
              h("div", { className: "tool-card-meta" }, h("span", { className: "tool-card-sub" }, "your first tool lives here"))
            ),
            h("div", { className: "page-empty-line" }, "You haven't kept a tool yet."),
            h("div", { className: "page-empty-how" },
              "Ask @loom in any channel to build one — a chart, a tracker, a small app. ",
              "Open what it makes, and hit ★ to keep it here.")
          )
        : h(
            "div",
            { className: "tools-grid" },
            tools.map((t: KeptTool) => {
              const home = t.channelId ? client.state.workspace.channels.get(t.channelId)?.name : undefined;
              const woven = new Date(t.ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" });
              return h(
                "div",
                { key: t.id, className: "tool-card" },
                h(
                  "button",
                  { className: "tool-card-open", title: "open in the pane", onClick: () => api.openTool(toolArtifact(t)) },
                  h(
                    "div",
                    { className: "tool-card-preview" },
                    // The tool itself, running at quarter scale — the same
                    // sandbox the pane grants, nothing more. Pointer events
                    // stop at the container; the whole card is one button.
                    h("iframe", {
                      className: "tool-card-live",
                      sandbox: "allow-scripts",
                      srcDoc: t.content,
                      tabIndex: -1,
                      "aria-hidden": true,
                      title: "",
                    })
                  ),
                  h(
                    "div",
                    { className: "tool-card-meta" },
                    h("span", { className: "tool-card-title" }, t.title),
                    h("span", { className: "tool-card-sub" }, home ? `woven ${woven} · #${home}` : `woven ${woven}`)
                  )
                ),
                h(
                  "div",
                  { className: "tool-card-actions" },
                  h("button", { className: "tool-card-act", title: "share into its channel", onClick: () => void share(t) }, "⇪"),
                  h(
                    "button",
                    { className: "tool-card-act", title: "export as a publishable fez extension", onClick: () => void doExport(t) },
                    "⤓"
                  ),
                  h("button", { className: "tool-card-act danger", title: "forget this tool", onClick: () => unkeepTool(t.id) }, "✕")
                )
              );
            })
          )
    );
  }
}
