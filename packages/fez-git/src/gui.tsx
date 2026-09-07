import { cloneBase, cloneUrl, repoDoc, REPO_NAME } from "./repo-name.js";
import { resolveProtect, withGrant, withoutGrant } from "./policy.js";
import { lineOfRoot, makeLaneBoard } from "./board.js";
import type { GuiExtensionApi, RepoChannelLike } from "@fezchat/extension-api/gui";

/**
 * fez-git, GUI part — the repos a workspace hosts, without a terminal.
 *
 * A repo is a channel, so there is nothing new to fetch: the client has
 * already absorbed every 47101 the owner signed, and `channelsFrom`
 * filters them by what opened them. The panel reads state, not the wire.
 *
 * Buzz's web client is the reference and lands somewhere different for a
 * reason worth writing down. It reads repos from kind:30617 and refs
 * from kind:30618 — both relay-signed events — and `use-repo-refs.ts`
 * carries a live TODO admitting the refs are spoofable, because the
 * client cannot yet check which key signed them. fez cannot copy that
 * shape at all: the relay holds no key (RelayExtensionAPI has no
 * publish). What it has instead is better on both counts — a repo is an
 * OWNER-signed channel, and the refs come from the git transport, which
 * is the actual state rather than an assertion about it.
 *
 * JSX with `--jsx-factory=h` (the shared-React shape): markup reads as
 * markup, compiles to the same host-React createElement calls — the
 * page keeps ONE React, same reason fez-polls and fez-github do it.
 */

/** What a repo channel's meta says, read back. */
interface Repo {
  channelId: string;
  name: string;
  repo: string;
  clone: string;
  protect: string;
  /** The channel's full meta, carried so edits never drop fields (upstream). */
  meta?: Record<string, string>;
}

function readRepo(channel: RepoChannelLike, base: string | undefined): Repo {
  const repo = channel.meta?.repo ?? channel.name;
  return {
    channelId: channel.id,
    name: channel.name,
    meta: channel.meta,
    repo,
    // The channel carries the clone URL so a client never has to rebuild
    // one; the advertised base is the fallback for a channel opened
    // before that was written.
    clone: channel.meta?.clone ?? (base ? cloneUrl(base, repo) : ""),
    protect: channel.meta?.protect ?? "main",
  };
}

