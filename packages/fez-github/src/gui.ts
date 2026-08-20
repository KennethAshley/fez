import type { El, GuiExtensionAPI } from "./gui-types.js";

/**
 * fez-github, GUI part — connect an account and choose repos, without a
 * terminal.
 *
 * Everything the device flow needs, a webview already has: four fetch
 * calls to github.com and a code to read aloud. The token goes to the
 * keychain through set_skill_secret, which writes the exact slot the
 * headless poller reads (`fez-skill-env` / `fez-github.token`) — so the
 * two halves share custody without either learning about the other.
 *
 * The repo list is a self-encrypted relay event, which is the only
 * reason it is editable here: a dotfile cannot be reached from a webview,
 * and that was precisely why setting this up used to mean hand-editing
 * JSON.
 *
 * h(), not JSX, so the page keeps ONE React — same reason fez-polls does.
 */

const REPO = /^[\w.-]+\/[\w.-]+$/;

interface Config {
  repos: string[];
  pollSeconds?: number;
  /**
   * Who we connected as.
   *
   * Stored because the keychain is WRITE-ONLY from the webview:
   * set_skill_secret exists, read_skill_secret does not, and
   * deliberately — nothing in a webview can read a secret back. So the
   * panel cannot ask GitHub who it is. It learns the login at the one
   * moment it holds the token, during connect, and records it. A
   * username is public; this is not a secret leaking into config.
   */
  login?: string;
}

