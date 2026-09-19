import type { GuiExtensionApi } from "../../fez-extension-api/src/gui.js";
import { parseMeshState, type MeshState } from "./state.js";

/**
 * The Shared Models panel, in its own isolated webview. The model-picker entry
 * is declared in package.json (fez.modelProvider) and driven by the host through
 * this extension's CLI, so nothing here runs in the main page.
 * Settings draws the title and subtitle above this
 * (SettingsPane's `Head`), so the panel opens on its content — an h3 here
 * would repeat the page's own name back at it.
 *
 * Structure follows the app's section idiom (`.manage-section` + the hairline
 * that terminates in one live fact) rather than a bordered card, so an
 * installed extension reads as part of Fez. Anything a machine owns — the
 * hostname, the model id, a pubkey — is set in mono; every sentence is prose.
 */
export default function activate(api: GuiExtensionApi): void {
  const h = api.React.createElement;
  const { useState, useEffect } = api.React;
  const run = async (...args: string[]) => {
    if (!api.processes) throw Error("Enable the Shared Models processes permission in Extensions.");
    const result = await api.processes.run("fez-mesh", args);
    if (result.code !== 0) throw Error(result.stderr.trim() || "Shared Models could not complete that action.");
    return result.stdout;
  };
  const read = async () => parseMeshState(await run("state", "--json"));
  const shortModel = (s: MeshState) => (s.model === "fez-mini-qwen3-4b" ? "Qwen3 4B" : s.model);
  const modelName = (s: MeshState) => `${shortModel(s)} · ${s.label}`;


  const mono = { fontFamily: "var(--font-mono)", fontSize: 12 } as const;
  const indent = { marginLeft: 18 } as const;
  /** Quiet text control. `.linkish` is only styled inside `.budget`, so using
   *  that class here renders a native white button in a dark app. */
  const quiet = { background: "none", border: 0, padding: 0, font: "inherit", fontSize: 12, cursor: "pointer" } as const;

  function SharedModels() {
    const [state, setState] = useState<MeshState | undefined>(undefined);
    const [pending, setPending] = useState("Checking…");
    const [error, setError] = useState("");
    useEffect(() => {
      let active = true;
      void read().then(s => { if (active) setState(s); }, e => { if (active) setError(String(e)); })
        .finally(() => { if (active) setPending(""); });
      return () => { active = false; };
    }, []);
    const action = async (message: string, ...args: string[]) => {
      setPending(message); setError("");
      try {
        if (args.length) await run(...args);
        setState(await read());
      } catch (e) { setError(String(e)); }
      finally { setPending(""); }
    };
    const disabled = !!pending || !api.processes;
    const ready = state?.status === "ready";
    // Every sentence naming the machine reads it from the CLI, so a box that
    // is not a Mac mini is described correctly without editing this file.
    const box = state?.label ?? "the Mini";
    // The dot and the word are the one loud thing on this page; everything
    // else is quiet. Working state is yellow because it is neither yet.
    const tone = pending ? "var(--yellow)" : error ? "var(--red)" : ready ? "var(--green)" : "var(--fg-dim)";

    const section = (label: string, fact?: string) =>
      h("div", { className: "manage-section" }, label, fact ? h("span", { className: "section-fact" }, fact) : null);

    return h("section", { "aria-label": "Shared Models", style: { maxWidth: 620 } },
      h("p", { className: "settings-hint" }, "Run a model on your own hardware. Agents keep their name, instructions and tools — only the thinking moves."),
      !api.processes && h("p", { role: "alert", className: "ob-error" }, "Enable the Shared Models processes permission in Extensions."),

      // No fact on this rule: the status word sits directly beneath it, and a
      // section that ends in "ready" above a line reading "Ready" says it twice.
      section(state?.label?.toLowerCase() ?? "mini"),
      h("div", { style: { display: "flex", alignItems: "baseline", gap: 10 } },
        h("span", { "aria-hidden": true, style: { width: 8, height: 8, borderRadius: "50%", background: tone, flex: "none" } }),
        h("span", { role: "status", "aria-live": "polite", style: { fontSize: 15, fontWeight: 600, color: tone } },
          pending || (ready ? "Ready" : "Offline")),
        h("span", { style: { flex: 1 } }),
        state?.configured && h("button", {
          className: "agent-action", disabled,
          onClick: () => void action(`${ready ? "Stopping" : "Starting"} ${box}…`, ready ? "stop" : "start"),
        }, ready ? "Stop" : "Start")),
      h("div", { style: { ...mono, ...indent, color: "var(--fg-dim)", marginTop: 4 } }, state?.machine ?? "no machine configured"),
      state?.configured && h("div", { style: { ...mono, ...indent, marginTop: 2 } }, shortModel(state)),
      state?.detail && h("p", { className: "settings-hint", style: { ...indent, marginTop: 6 } }, state.detail),
      error && h("p", { role: "alert", className: "ob-error", style: indent }, error),
      state?.configured && h("p", { className: "settings-hint", style: { ...indent, marginTop: 6 } },
        `Thinking runs on ${box}. Tools and keys stay on this Mac.`),
      h("div", { style: { display: "flex", justifyContent: "flex-end" } },
        h("button", { disabled: !!pending || !api.processes, onClick: () => void action(`Checking ${box}…`),
          style: { ...quiet, color: "var(--accent)" } }, "Refresh status")),

      section("agents with access", state?.callersVerified && state.callers.length ? String(state.callers.length) : undefined),
      state && !state.callersVerified && h("p", { role: "status", className: "settings-hint" }, `Access could not be verified. Reconnect ${box} and refresh status.`),
      state?.callers.length ? h("ul", { style: { listStyle: "none", padding: 0, margin: 0 } }, ...state.callers.map((c, i) =>
        // Rules go between rows, never under the last one — a trailing rule
        // reads as the start of a section that isn't there.
        h("li", { key: c.persona, style: { display: "flex", alignItems: "center", gap: 12, padding: "7px 0",
          borderTop: i ? "1px solid var(--hairline)" : undefined } },
          h("span", { style: mono }, `@${c.persona}`),
          h("span", { style: { ...mono, color: "var(--fg-dim)" } }, `${c.pubkey.slice(0, 8)}…${c.pubkey.slice(-4)}`),
          h("span", { style: { flex: 1 } }),
          // Quiet, not a filled pill: a row of solid buttons pulls the eye away
          // from the status, and this is the one destructive control on the page.
          h("button", { disabled, style: { ...quiet, color: "var(--fg-dim)" },
            "aria-label": `Revoke access for @${c.persona}`,
            onClick: () => void action(`Revoking @${c.persona}…`, "disconnect", "--name", c.persona) }, "Revoke access"))))
        // The empty state carries the route, so nobody is told to grant access
        // without being told where. With rows present the route moves below them.
        : state?.callersVerified && h("p", { className: "settings-hint" },
          `Save this model on an agent to grant access: Agents → edit agent → model → ${state.configured ? modelName(state) : "this model"}.`),

      // With an empty list the line above already says to save the model on an
      // agent; repeating the route here would be the same instruction twice.
      state?.configured && state.callers.length > 0 && h("p", { className: "settings-hint", style: { marginTop: 16 } },
        `Grant access in Agents → edit agent → model → ${modelName(state)}. Restart a running agent to apply it.`));
  }
  api.registerSettingsPanel("Shared Models", () => h(SharedModels));
}
