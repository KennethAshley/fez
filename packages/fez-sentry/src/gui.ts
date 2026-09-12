import { EMPTY, ORIGINS, parseConfig, type Config } from "./config.js";
import { fetchIssues } from "./sentry.js";
import type { GuiExtensionAPI, El } from "./gui-types.js";

export default function activate(api: GuiExtensionAPI): void {
  const { React, secrets, client } = api;
  if (!client || typeof client.agents !== "function" || typeof client.listChannels !== "function") throw Error("Update Fez and grant read:agents/read:channels to configure Sentry");
  const h = React.createElement;
  const projectBinding = (config: Config) => JSON.stringify([config.origin, config.organization, config.project]);
  function Panel(): El {
    const [config, setConfig] = React.useState<Config>({ ...EMPTY });
    const [validatedProject, setValidatedProject] = React.useState("");
    const [channels, setChannels] = React.useState<{ id: string; name: string; archived?: boolean }[]>([]);
    const [agents, setAgents] = React.useState<[string, string][]>([]);
    const [token, setToken] = React.useState("");
    const [connected, setConnected] = React.useState(false);
    const [loaded, setLoaded] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const [notice, setNotice] = React.useState("");
    React.useEffect(() => {
      let stopped = false;
      void Promise.all([client!.extensionConfig("fez-sentry"), client!.listChannels(), secrets.has("token")]).then(([raw, channels, connected]) => {
        if (stopped) return;
        const config = parseConfig(raw);
        setConfig(config); setValidatedProject(connected ? projectBinding(config) : ""); setChannels(channels.filter(channel => !channel.archived));
        setAgents([...client!.agents()]); setConnected(connected); setLoaded(true);
      }).catch(() => { if (!stopped) setError("Could not load Sentry settings, channels, agents or keychain status. Reopen settings to retry."); });
      return () => { stopped = true; };
    }, []);

    const edit = <K extends keyof Config>(key: K, value: Config[K]) => { setConfig(previous => ({ ...previous, [key]: value })); setNotice(""); };
    async function save(): Promise<void> {
      setError(""); setNotice(""); setBusy(true);
      let stage = "settings";
      try {
        const next = parseConfig({ ...config, revision: crypto.randomUUID() });
        if (next.enabled) {
          const available = await client!.listChannels();
          if (!available.some(channel => channel.id === next.channelId && !channel.archived)) throw Error("Choose an available destination channel");
          if (!client!.agents().has(next.worker)) throw Error("Choose an available investigation agent");
          const changedProject = projectBinding(next) !== validatedProject;
          if (!token.trim() && (!connected || changedProject)) throw Error("Paste a Sentry read token to validate this project");
          if (token.trim()) { stage = "Sentry"; await fetchIssues(next, token.trim(), api.fetch); }
        }
        if (token.trim()) {
          // Only store a token after validating it, including when saving a disabled watch.
          if (!next.enabled) throw Error("Enable and configure the watch to validate a new token");
          stage = "keychain"; await secrets.set("token", token.trim()); setToken(""); setConnected(true); setValidatedProject(projectBinding(next));
        }
        stage = "save";
        await client!.saveExtensionConfig("fez-sentry", next);
        setConfig(next);
        setNotice(next.enabled ? "Saved. The next sentinel poll establishes a baseline; only later incidents can trigger investigation." : "Sentry watch disabled.");
      } catch (error) {
        setError(stage === "keychain" ? "Could not save the Sentry token in the keychain." : stage === "save" ? "Could not save Sentry settings to the relay. Retry saving." : error instanceof Error ? error.message : "Could not validate Sentry settings.");
      } finally { setBusy(false); }
    }
    const textField = (key: "organization" | "project" | "repo", label: string, placeholder: string) => h("label", { style: { display: "grid", gap: 4 } }, label,
      h("input", { value: config[key], placeholder, disabled: !loaded || busy, onChange: (event: { target: { value: string } }) => edit(key, event.target.value) }));
    return h("section", { style: { display: "grid", gap: 12, maxWidth: 640 } },
      h("p", null, "Watch one Sentry project in one Fez channel. Each new incident opens a thread; later occurrences and status changes stay in that thread."),
      h("label", null, h("input", { type: "checkbox", checked: config.enabled, disabled: !loaded || busy, onChange: (event: { target: { checked: boolean } }) => edit("enabled", event.target.checked) }), " Enable Sentry watch"),
      h("label", { style: { display: "grid", gap: 4 } }, "Sentry region", h("select", { value: config.origin, disabled: !loaded || busy, onChange: (event: { target: { value: Config["origin"] } }) => edit("origin", event.target.value) }, ...ORIGINS.map(origin => h("option", { key: origin, value: origin }, origin)))),
      textField("organization", "Organization slug", "my-organization"), textField("project", "Project slug", "my-project"), textField("repo", "Repository", "owner/name"),
      h("label", { style: { display: "grid", gap: 4 } }, "Destination channel", h("select", { value: config.channelId, disabled: !loaded || busy, onChange: (event: { target: { value: string } }) => edit("channelId", event.target.value) }, h("option", { value: "" }, "Choose an existing channel"), ...channels.map(channel => h("option", { key: channel.id, value: channel.id }, `#${channel.name}`)))),
      h("label", { style: { display: "grid", gap: 4 } }, "Investigation agent", h("select", { value: config.worker, disabled: !loaded || busy, onChange: (event: { target: { value: string } }) => edit("worker", event.target.value) }, h("option", { value: "" }, "Choose your agent"), ...agents.map(([key, name]) => h("option", { key, value: key }, name)))),
      h("label", null, h("input", { type: "checkbox", checked: config.autoInvestigate, disabled: !loaded || busy, onChange: (event: { target: { checked: boolean } }) => edit("autoInvestigate", event.target.checked) }), " Automatically investigate new incidents and prepare draft pull requests"),
      h("p", null, "Automatic investigation uses agent turns. The agent must reproduce the issue and run checks; it may only open a draft PR in the configured repository. It never merges or deploys."),
      h("label", { style: { display: "grid", gap: 4 } }, connected ? "Replace Sentry REST read token (optional)" : "Sentry REST read token", h("input", { type: "password", value: token, autoComplete: "new-password", disabled: !loaded || busy, onChange: (event: { target: { value: string } }) => setToken(event.target.value) })),
      h("p", null, "Use a Sentry API token with project:read and event:read. This token is separate from the agent’s Sentry MCP login and is stored in the keychain. Changing the project requires re-entering it for validation."),
      h("p", null, "Polls every minute while the sentinel runs, covering the last 90 days (up to 2,000 issues). Runtime failures appear in sentinel logs as fez-sentry. Saving settings establishes a fresh baseline without automatic backlog work."),
      error ? h("p", { role: "alert" }, error) : null,
      notice ? h("p", { role: "status" }, notice) : null,
      h("button", { disabled: !loaded || busy, onClick: () => { void save(); } }, busy ? "Validating and saving…" : "Save Sentry settings"));
  }
  api.registerSettingsPanel("Sentry", () => h(Panel, null), { source: "sentry" });
}