export default function activate(api: GuiExtensionApi): void {
  const h = api.React.createElement;
  const { useState, useEffect, useCallback } = api.React;
  const { client } = api;

  // A linked extension meets whatever host is installed. The mirror
  // conformance eval proves this compiles against TODAY'S desktop; it
  // cannot prove the desktop on disk is today's. A missing seam must
  // say so — a render that throws is a blank card with no clue in it.
  if (
    typeof client?.relayInfo !== "function" ||
    typeof client?.channelsFrom !== "function" ||
    typeof client?.ensureChannel !== "function"
  ) {
    api.registerSettingsPanel(
      "Repos",
      () => (
        <div className="ext-panel">
          <p>This fez-desktop build is older than the fez-git extension.</p>
          <p className="dim">Rebuild and reinstall the app (packages/fez-desktop), then reopen this panel.</p>
        </div>
      ),
      { source: "fez-git" }
    );
    return;
  }

  /** The advertised git base, or undefined when this relay serves none. */
  const base = (): string | undefined => cloneBase(client.relayInfo());

  function ReposPanel(): JSX.Element {
    const [repos, setRepos] = useState<Repo[]>(() =>
      client.channelsFrom("fez-git").map((c) => readRepo(c, base()))
    );
    const [name, setName] = useState("");
    const [bringUrl, setBringUrl] = useState("");
    const [busy, setBusy] = useState<string | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [editing, setEditing] = useState<string | undefined>(undefined);
    const [draft, setDraft] = useState("");
    const [copied, setCopied] = useState<string | undefined>(undefined);
    /** The repo just created — its "what now" card stays up until dismissed. */
    const [created, setCreated] = useState<Repo | undefined>(undefined);
    const [assigning, setAssigning] = useState<string | undefined>(undefined);
    const [personaNames, setPersonaNames] = useState<string[]>([]);
    const [assigned, setAssigned] = useState<string | undefined>(undefined);

    const gitBase = base();
    const isOwner = client.relayInfo()?.pubkey === client.pubkey;

    const reload = useCallback(() => {
      setRepos(client.channelsFrom("fez-git").map((c) => readRepo(c, base())));
    }, []);

    useEffect(() => {
      reload();
      if (api.personas) void api.personas.list().then(setPersonaNames).catch(() => {});
      return client.on("channelsChanged", reload);
    }, []);

    /**
     * Put an agent on a repo: write `repo:` into its persona and roster
     * its stable key. The one-click version of the copy-snippet flow —
     * through the host's personas seam, so this extension never touches
     * a file and the permission dialog said so at install.
     */
    async function assignAgent(repo: Repo, persona: string): Promise<void> {
      if (!api.personas) return;
      setBusy(`assign:${repo.channelId}`);
      setError(undefined);
      try {
        const raw = await api.personas.read(persona);
        const next = raw.match(/^---\r?\n[\s\S]*?\r?\n---/)
          ? raw.replace(/^(---\r?\n[\s\S]*?)(\r?\n---)/, (_m, head: string, tail: string) => {
              const cleaned = head
                .split(/\r?\n/)
                .filter((line) => !/^repo:\s/.test(line))
                .join("\n");
              return `${cleaned}\nrepo: ${repo.repo}${tail}`;
            })
          : `---\nrepo: ${repo.repo}\n---\n\n${raw}`;
        await api.personas.update(persona, next);
        await api.personas.invite(persona);
        setAssigned(`@${persona} → ${repo.repo}`);
        setAssigning(undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(undefined);
      }
    }

    const copy = (key: string, text: string) => {
      // tsconfig has no DOM lib — this file compiles in a node package
      // but runs in the webview, where clipboard exists.
      void (navigator as { clipboard?: { writeText(t: string): Promise<void> } }).clipboard?.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(undefined), 1500);
    };
    /**
     * Layout ONLY — manage-input assumes a flex parent, so widths need
     * stating here. Colors are deliberately NOT: the class already
     * paints the input's background/border from theme variables, and an
     * inline override was how this panel briefly shipped inputs painted
     * in the panel's own background — i.e. invisible.
     */
    const inputStyle = {
      width: "100%",
      boxSizing: "border-box",
      display: "block",
    } as const;

    /** key identifies WHICH button flashed; label is what people read. */
    const copyButton = (key: string, label: string, text: string) => (
      <button className="skill-link" onClick={() => copy(key, text)}>
        {copied === key ? "copied ✓" : label}
      </button>
    );

    /** The two hand-offs a repo has: agents work it, people clone it. */
    const personaSnippet = (repo: Repo) => `repo: ${repo.repo}\n# optional — fence the agent into a directory:\n# scope: [packages/thing]`;
    const cloneSnippet = (repo: Repo) => `git clone ${repo.clone}`;
    /** The GUI cannot clone or push; the terminal can. Hand over the exact command. */
    const adoptCommand = bringUrl.trim() ? `~/.fez/bin/fez-adopt ${bringUrl.trim()}` : "~/.fez/bin/fez-adopt";

    async function create(): Promise<void> {
      const wanted = name.trim();
      if (!REPO_NAME.test(wanted)) {
        setError(`"${wanted}" is not a repo name — letters, digits, dot, dash, underscore`);
        return;
      }
      if (!gitBase) return;
      setBusy("create");
      setError(undefined);
      try {
        const spec = {
          name: wanted.toLowerCase(),
          source: "fez-git",
          meta: { repo: wanted, clone: cloneUrl(gitBase, wanted), protect: "main" },
        };
        const id = await client.ensureChannel(spec);
        if (!id) setError("only the workspace owner can open a channel here");
        else {
          setName("");
          setCreated({ channelId: id, name: spec.name, repo: wanted, clone: spec.meta.clone, protect: "main" });
          // The repo's front page, once — never clobber a doc the room
          // has been editing (re-creating an existing name reuses the
          // channel, and its doc belongs to the room by then).
          if (!client.docsByChannel().get(id)?.latestContent?.trim()) {
            await client.publishDoc(id, repoDoc(wanted, spec.meta.clone)).catch(() => {});
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(undefined);
        reload();
      }
    }

    async function saveProtect(repo: Repo): Promise<void> {
      const next = draft.trim() || "none";
      setBusy(repo.channelId);
      setError(undefined);
      try {
        const id = await client.ensureChannel({
          name: repo.name,
          source: "fez-git",
          meta: { ...repo.meta, repo: repo.repo, clone: repo.clone, protect: next },
        });
        if (!id) setError("only the workspace owner can change this");
        else setEditing(undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(undefined);
        reload();
      }
    }

    if (!gitBase) {
      return (
        <div>
          <div className="manage-section">no git server</div>
          <p className="settings-hint">This relay does not advertise one.</p>
          <p className="settings-hint">
            Install <code>@fezchat/git</code> on the relay and start it with{" "}
            <code>--extensions --origin https://your-relay</code>. The origin is what it publishes as the clone URL,
            so it has to be the address clients actually reach.
          </p>
        </div>
      );
    }

    /** "What now" — a repo exists; here are its two hand-offs. */
    const nextSteps = (repo: Repo, dismiss: () => void) => (
      <div className="skill-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span className="skill-name">{`#${repo.name} is ready`}</span>
          <button className="skill-link" onClick={dismiss}>
            done
          </button>
        </div>
        <div className="skill-desc">
          Put an agent on it — add <code>{`repo: ${repo.repo}`}</code> to a persona{" "}
          {copyButton(`persona:${repo.repo}`, "copy snippet", personaSnippet(repo))}
        </div>
        <div className="skill-desc">
          …or work on it yourself: <code>{cloneSnippet(repo)}</code> {copyButton(`clone:${repo.repo}`, "copy", cloneSnippet(repo))}
        </div>
        <div className="skill-desc">
          main is protected — agents push their own branches, every branch becomes a thread in #{repo.name}, merging
          is yours.
        </div>
      </div>
    );

    const repoRow = (repo: Repo) => (
      <div key={repo.channelId} className="skill-row">
        <div className="skill-main">
          <span className="skill-name">{`#${repo.name}`}</span>
          <div className="skill-desc">
            <code>{repo.clone}</code>
            {repo.meta?.upstream ? ` · from ${repo.meta.upstream.replace(/^https?:\/\//, "")}` : null}
          </div>
          {editing === repo.channelId ? (
            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              <input
                className="manage-input"
                style={inputStyle}
                value={draft}
                placeholder="main release/*  —  or none"
                onChange={(e: { target: { value: string } }) => setDraft(e.target.value)}
                onKeyDown={(e: { key: string }) => {
                  if (e.key === "Enter") void saveProtect(repo);
                  if (e.key === "Escape") setEditing(undefined);
                }}
              />
              <button className="agent-action" disabled={busy === repo.channelId} onClick={() => void saveProtect(repo)}>
                save
              </button>
              <button className="agent-action" onClick={() => setEditing(undefined)}>
                cancel
              </button>
            </div>
          ) : (
            <div className="skill-desc">
              {resolveProtect(repo.protect).length === 0
                ? "protects nothing — any roster member can push any ref"
                : `protects ${resolveProtect(repo.protect).join(", ")} — owners and admins only, fast-forward only`}
              {isOwner ? (
                <button
                  className="skill-link"
                  onClick={() => {
                    setEditing(repo.channelId);
                    setDraft(repo.protect);
                  }}
                >
                  change
                </button>
              ) : null}
            </div>
          )}
        </div>
        <div className="skill-actions">
          {api.personas && personaNames.length > 0 ? (
            assigning === repo.channelId ? (
              <span>
                {personaNames.map((name) => (
                  <button
                    key={name}
                    className="skill-link"
                    disabled={busy === `assign:${repo.channelId}`}
                    onClick={() => void assignAgent(repo, name)}
                  >
                    {`@${name}`}
                  </button>
                ))}
                <button className="skill-link" onClick={() => setAssigning(undefined)}>
                  cancel
                </button>
              </span>
            ) : (
              <button className="skill-link" onClick={() => setAssigning(repo.channelId)}>
                put an agent on it
              </button>
            )
          ) : null}
          {copyButton(`clone:${repo.repo}`, "clone", cloneSnippet(repo))}
          {copyButton(`persona:${repo.repo}`, "persona", personaSnippet(repo))}
        </div>
      </div>
    );

    return (
      <div>
        {error ? <p className="ob-error">{error}</p> : null}
        {assigned ? (
          <p className="settings-hint">
            {`✓ ${assigned} — on the roster; mention it in the repo's channel to wake it. `}
            <button className="skill-link" onClick={() => setAssigned(undefined)}>
              ok
            </button>
          </p>
        ) : null}
        {created ? nextSteps(created, () => setCreated(undefined)) : null}

        {repos.length > 0 ? <div className="manage-section">repos</div> : null}
        {repos.map(repoRow)}

        {isOwner ? (
          <div>
            <div className="manage-section">start a new project</div>
            <p className="settings-hint">
              Opens the repo's channel now; the repository appears on the first push — an agent can make the first
              commit into an empty repo.
            </p>
            <div className="settings-field" style={{ display: "flex", gap: 6 }}>
              <input
                className="manage-input"
                style={inputStyle}
                value={name}
                placeholder="repo name"
                spellCheck={false}
                onChange={(e: { target: { value: string } }) => setName(e.target.value)}
                onKeyDown={(e: { key: string }) => {
                  if (e.key === "Enter") void create();
                }}
              />
              <button className="agent-action" disabled={!name.trim() || busy === "create"} onClick={() => void create()}>
                {busy === "create" ? "opening…" : "create"}
              </button>
            </div>

            <div className="manage-section">bring an existing project</div>
            <p className="settings-hint">
              Works for code on your disk or a GitHub URL. One command opens the channel, adds a <code>fez</code>{" "}
              remote and pushes — GitHub (origin) is untouched and stays where you publish.
            </p>
            <input
              className="manage-input"
              style={inputStyle}
              value={bringUrl}
              placeholder="https://github.com/owner/repo  (optional — blank = the repo you are in)"
              spellCheck={false}
              onChange={(e: { target: { value: string } }) => setBringUrl(e.target.value)}
            />
            <p className="settings-hint">
              Run in your terminal{bringUrl.trim() ? "" : ", inside the project"}: <code>{adoptCommand}</code>{" "}
              {copyButton("adopt", "copy", adoptCommand)}
            </p>
          </div>
        ) : (
          <p className="settings-hint">Only the workspace owner can open repos or change protection.</p>
        )}
      </div>
    );
  }

  api.registerSettingsPanel("Repos", () => <ReposPanel />, { source: "fez-git" });

  // Every ⑂ thread gets the lane board above its replies — the line's
  // lanes as live rows (journal-backed), each with watch/diff/merge.
  // Guarded like the panel: an older host without the seam just skips it.
  if (typeof api.registerThreadView === "function") {
    const LaneBoard = makeLaneBoard(api);
    api.registerThreadView(
      "lanes",
      (rootContent) => lineOfRoot(rootContent) !== undefined,
      (props) => <LaneBoard {...props} />
    );
  }

  // The channel-level hop of the tree: every ⑂ root in the channel gets
  // a live chip — how many lanes, who's working — and the walk down.
  // Client-side facts only (stub replies + workingAgents), no fetch:
  // this renders once per visible root.
  if (typeof api.registerMessageDecorator === "function" && typeof api.openThread === "function") {
    api.registerMessageDecorator(
      (content) => lineOfRoot(content) !== undefined,
      ({ content: _content, msgId, channelId }) => {
        const stubs = client
          .threadReplies(channelId, msgId)
          .filter((reply) => reply.content.startsWith("↳ "));
        const agents = stubs
          .map((reply) => reply.content.match(/`([^`/]+)\//)?.[1])
          .filter((name): name is string => !!name);
        const working = client.workingAgents();
        const busy = agents.filter((name) => working.has(name));
        return (
          <div className="line-chip">
            <span className="skill-desc">
              {stubs.length === 0 ? "no lanes yet" : `${stubs.length} lane(s)${busy.length ? ` · ⚙ ${busy.join(", ")}` : ""}`}
            </span>
            <button className="skill-link" onClick={() => api.openThread(channelId, msgId)}>
              open the board →
            </button>
          </div>
        );
      }
    );
  }

  /**
   * The TUI's `/repo`, desktop-shaped. Same verbs, same answers — muscle
   * memory should not depend on which window you are in.
   */
  api.registerGuiCommand("repo", async (args: string): Promise<string> => {
    const gitBase = base();
    if (!gitBase) return "⑂ this relay does not advertise a git server.";
    const [verb, value, ...rest] = args.trim().split(/\s+/);
    const repos = client.channelsFrom("fez-git").map((c) => readRepo(c, gitBase));

    if (verb === "new" && value) {
      if (!REPO_NAME.test(value)) return `⑂ "${value}" is not a repo name`;
      const id = await client.ensureChannel({
        name: value.toLowerCase(),
        source: "fez-git",
        meta: { repo: value, clone: cloneUrl(gitBase, value), protect: "main" },
      });
      return id
        ? `⑂ **#${value.toLowerCase()}** is open — \`git remote add origin ${cloneUrl(gitBase, value)}\`. \`main\` is protected.`
        : "⑂ only the workspace owner can open a channel here";
    }

    /**
     * Open a LINE — the same contract as the headless /repo branch: a
     * message whose text carries the branch's root marker, posted into
     * the repo's channel (wherever this command was typed). The two
     * surfaces drifting apart is exactly how "/repo branch" silently
     * fell through to the repo list in the desktop once already.
     */
    if (verb === "branch" && value) {
      const line = rest[0]?.trim();
      if (!line) return `⑂ /repo branch ${value} <line>  —  e.g. /repo branch ${value} feat-auth`;
      if (!/^[a-z0-9][\w.-]{0,60}$/i.test(line) || line.includes("/")) {
        return `⑂ "${line}" is not a line name — letters, digits, dot, dash (no slashes: lines are top-level)`;
      }
      const existing = repos.find((r) => r.repo === value || r.name === value.toLowerCase());
      if (!existing) return `⑂ no repo called "${value}" here`;
      await client.sendChannelMessage(
        `⑂ \`${line}\` — line opened. Mention an agent in this thread to put it to work here; its branch will appear as \`<agent>/${line}\`.`,
        { channelId: existing.channelId }
      );
      return `⑂ line \`${line}\` opened in #${existing.name} — open its thread for the lane board`;
    }

    /** Merge — the endpoint the lane board's button calls, as a command. */
    if (verb === "merge" && value) {
      const branch = rest[0]?.trim();
      if (!branch) return `⑂ /repo merge ${value} <branch> [into]`;
      const existing = repos.find((r) => r.repo === value || r.name === value.toLowerCase());
      if (!existing) return `⑂ no repo called "${value}" here`;
      const signUrl = `${gitBase}/${existing.repo}.git/fez-merge`;
      const header = await client.httpAuthHeader(signUrl, "POST");
      if (!header) return "⑂ this client cannot sign requests — merge from the TUI instead";
      const into = rest[1]?.trim();
      const res = await fetch(`${signUrl}?branch=${encodeURIComponent(branch)}${into ? `&into=${encodeURIComponent(into)}` : ""}`, {
        method: "POST",
        headers: { Authorization: header },
      }).catch(() => undefined);
      const body = (await res?.json().catch(() => undefined)) as { merged?: boolean; sha?: string; reason?: string } | undefined;
      if (body?.merged) return `⑂ merged \`${branch}\` → \`${body.sha?.slice(0, 8)}\`${body.reason ? ` (${body.reason})` : ""}`;
      return `⑂ not merged: ${body?.reason ?? `relay answered ${res?.status ?? "nothing"}`}`;
    }

    /**
     * Grant or revoke a STRANGER's access to one repo — the same
     * owner-signed, latest-wins channel meta the headless verb writes
     * (spec 2026-09-04). Parity is pinned by git-command-parity.test.
     */
    if ((verb === "grant" || verb === "revoke") && value) {
      const existing = repos.find((r) => r.repo === value || r.name === value.toLowerCase());
      if (!existing) return `⑂ no repo called "${value}" here — /repo new ${value}`;
      const pk = rest[0]?.trim().toLowerCase() ?? "";
      if (!/^[0-9a-f]{64}$/.test(pk)) {
        return `⑂ /repo ${verb} ${existing.repo} <64-hex pubkey>${verb === "grant" ? " [hours]" : ""} — the worker's key, from its bazaar record`;
      }
      const nowS = Math.floor(Date.now() / 1000);
      let grants: string;
      let told: string;
      if (verb === "grant") {
        const hours = rest[1] ? Number(rest[1]) : 72;
        if (!(hours > 0) || hours > 24 * 30) return "⑂ hours must be between 0 and 720 — a hire has a deadline, not a tenure";
        const expiresS = nowS + Math.round(hours * 3600);
        grants = withGrant(existing.meta?.grants, pk, expiresS, nowS);
        told = `⑂ **${existing.repo}**: ${pk.slice(0, 8)} may clone and push until ${new Date(expiresS * 1000).toLocaleString()} — hand it \`${existing.clone}\`. Protected refs stay owner-only; the grant expires on its own.`;
      } else {
        grants = withoutGrant(existing.meta?.grants, pk, nowS);
        told = `⑂ **${existing.repo}**: ${pk.slice(0, 8)}'s grant is revoked.`;
      }
      const carry = { ...existing.meta, repo: existing.repo, clone: existing.clone, protect: existing.protect } as Record<string, string>;
      if (grants) carry.grants = grants;
      else delete carry.grants;
      const id = await client.ensureChannel({ name: existing.name, source: "fez-git", meta: carry });
      return id ? told : "⑂ only the workspace owner can change this";
    }

    if (verb === "protect" && value) {
      const refs = rest.join(" ").trim();
      if (!refs) return `⑂ /repo protect ${value} main release/*  —  or \`none\``;
      const existing = repos.find((r) => r.repo === value || r.name === value.toLowerCase());
      if (!existing) return `⑂ no repo called "${value}" here`;
      const id = await client.ensureChannel({
        name: existing.name,
        source: "fez-git",
        // carry meta through — see headless openRepoChannel (F2)
        meta: { ...existing.meta, repo: existing.repo, clone: existing.clone, protect: refs },
      });
      return id ? `⑂ **${existing.repo}** protects ${refs}` : "⑂ only the workspace owner can change this";
    }

    if (repos.length === 0) return "⑂ no repos yet — /repo new <name>";
    return `⑂ repos here:\n${repos.map((r) => `  #${r.name} — ${r.clone}\n      protects ${r.protect}`).join("\n")}`;
  });
}
