import { request as octokitRequest } from "@octokit/request";
import { createOAuthDeviceAuth } from "@octokit/auth-oauth-device";
import { DEFAULT_CLIENT_ID, APP_INSTALL_URL, verificationUrl } from "./app-id.js";
import { parseConfig, destinationFor, type Config, type DestinationChannel } from "./config.js";
import type { GuiExtensionAPI } from "./gui-types.js";

/**
 * fez-github, GUI part — connect an account and pick repos, without a
 * terminal.
 *
 * Connecting is one button. It used to be "register your own GitHub
 * App, enable Device Flow, paste its Client ID", which is a setup guide
 * wearing a settings panel's clothes. fez has its own App now and its
 * client ID is public by design (app-id.ts), so the panel asks GitHub
 * for a code, opens the browser with that code already filled in, and
 * waits — the person clicks Continue and the panel flips itself to
 * connected.
 *
 * The device flow is @octokit/auth-oauth-device, the same package the
 * headless half uses. It is isomorphic, so the polling, the `slow_down`
 * backoff and the expiry are one implementation rather than two that
 * drift — which is exactly what happened to mentions earlier in this
 * codebase.
 *
 * The token goes to the keychain through set_skill_secret, which writes
 * the very slot the poller reads (`fez-skill-env` / `fez-github.token`),
 * so the two halves share custody without either knowing about the
 * other.
 *
 * JSX with `--jsx-factory=h` (the shared-React shape): markup reads as
 * markup, compiles to the same host-React createElement calls — the
 * page keeps ONE React, same reason fez-polls does.
 */

type Available = NonNullable<Config["available"]>[number];

