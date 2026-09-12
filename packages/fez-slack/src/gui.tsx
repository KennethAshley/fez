import { EMPTY, parseConfig, type Config } from "./config.js";
import type { GuiExtensionAPI } from "./gui-types.js";

export default function activate(api: GuiExtensionAPI): void {
  const { client, secrets } = api, h = api.React.createElement;
  const { useState, useEffect } = api.React;
  if (!client || typeof client.agents !== "function" || typeof client.listChannels !== "function" || typeof client.extensionConfig !== "function" || typeof client.saveExtensionConfig !== "function") throw new Error("Update Fez to configure Slack channel and agent access");
  const host = client;
  function Panel(): JSX.Element {
    const [config, setConfig] = useState<Config>(EMPTY);
    const [users, setUsers] = useState("");
    const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
    const [agents, setAgents] = useState<[string, string][]>([]);
    const [bot, setBot] = useState(""), [app, setApp] = useState("");
    const [stored, setStored] = useState(false), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState(""), [error, setError] = useState("");
    useEffect(() => {
      let active = true;
      void Promise.all([host.extensionConfig("fez-slack"), host.listChannels(), secrets.has("bot_token"), secrets.has("app_token")]).then(([saved, available, hasBot, hasApp]) => {
        if (!active) return;
        const next = parseConfig(saved); setConfig(next); setUsers(next.allowedUsers.join(", "));
        setChannels(available.filter(channel => !channel.archived)); setAgents([...host.agents()]);
        setStored(hasBot && hasApp); setLoaded(true);
      }).catch(() => { if (active) setError("Could not load Slack settings. Check relay and keychain access."); });
      return () => { active = false; };
    }, []);
    async function save(): Promise<void> {
      setBusy(true); setError(""); setNotice("");
      try {
        const allowedUsers = users.split(/[\s,]+/).filter(Boolean);
        const next = parseConfig({ ...config, allowedUsers, revision: crypto.randomUUID() });
        if (config.enabled && (!next.enabled || allowedUsers.some(user => !/^[UW][A-Z0-9]+$/.test(user)) || !channels.some(channel => channel.id === next.fezChannel) || !agents.some(([key]) => key === next.worker))) throw new Error("settings");
        if (bot && !bot.trim().startsWith("xoxb-") || app && !app.trim().startsWith("xapp-")) throw new Error("tokens");
        if (config.enabled && !stored && (!bot || !app)) throw new Error("tokens");
        if (bot) await secrets.set("bot_token", bot.trim());
        if (app) await secrets.set("app_token", app.trim());
        await host.saveExtensionConfig("fez-slack", next);
        if (bot && app) setStored(true);
        setBot(""); setApp(""); setConfig(next);
        setNotice(next.enabled ? "Saved. The local Fez sentinel connects and checks access within one minute." : "Saved. Slack bridge disabled.");
      } catch { setError("Could not save. Check IDs, allowed users, selected channel and agent, tokens, and relay access."); }
      finally { setBusy(false); }
    }
    const field = (key: "teamId" | "channelId", title: string, placeholder: string) => <label style={{ display: "grid", gap: 4 }}>{title}<input value={config[key]} placeholder={placeholder} onChange={event => setConfig(previous => ({ ...previous, [key]: event.target.value }))} /></label>;
    return <section style={{ display: "grid", gap: 12, maxWidth: 560 }}>
      <p>Approved Slack users can mention your Fez app in one channel to ask the selected agent for work. Progress and results return to that Slack thread.</p>
      <fieldset disabled={!loaded || busy} style={{ display: "grid", gap: 12, border: 0, padding: 0 }}>
        {field("teamId", "Slack workspace ID", "T…")}
        {field("channelId", "Slack channel ID", "C…")}
        <label style={{ display: "grid", gap: 4 }}>Allowed Slack user IDs<input value={users} placeholder="U…, U…" onChange={event => setUsers(event.target.value)} /></label>
        <label style={{ display: "grid", gap: 4 }}>Fez channel<select value={config.fezChannel} onChange={event => setConfig(previous => ({ ...previous, fezChannel: event.target.value }))}><option value="">Choose channel</option>{channels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label>
        <label style={{ display: "grid", gap: 4 }}>Fez agent<select value={config.worker} onChange={event => setConfig(previous => ({ ...previous, worker: event.target.value }))}><option value="">Choose agent</option>{agents.map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
        <label style={{ display: "grid", gap: 4 }}>Bot token<input type="password" autoComplete="off" value={bot} placeholder={stored ? "Stored; leave blank to keep" : "xoxb-…"} onChange={event => setBot(event.target.value)} /></label>
        <label style={{ display: "grid", gap: 4 }}>App token<input type="password" autoComplete="off" value={app} placeholder={stored ? "Stored; leave blank to keep" : "xapp-…"} onChange={event => setApp(event.target.value)} /></label>
        <label><input type="checkbox" checked={config.enabled} onChange={event => setConfig(previous => ({ ...previous, enabled: event.target.checked }))} /> Enable Slack bridge</label>
        <button onClick={() => void save()}>{busy ? "Saving…" : "Save Slack settings"}</button>
      </fieldset>
      <small>Create a custom Slack app from this extension's app-manifest.json, enable Socket Mode, install it, and invite it to the selected channel. Tokens are stored in your local keychain and cannot be read back into this panel.</small>
      {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    </section>;
  }
  api.registerSettingsPanel("Slack", () => h(Panel), { source: "slack" });
}
