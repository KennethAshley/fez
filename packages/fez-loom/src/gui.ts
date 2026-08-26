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
      { className: "tools-scroll" },
      h(
        "div",
        { className: "tools-head" },
        h("h2", null, "▣ tools"),
        h("p", { className: "settings-hint" }, "Tools you kept — reopen any in the pane. Ask @loom to build one, then ★ it."),
        status && h("p", { className: "settings-hint" }, status)
      ),
      tools.length === 0
        ? h("div", { className: "pane-empty" }, "no kept tools yet — build one with @loom, open it, and hit ★")
        : h(
            "div",
            { className: "tools-grid" },
            tools.map((t: KeptTool) =>
              h(
                "div",
                { key: t.id, className: "tool-tile" },
                h(
                  "button",
                  { className: "tool-tile-open", title: "open in the pane", onClick: () => api.openTool(toolArtifact(t)) },
                  h("span", { className: "tool-tile-icon" }, "▣"),
                  h("span", { className: "tool-tile-title" }, t.title),
                  h(
                    "span",
                    { className: "tool-tile-date" },
                    new Date(t.ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" })
                  )
                ),
                h(
                  "button",
                  { className: "tool-tile-forget", style: { right: 48 }, title: "share into its channel", onClick: () => void share(t) },
                  "⇪"
                ),
                h(
                  "button",
                  {
                    className: "tool-tile-forget",
                    style: { right: 26 },
                    title: "export as a publishable fez extension",
                    onClick: () => void doExport(t),
                  },
                  "⤓"
                ),
                h("button", { className: "tool-tile-forget", title: "forget this tool", onClick: () => unkeepTool(t.id) }, "✕")
              )
            )
          )
    );
  }
}