export default function activate(api: GuiExtensionAPI): void {
  const h = api.React.createElement;
  const { useState, useEffect, useCallback } = api.React;
  if (!api.client) throw new Error("fez-github needs read:channels permission");
  const { client, secrets, openUrl, fetch } = api;
  if (typeof client.listChannels !== "function" || typeof client.createChannel !== "function") {
    throw new Error("Update Fez to choose GitHub destination channels");
  }

  function GitHubPanel(): JSX.Element {
    const [config, setConfig] = useState<Config>({ repos: [] });
    const [channels, setChannels] = useState<DestinationChannel[]>([]);
    const [destinations, setDestinations] = useState<Record<string, string>>({});
    const [newNames, setNewNames] = useState<Record<string, string>>({});
    const [loaded, setLoaded] = useState(false);
    const [connected, setConnected] = useState(false);
    const [checking, setChecking] = useState(true);
    const [code, setCode] = useState<{ userCode: string; url: string } | undefined>(undefined);
    const [busy, setBusy] = useState<string | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [copied, setCopied] = useState(false);

    const check = useCallback(async () => {
      setChecking(true);
      try { setConnected(await secrets.has("token")); }
      catch (error) { setError(current => current ?? String(error)); }
      finally { setChecking(false); }
    }, []);

    const reload = useCallback(async () => {
      try {
        const [saved, channels] = await Promise.all([client.extensionConfig("fez-github"), client.listChannels()]);
        setConfig(parseConfig(saved));
        setChannels(channels);
        setLoaded(true);
      } catch (err) { setError(current => current ?? String(err)); }
    }, []);

    useEffect(() => {
      void check();
    }, [check]);

    useEffect(() => {
      if (busy) return;
      void reload();
      // The poller writes `available` on its own schedule, and this panel
      // is usually opened right after connecting — so look again shortly.
      const timer = setInterval(() => void reload(), 15_000);
      return () => clearInterval(timer);
    }, [busy]);

    async function save(next: Config): Promise<void> {
      await client.saveExtensionConfig("fez-github", next);
      setConfig(next);
    }

    function openLink(url: string): void {
      void openUrl(url).catch(error => setError(String(error)));
    }

    async function connect(): Promise<void> {
      setError(undefined);
      setBusy("asking GitHub for a code…");
      try {
        const auth = createOAuthDeviceAuth({
          request: octokitRequest.defaults({ request: { fetch } }),
          clientType: "github-app",
          clientId: DEFAULT_CLIENT_ID,
          onVerification: (v) => {
            const url = verificationUrl({ userCode: v.user_code, verificationUri: v.verification_uri });
            setCode({ userCode: v.user_code, url });
            setBusy("waiting for you to approve it on github.com…");
            // Clipboard as well as the prefilled URL: if GitHub ever
            // stops honouring ?user_code=, the code is already on the
            // clipboard rather than being something to retype by eye.
            const clipboard = (globalThis as { navigator?: { clipboard?: { writeText(t: string): Promise<void> } } })
              .navigator?.clipboard;
            void clipboard?.writeText(v.user_code).then(
              () => setCopied(true),
              () => setCopied(false)
            );
            openLink(url);
          },
        });

        const result = (await auth({ type: "oauth" })) as {
          token: string;
          refreshToken?: string;
          expiresAt?: string;
        };

        await secrets.set("client_id", DEFAULT_CLIENT_ID);
        await secrets.set(
          "token",
          JSON.stringify({
            token: result.token,
            expiresAt: result.expiresAt ? Date.parse(result.expiresAt) : undefined,
          })
        );
        if (result.refreshToken) await secrets.set("refresh", result.refreshToken);

        // The one moment the webview holds a token: ask who this is, and
        // what the App can see. It can never read the token back
        // afterwards — set_skill_secret has no counterpart, deliberately
        // — so anything the panel needs later has to be learned now and
        // written to config.
        setBusy("reading your installations…");
        const [login, available] = await Promise.all([whoAmI(result.token), listRepos(result.token)]);
        await save({ ...parseConfig(await client.extensionConfig("fez-github")), login, available: available.length > 0 ? available : config.available });

        setCode(undefined);
        setBusy(undefined);
        await check();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setCode(undefined);
        setBusy(undefined);
      }
    }

    async function whoAmI(token: string): Promise<string | undefined> {
      try {
        const res = await fetch("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        });
        if (!res.ok) return undefined;
        return ((await res.json()) as { login?: string }).login;
      } catch {
        return undefined; // connected regardless; the name is decoration
      }
    }

    /** What the App is installed on — the only repos fez can actually read. */
    async function listRepos(token: string): Promise<Available[]> {
      const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
      try {
        const res = await fetch("https://api.github.com/user/installations?per_page=100", { headers });
        if (!res.ok) return [];
        const { installations = [] } = (await res.json()) as { installations?: { id: number }[] };
        const out: Available[] = [];
        for (const install of installations) {
          const page = await fetch(
            `https://api.github.com/user/installations/${install.id}/repositories?per_page=100`,
            { headers }
          );
          if (!page.ok) continue;
          const { repositories = [] } = (await page.json()) as {
            repositories?: { full_name: string; private: boolean }[];
          };
          for (const repo of repositories) out.push({ repo: repo.full_name, private: repo.private });
        }
        return out.sort((a, b) => a.repo.localeCompare(b.repo));
      } catch {
        return [];
      }
    }

    async function changeWatch(repo: string, stop = false): Promise<void> {
      setBusy("saving…");
      setError(undefined);
      try {
        const latest = parseConfig(await client.extensionConfig("fez-github"));
        const channelIds = { ...latest.channelIds };
        if (stop) {
          delete channelIds[repo];
          await save({ ...latest, channelIds, repos: latest.repos.filter(r => r !== repo), triage: (latest.triage ?? []).filter(r => r !== repo) });
        } else {
          let id = destinations[repo] ?? destinationFor(latest, repo, channels)?.id;
          if (id === "__new__") {
            const name = newNames[repo]?.trim();
            if (!name) throw new Error("Enter a name for the new channel");
            id = await client.createChannel(name);
            // If saving the watch fails, retry with this channel instead of creating another.
            setChannels(rows => [...rows, { id: id!, name }]);
            setDestinations(rows => ({ ...rows, [repo]: id! }));
          } else if (!id || !(await client.listChannels()).some(channel => channel.id === id)) {
            throw new Error("Choose an available destination channel");
          }
          await save({ ...latest, repos: [...new Set([...latest.repos, repo])], channelIds: { ...channelIds, [repo]: id } });
        }
      } catch (err) { setError(String(err)); }
      finally { setBusy(undefined); }
    }

    async function toggleTriage(repo: string): Promise<void> {
      setBusy("saving…");
      setError(undefined);
      try {
        const latest = parseConfig(await client.extensionConfig("fez-github"));
        const on = latest.triage ?? [];
        await save({ ...latest, triage: on.includes(repo) ? on.filter(r => r !== repo) : [...on, repo] });
      } catch (err) { setError(String(err)); }
      finally { setBusy(undefined); }
    }

    if (checking && !connected) return <div className="settings-hint">checking…</div>;

    // ── not connected ────────────────────────────────────────────────
    if (!connected) {
      return (
        <div>
          <div className="settings-hint">
            fez reads issues and pull requests through a GitHub App you install on the repos you choose — read-only,
            and a repo you don't install it on is one fez cannot see.
          </div>
          {code ? (
            <div className="gh-code">
              <div className="gh-code-value">{code.userCode}</div>
              <div className="settings-hint">
                {copied ? "copied — " : ""}
                your browser is open at{" "}
                <button className="skill-link" onClick={() => openLink(code.url)}>
                  github.com/login/device
                </button>
                . Approve there and this panel connects itself.
              </div>
            </div>
          ) : (
            <button className="agent-action" disabled={!!busy} onClick={() => void connect()}>
              {busy ? "connecting…" : "Connect GitHub"}
            </button>
          )}
          {busy ? <div className="settings-hint">{busy}</div> : null}
          {error ? <div className="ob-error" role="alert">{error}</div> : null}
        </div>
      );
    }

    // ── connected ────────────────────────────────────────────────────
    const available = [...(config.available ?? [])];
    for (const repo of config.repos) {
      if (!available.some(row => row.repo === repo)) available.push({ repo, private: false });
    }
    return (
      <div>
        <div className="skill-author">{`connected as ${config.login ?? "GitHub"} · read-only`}</div>
        <div className="settings-hint">
          Choose a channel for each repository, or create one. Issue and pull request updates appear in threads
          there. Only new activity is posted; existing messages stay where they are.
        </div>
        {available.length === 0 ? (
          <div className="settings-hint">
            No repositories yet — the app isn't installed anywhere fez can see.{" "}
            <button className="skill-link" onClick={() => openLink(APP_INSTALL_URL)}>
              Install it on a repo →
            </button>{" "}
            then this list fills in within a few minutes.
          </div>
        ) : (
          available.map((row) => {
            const watching = config.repos.includes(row.repo);
            const current = destinationFor(config, row.repo, channels);
            const selected = destinations[row.repo] ?? current?.id ?? "";
            const changed = selected !== current?.id;
            return (
              <div key={row.repo} className="skill-row">
                <div className="skill-main">
                  <span className="skill-name">
                    {row.repo}
                    {row.private ? (
                      <span className="role-tag" title="private repo">
                        private
                      </span>
                    ) : null}
                  </span>
                  {watching ? (
                    <span className="skill-desc">{current ? `Posting to #${current.name}` : "Choose a destination to resume updates"}</span>
                  ) : null}
                </div>
                <div className="skill-actions" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <select aria-label={`Channel for ${row.repo}`} value={selected} disabled={!!busy || !loaded}
                    onChange={(event: { target: { value: string } }) => setDestinations(rows => ({ ...rows, [row.repo]: event.target.value }))}>
                    <option value="">Choose a channel…</option>
                    {channels.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}{channels.filter(c => c.name === channel.name).length > 1 ? ` (${channel.id.slice(0, 8)})` : ""}</option>)}
                    <option value="__new__">Create a new channel…</option>
                  </select>
                  {selected === "__new__" ? <input aria-label={`New channel name for ${row.repo}`} placeholder="Channel name" maxLength={256}
                    value={newNames[row.repo] ?? ""} disabled={!!busy}
                    onChange={(event: { target: { value: string } }) => setNewNames(rows => ({ ...rows, [row.repo]: event.target.value }))} /> : null}
                  {(!watching || changed) ? <button className="agent-action" disabled={!!busy || !loaded || !selected || (selected === "__new__" && !newNames[row.repo]?.trim())}
                    onClick={() => void changeWatch(row.repo)}>{watching ? "Save channel" : "watch"}</button> : null}
                  {watching ? (
                    <button
                      className={config.triage?.includes(row.repo) ? "mini on" : "mini"}
                      title={
                        "Ask @fez who should take each NEW issue and pull request. " +
                        "Costs an orchestrator turn per item, plus whatever the agent it picks then does."
                      }
                      disabled={!!busy || !current}
                      onClick={() => void toggleTriage(row.repo)}
                    >
                      {config.triage?.includes(row.repo) ? "triage on" : "triage off"}
                    </button>
                  ) : null}
                  {watching ? <button className="mini" disabled={!!busy}
                    title="stop watching — the channel and everything in it stays"
                    onClick={() => void changeWatch(row.repo, true)}>Stop watching</button> : null}
                </div>
              </div>
            );
          })
        )}
        <div className="settings-hint">
          <button className="skill-link" onClick={() => openLink(APP_INSTALL_URL)}>
            Add or remove repositories on GitHub →
          </button>
        </div>
        {error ? <div className="ob-error" role="alert">{error}</div> : null}
      </div>
    );
  }

  api.registerSettingsPanel("fez-github", () => <GitHubPanel />);
}
