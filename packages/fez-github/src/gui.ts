import { createOAuthDeviceAuth } from "@octokit/auth-oauth-device";
import { DEFAULT_CLIENT_ID, APP_INSTALL_URL, verificationUrl } from "./app-id.js";
import type { El, GuiExtensionAPI } from "./gui-types.js";

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
 * h(), not JSX, so the page keeps ONE React — same reason fez-polls does.
 */

interface Available {
  repo: string;
  private: boolean;
}

interface Config {
  repos: string[];
  pollSeconds?: number;
  login?: string;
  available?: Available[];
  triage?: string[];
}

export default function activate(api: GuiExtensionAPI): void {
  const h = api.React.createElement;
  const { useState, useEffect, useCallback } = api.React;
  const { client, secrets, openUrl } = api;

  function GitHubPanel(): El {
    const [config, setConfig] = useState<Config>({ repos: [] });
    const [connected, setConnected] = useState(false);
    const [checking, setChecking] = useState(true);
    const [code, setCode] = useState<{ userCode: string; url: string } | undefined>(undefined);
    const [busy, setBusy] = useState<string | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [copied, setCopied] = useState(false);

    const check = useCallback(async () => {
      setChecking(true);
      const has = await secrets.has("token").catch(() => false);
      setConnected(has);
      setChecking(false);
    }, []);

    const reload = useCallback(async () => {
      const saved = await client.extensionConfig<Config>("fez-github").catch(() => undefined);
      if (saved) setConfig(saved);
    }, []);

    useEffect(() => {
      void check();
      void reload();
      // The poller writes `available` on its own schedule, and this panel
      // is usually opened right after connecting — so look again shortly.
      const timer = setInterval(() => void reload(), 15_000);
      return () => clearInterval(timer);
    }, []);

    async function save(next: Config): Promise<void> {
      await client.saveExtensionConfig("fez-github", next);
      setConfig(next);
    }

    async function connect(): Promise<void> {
      setError(undefined);
      setBusy("asking GitHub for a code…");
      try {
        const auth = createOAuthDeviceAuth({
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
            void openUrl(url);
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
        await save({ ...config, login, available: available.length > 0 ? available : config.available });

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

    function toggleWatch(repo: string): void {
      const watching = config.repos.includes(repo);
      void save({
        ...config,
        repos: watching ? config.repos.filter((r) => r !== repo) : [...config.repos, repo],
        // Un-watching takes triage with it: a standing instruction with
        // nothing left to trigger it is worse than no instruction.
        triage: watching ? (config.triage ?? []).filter((r) => r !== repo) : config.triage,
      });
    }

    function toggleTriage(repo: string): void {
      const on = config.triage ?? [];
      void save({
        ...config,
        triage: on.includes(repo) ? on.filter((r) => r !== repo) : [...on, repo],
      });
    }

    if (checking) return h("div", { className: "settings-hint" }, "checking…");

    // ── not connected ────────────────────────────────────────────────
    if (!connected) {
      return h(
        "div",
        null,
        h(
          "div",
          { className: "settings-hint" },
          "fez reads issues and pull requests through a GitHub App you install on the repos you choose — ",
          "read-only, and a repo you don't install it on is one fez cannot see."
        ),
        code
          ? h(
              "div",
              { className: "gh-code" },
              h("div", { className: "gh-code-value" }, code.userCode),
              h(
                "div",
                { className: "settings-hint" },
                copied ? "copied — " : "",
                "your browser is open at ",
                h("button", { className: "skill-link", onClick: () => void openUrl(code.url) }, "github.com/login/device"),
                ". Approve there and this panel connects itself."
              )
            )
          : h(
              "button",
              { className: "agent-action", disabled: !!busy, onClick: () => void connect() },
              busy ? "connecting…" : "Connect GitHub"
            ),
        busy ? h("div", { className: "settings-hint" }, busy) : null,
        error ? h("div", { className: "ob-error" }, error) : null
      );
    }

    // ── connected ────────────────────────────────────────────────────
    const available = config.available ?? [];
    return h(
      "div",
      null,
      h("div", { className: "skill-author" }, `connected as ${config.login ?? "GitHub"} · read-only`),
      h(
        "div",
        { className: "settings-hint" },
        "Each repo you watch becomes a channel; every issue and pull request is a thread in it. ",
        "Only what changes gets posted — you won't get its history."
      ),
      available.length === 0
        ? h(
            "div",
            { className: "settings-hint" },
            "No repositories yet — the app isn't installed anywhere fez can see. ",
            h("button", { className: "skill-link", onClick: () => void openUrl(APP_INSTALL_URL) }, "Install it on a repo →"),
            " then this list fills in within a few minutes."
          )
        : available.map((row) => {
            const watching = config.repos.includes(row.repo);
            return h(
              "div",
              { key: row.repo, className: "skill-row" },
              h(
                "div",
                { className: "skill-main" },
                h(
                  "span",
                  { className: "skill-name" },
                  row.repo,
                  row.private ? h("span", { className: "role-tag", title: "private repo" }, "private") : null
                ),
                watching
                  ? h("span", { className: "skill-desc" }, `#${(row.repo.split("/")[1] ?? row.repo).toLowerCase()}`)
                  : null
              ),
              h(
                "div",
                { className: "skill-actions" },
                watching
                  ? h(
                      "button",
                      {
                        className: config.triage?.includes(row.repo) ? "mini on" : "mini",
                        title:
                          "Ask @fez who should take each NEW issue and pull request. " +
                          "Costs an orchestrator turn per item, plus whatever the agent it picks then does.",
                        onClick: () => toggleTriage(row.repo),
                      },
                      config.triage?.includes(row.repo) ? "triage on" : "triage off"
                    )
                  : null,
                h(
                  "button",
                  {
                    className: watching ? "mini" : "agent-action",
                    title: watching ? "stop watching — the channel and everything in it stays" : undefined,
                    onClick: () => toggleWatch(row.repo),
                  },
                  watching ? "watching" : "watch"
                )
              )
            );
          }),
      h(
        "div",
        { className: "settings-hint" },
        h("button", { className: "skill-link", onClick: () => void openUrl(APP_INSTALL_URL) }, "Add or remove repositories on GitHub →")
      ),
      error ? h("div", { className: "ob-error" }, error) : null
    );
  }

  api.registerSettingsPanel("fez-github", () => h(GitHubPanel));
}