export default function activate(api: GuiExtensionAPI): void {
  const h = api.React.createElement;
  const { useState, useEffect, useCallback } = api.React;
  const { client, secrets, openUrl } = api;

  function GitHubPanel(): El {
    const [config, setConfig] = useState<Config>({ repos: [] });
    const [connected, setConnected] = useState(false);
    const [checking, setChecking] = useState(true);
    const [clientId, setClientId] = useState("");
    const [code, setCode] = useState<{ userCode: string; url: string } | undefined>(undefined);
    const [busy, setBusy] = useState<string | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [repo, setRepo] = useState("");

    const check = useCallback(async () => {
      setChecking(true);
      const has = await secrets.has("token").catch(() => false);
      setConnected(has);
      setChecking(false);
    }, []);

    useEffect(() => {
      void check();
      void client.extensionConfig<Config>("fez-github").then((saved) => { if (saved) setConfig(saved); });
    }, []);

    async function save(next: Config): Promise<void> {
      await client.saveExtensionConfig("fez-github", next);
      setConfig(next);
    }

    async function connect(): Promise<void> {
      setError(undefined);
      const id = clientId.trim();
      if (!id) { setError("paste the App's Client ID (it starts Iv23li…)"); return; }
      setBusy("asking GitHub for a code…");
      try {
        const res = await fetch("https://github.com/login/device/code", {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: id }),
        });
        const body = (await res.json()) as Record<string, unknown>;
        if (typeof body.device_code !== "string") {
          // Device Flow is off by default and GitHub's error for it is
          // opaque, so name the fix rather than echo the payload.
          throw new Error("GitHub refused. Device Flow is OFF by default — enable it on the App's settings page.");
        }
        const url = typeof body.verification_uri === "string" ? body.verification_uri : "https://github.com/login/device";
        setCode({ userCode: String(body.user_code), url });
        setBusy("waiting for you to approve it on github.com…");
        void openUrl(url);

        let wait = typeof body.interval === "number" ? body.interval : 5;
        const deadline = Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 900) * 1000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, wait * 1000));
          const poll = await fetch("https://github.com/login/oauth/access_token", {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({
              client_id: id,
              device_code: body.device_code,
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
          });
          const t = (await poll.json()) as Record<string, unknown>;

          if (typeof t.access_token === "string") {
            const token = t.access_token;
            const expiresAt = typeof t.expires_in === "number" ? Date.now() + t.expires_in * 1000 : undefined;
            await secrets.set("client_id", id);
            await secrets.set("token", JSON.stringify({ token, expiresAt }));
            if (typeof t.refresh_token === "string") {
              await secrets.set("refresh", t.refresh_token);
            }
            // The one moment the webview holds the token: ask who this
            // is now, because it can never read it back afterwards.
            let login: string | undefined;
            try {
              const me = await fetch("https://api.github.com/user", {
                headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
              });
              if (me.ok) login = ((await me.json()) as { login?: string }).login;
            } catch { /* connected regardless; the name is decoration */ }
            await save({ ...config, login });
            setCode(undefined);
            setBusy(undefined);
            await check();
            return;
          }

          if (t.error === "authorization_pending") continue;
          // Backing off is not optional: GitHub adds time each time you
          // poll too fast, so ignoring this makes it slower, not faster.
          if (t.error === "slow_down") { wait += typeof t.interval === "number" ? t.interval : 5; continue; }
          throw new Error(t.error === "access_denied" ? "you declined the authorization" : String(t.error_description ?? t.error));
        }
        throw new Error("the code expired — try again");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setCode(undefined);
        setBusy(undefined);
      }
    }

    function addRepo(): void {
      const value = repo.trim();
      if (!REPO.test(value)) { setError(`"${value}" is not owner/name`); return; }
      if (config.repos.includes(value)) { setError(`already watching ${value}`); return; }
      setError(undefined);
      setRepo("");
      void save({ ...config, repos: [...config.repos, value] });
    }

    if (checking) return h("div", { className: "settings-hint" }, "checking…");

    if (!connected) {
      return h(
        "div",
        null,
        h(
          "div",
          { className: "settings-hint" },
          "fez reads issues and pull requests through a GitHub App you install on the repos you choose — ",
          "read-only, and a repo you don't install it on is one fez cannot see. Register it (Issues / Pull ",
          "requests / Checks → Read-only, and tick Enable Device Flow), then paste its Client ID."
        ),
        code
          ? h(
              "div",
              { className: "gh-code" },
              h("div", { className: "gh-code-value" }, code.userCode),
              h(
                "div",
                { className: "settings-hint" },
                "enter that at ",
                h("button", { className: "skill-link", onClick: () => void openUrl(code.url) }, code.url)
              )
            )
          : h(
              "div",
              { className: "find-search" },
              h("input", {
                className: "manage-input",
                placeholder: "Client ID (Iv23li…)",
                value: clientId,
                spellCheck: false,
                onChange: (e: { target: { value: string } }) => setClientId(e.target.value),
              }),
              h("button", { className: "agent-action", disabled: !!busy, onClick: () => void connect() }, "connect GitHub")
            ),
        busy ? h("div", { className: "settings-hint" }, busy) : null,
        error ? h("div", { className: "ob-error" }, error) : null
      );
    }

    return h(
      "div",
      null,
      h("div", { className: "skill-author" }, `connected as ${config.login ?? "GitHub"} · read-only`),
      h(
        "div",
        { className: "settings-hint" },
        "Each repo becomes a channel; every issue and pull request is a thread in it. Only what changes gets ",
        "posted — you won't get its history."
      ),
      ...config.repos.map((name) =>
        h(
          "div",
          { key: name, className: "skill-row" },
          h(
            "div",
            { className: "skill-main" },
            h("span", { className: "skill-name" }, name),
            h("span", { className: "skill-desc" }, `#${(name.split("/")[1] ?? name).toLowerCase()}`)
          ),
          h(
            "div",
            { className: "skill-actions" },
            h(
              "button",
              {
                className: "mini",
                title: "stop watching — the channel and everything in it stays",
                onClick: () => void save({ ...config, repos: config.repos.filter((r) => r !== name) }),
              },
              "✕"
            )
          )
        )
      ),
      h(
        "div",
        { className: "find-search" },
        h("input", {
          className: "manage-input",
          placeholder: "owner/name",
          value: repo,
          spellCheck: false,
          onChange: (e: { target: { value: string } }) => setRepo(e.target.value),
          onKeyDown: (e: { key: string }) => { if (e.key === "Enter") addRepo(); },
        }),
        h("button", { className: "mini", onClick: addRepo }, "watch")
      ),
      error ? h("div", { className: "ob-error" }, error) : null
    );
  }

  api.registerSettingsPanel("fez-github", () => h(GitHubPanel));
}
