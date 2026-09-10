import type { GuiExtensionApi } from "@fezchat/extension-api/gui";
import type { BrowserStatus } from "./runtime.js";
import type { JSX as ReactJSX } from "react";

// Classic JSX shares the host's React; React 19's JSX types are namespaced.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Classic h factories use the global JSX type contract.
  namespace JSX {
    type Element = ReactJSX.Element;
    type IntrinsicElements = ReactJSX.IntrinsicElements;
  }
}

export default function activate(api: GuiExtensionApi) {
  const h = api.React.createElement;
  const { useState, useEffect } = api.React;
  const bin = "fez-browser";
  const job = "fez-browser-setup";

  function BrowserPanel() {
    const [status, setStatus] = useState<BrowserStatus>({ phase: "missing", message: "Checking browser setup…" });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const run = api.processes?.run;
    const agents = api.agents;

    useEffect(() => {
      if (!run || !agents) return;
      let disposed = false;
      let timer: ReturnType<typeof setTimeout>;
      async function refresh() {
        try {
          const out = await run!(bin, ["status"]);
          if (out.code !== 0) throw new Error(out.stderr.trim() || "Could not check browser setup");
          const next: BrowserStatus = JSON.parse(out.stdout);
          if (!["missing", "working", "ready", "error"].includes(next.phase) || typeof next.message !== "string") throw new Error("Unexpected browser status. Reinstall the Browser extension.");
          if (next.phase === "working" && !await agents!.isRunning(job, bin)) {
            next.phase = "error";
            next.message = "Setup stopped before finishing. Select Set up browser to retry.";
          }
          if (!disposed) setStatus(next);
        } catch (err) { if (!disposed) setError(String(err)); }
        // ponytail: one short status process per 3s while this panel is open;
        // switch to a host event if many process-backed panels need polling.
        if (!disposed) timer = setTimeout(() => void refresh(), 3_000);
      }
      void refresh();
      return () => { disposed = true; clearTimeout(timer); };
    }, [run, agents]);

    if (!run || !agents) return <p className="settings-hint">Browser needs permission to run its own program. Reinstall Browser from the extension gallery and grant that permission.</p>;

    const setup = async () => {
      setError(""); setNotice(""); setBusy(true);
      try {
        await agents.spawn(bin, { name: job, env: { FEZ_BROWSER_ACTION: "setup" } });
        setStatus({ phase: "working", message: "Starting browser setup…" });
      } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
      finally { setBusy(false); }
    };
    const test = async () => {
      setError(""); setNotice(""); setBusy(true);
      try {
        const out = await run(bin, ["test"]);
        if (out.code !== 0) throw new Error(out.stderr.trim() || "Browser test failed");
        setNotice("Browser test passed. You can ask an attached agent to browse.");
      } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
      finally { setBusy(false); }
    };
    return <div style={{ maxWidth: 560 }}>
      <p className="settings-hint">Read websites in a private browser. Set it up once; attached agents start it automatically, including after a reboot.</p>
      <p role="status" aria-live="polite"><strong>{status.phase === "ready" ? "Ready" : status.phase === "working" ? "Setting up" : status.phase === "error" ? "Needs attention" : "Setup needed"}</strong> — {status.message}</p>
      {status.phase === "error" && <p className="settings-hint">Select Set up browser to retry, or Test browser to check the existing installation.</p>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {status.phase !== "ready" && <button className="agent-action" disabled={busy || status.phase === "working"} onClick={setup}>Set up browser</button>}
        <button className="agent-action" disabled={busy || status.phase === "missing" || status.phase === "working"} onClick={test}>{busy ? "Please wait…" : "Test browser"}</button>
      </div>
      {status.phase !== "ready" && <p className="settings-hint">First setup downloads about 313 MB and can take several minutes. You can leave this panel while it runs.</p>}
      {error && <p role="alert" className="ob-error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <p className="settings-hint">To give an agent access, open its editor in Agents and select Browser in tools. Then ask it to open a website in chat.</p>
    </div>;
  }
  api.registerSettingsPanel("Browser", () => <BrowserPanel />);
}
