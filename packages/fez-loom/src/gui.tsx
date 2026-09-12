/** Loom keeps artifacts from any agent. Core owns their live viewer and consent bridge. */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { artifactKey } from "../../fez-client/src/artifacts.js";
import { keepTool, unkeepTool, refreshTools, recoverableTools, type ArtifactLike, type KeptTool } from "./store.js";

interface ClientLike {
  pubkey: string;
  state: {
    workspace: { relay: string; channels: ReadonlyMap<string, { name: string; archived?: boolean }> };
  };
  artifacts(channelId: string): readonly ArtifactLike[];
  on(event: "artifact" | "channelsChanged", handler: () => void): () => void;
  publishArtifact(channelId: string, artifact: { type: string; title?: string; content: string }): Promise<unknown>;
}

export interface GuiApi {
  client?: ClientLike;
  registerNavView(name: string, opts: { glyph: string; label: string }, render: (host?: HTMLElement) => () => void): void;
  registerArtifactAction(name: string, render: (props: { artifact: ArtifactLike }, host?: HTMLElement) => (() => void) | void): void;
  openTool(artifact: ArtifactLike): void;
  toast?(message: string, variant?: "success" | "error" | "warn" | "info"): void;
}

export default function activate(api: GuiApi): void {
  if (!api.client) throw new Error("Loom needs read:channels permission.");
  const { client } = api;
  if (!client.pubkey || !client.state.workspace.relay || typeof client.artifacts !== "function" || typeof client.on !== "function") {
    throw new Error("Update Fez to use Loom's saved artifacts.");
  }
  const scope = { pubkey: client.pubkey, relay: client.state.workspace.relay };
  const available = () => [...client.state.workspace.channels.keys()].flatMap(id => [...client.artifacts(id)]);
  const report = (e: unknown) => api.toast?.(`Could not save artifacts: ${e instanceof Error ? e.message : String(e)}`, "error");

  function useKept() {
    const [tools, setTools] = useState<KeptTool[]>([]);
    const [older, setOlder] = useState<ArtifactLike[]>([]);
    const [error, setError] = useState<string>();
    useEffect(() => {
      const update = () => {
        try {
          const artifacts = available();
          setTools(refreshTools(scope, artifacts));
          setOlder(recoverableTools(scope, artifacts));
          setError(undefined);
        } catch (e) { setError(`Could not read saved artifacts: ${e instanceof Error ? e.message : String(e)}`); }
      };
      const offArtifact = client.on("artifact", update);
      const offChannels = client.on("channelsChanged", update);
      window.addEventListener("fez-tools-changed", update);
      window.addEventListener("storage", update);
      update();
      return () => {
        offArtifact(); offChannels();
        window.removeEventListener("fez-tools-changed", update);
        window.removeEventListener("storage", update);
      };
    }, []);
    return { tools, older, error };
  }

  function KeepStar({ artifact }: { artifact: ArtifactLike }) {
    const { tools, error } = useKept();
    const existing = tools.find(t => artifactKey(t) === artifactKey(artifact));
    return <button className="pane-close" disabled={!!error} aria-pressed={!!existing}
      title={error ?? (existing ? "remove from saved artifacts" : "save artifact")}
      onClick={() => {
        try {
          if (existing) unkeepTool(scope, existing.id);
          else keepTool(scope, artifact);
        } catch (e) { report(e); }
      }}>{existing ? "★" : "☆"}</button>;
  }

  api.registerArtifactAction("keep", ({ artifact }, host) => {
    if (!artifact.content) return;
    const root = createRoot(host!);
    root.render(<KeepStar artifact={artifact} />);
    return () => root.unmount();
  });

  function ToolsGallery() {
    const { tools, older, error } = useKept();
    const share = async (t: KeptTool) => {
      const channel = client.state.workspace.channels.get(t.channelId);
      if (!channel || channel.archived) { api.toast?.("The original channel is unavailable for sharing.", "warn"); return; }
      if (!confirm(`Share "${t.title ?? "artifact"}" into #${channel.name}? Everyone there can open and save it.`)) return;
      try {
        await client.publishArtifact(t.channelId, { type: t.type, title: t.title, content: t.content });
        api.toast?.(`Shared to #${channel.name}`, "success");
      } catch (e) { api.toast?.(`Share failed: ${e instanceof Error ? e.message : String(e)}`, "error"); }
    };
    return (
      <div className="fez-page wide tools-scroll">
        <div className="page-head">
          <h2 className="page-title">Artifacts</h2>
          <div className="page-sub">Saved from any agent. Open an artifact to use it.</div>
          <div className="page-rule"><span className="page-fact">{tools.length} saved · this account and workspace · this device</span></div>
        </div>
        {error && <div role="alert">{error}</div>}
        {older.length > 0 && <button onClick={() => {
          try { for (const artifact of older) keepTool(scope, artifact); }
          catch (e) { report(e); }
        }}>Import {older.length} older {older.length === 1 ? "save" : "saves"} from this workspace</button>}
        {!error && tools.length === 0 && (
          <div className="page-empty">
            <div className="page-empty-line">No saved artifacts yet.</div>
            <div className="page-empty-how">Ask any agent for a chart, tracker, or small app. Open its artifact and select ☆ to save it. @loom is an optional builder.</div>
          </div>
        )}
        <div className="tools-grid">
          {tools.map(t => {
            const channel = client.state.workspace.channels.get(t.channelId);
            return (
              <div key={artifactKey(t)} className="tool-card">
                <button className="tool-card-open" disabled={!channel}
                  title={channel ? "open artifact" : "original channel unavailable"}
                  onClick={() => api.openTool(t)}>
                  <div className="tool-card-meta">
                    <span className="tool-card-title">{t.title ?? "artifact"}</span>
                    <span className="tool-card-sub">{t.type} · @{t.authorName} · {channel ? `#${channel.name}` : "channel unavailable"}</span>
                    <span className="tool-card-sub">updated {new Date(t.ts * 1000).toLocaleDateString()}</span>
                  </div>
                </button>
                <div className="tool-card-actions">
                  <button className="tool-card-act" title="share into its channel" disabled={!channel || channel.archived}
                    onClick={() => void share(t)}>⇪</button>
                  <button className="tool-card-act danger" title="remove saved artifact"
                    onClick={() => { try { unkeepTool(scope, t.id); } catch (e) { report(e); } }}>✕</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  api.registerNavView("loom-tools", { glyph: "▣", label: "artifacts" }, host => {
    const root = createRoot(host!);
    root.render(<ToolsGallery />);
    return () => root.unmount();
  });
}
