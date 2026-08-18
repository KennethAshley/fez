import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { FezClient, WireEvent } from "@fez/client";
import type { BrowserWire } from "./wire";
import Avatar from "./Avatar";
import { EnvKeyStatus } from "./SkillSecrets";

/**
 * Skills — the machine catalog + the decentralized marketplace.
 * Installed skills live in ~/.fez/settings.json (same file the CLI's
 * `fez skill add` writes); marketplace listings are signed 40200 events
 * on the relay. Installing is ALWAYS a local decision: the full command
 * renders verbatim before you accept, env keys are filled here and
 * never ride the wire. A listing is a recommendation from a pubkey —
 * nothing runs until you install it AND a persona declares it.
 */

const KIND_SKILL_LISTING = 40200;
const KIND_SKILL_INSTALL = 40201;
/** Company-tier cross-relay install index — empty until fez company infra exists (infra/skill-counts is ready to deploy); relay receipts carry the counts meanwhile. */
const DEFAULT_COUNTS_URL = "";
const countsUrl = () => localStorage.getItem("fez-skill-counts-url") ?? DEFAULT_COUNTS_URL;

interface SkillConfig {
  command?: string;
  args?: string[];
  type?: string;
  url?: string;
  env?: Record<string, string>;
}

interface Listing {
  name: string;
  artifact?: string;
  persona?: string;
  requiredSkills?: string[];
  description?: string;
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
  installCmd?: string;
  github?: string;
  npm?: string;
  homepage?: string;
  authorPk: string;
  ts: number;
}

type MarketTab = "agents" | "more";

export default function SkillsView({ client, wire }: { client: FezClient; wire: BrowserWire }) {
  const [tab, setTab] = useState<MarketTab>("agents");
  const [installed, setInstalled] = useState<Record<string, SkillConfig>>({});
  const [listings, setListings] = useState<Listing[]>();
  const [installing, setInstalling] = useState<Listing>();
  const [publishing, setPublishing] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [installs, setInstalls] = useState<Map<string, number>>(new Map());
  const [copied, setCopied] = useState<string>();
  const [agentDeps, setAgentDeps] = useState<{ agent: string; skills: string[] }[]>([]);

  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(undefined), 6000);
  };

  const reload = useCallback(() => {
    void invoke<string>("read_skills")
      .then((json) => setInstalled(JSON.parse(json) as Record<string, SkillConfig>))
      .catch(() => setInstalled({}));
  }, []);

  useEffect(() => {
    reload();
    void (async () => {
      try {
        const names = await invoke<string[]>("list_personas");
        const deps: { agent: string; skills: string[] }[] = [];
        for (const agent of names) {
          const content = await invoke<string>("read_persona", { name: agent }).catch(() => "");
          const match = content.match(/^mcpServers:\s*\[([^\]]*)\]/m);
          const skills = match ? match[1].split(",").map((skill) => skill.trim()).filter(Boolean) : [];
          if (skills.length > 0) deps.push({ agent, skills });
        }
        setAgentDeps(deps);
      } catch { /* no personas dir */ }
    })();
    void (async () => {
      const events = await wire.query([{ kinds: [KIND_SKILL_LISTING], limit: 100 }]);
      const latest = new Map<string, Listing>();
      for (const event of events as WireEvent[]) {
        try {
          const body = JSON.parse(event.content) as Omit<Listing, "authorPk" | "ts">;
          if (!body.name) continue;
          const key = `${event.pubkey}:${body.name}`;
          const prior = latest.get(key);
          if (prior && prior.ts >= event.created_at) continue;
          latest.set(key, { ...body, authorPk: event.pubkey, ts: event.created_at });
        } catch { /* malformed listing */ }
      }
      setListings([...latest.values()].sort((a, b) => b.ts - a.ts));
      // Install receipts (40201): distinct signer pubkeys per listing —
      // the decentralized download counter.
      const receipts = await wire.query([{ kinds: [KIND_SKILL_INSTALL], limit: 500 }]);
      const counts = new Map<string, Set<string>>();
      for (const receipt of receipts as WireEvent[]) {
        const skillName = receipt.tags.find((t) => t[0] === "skill")?.[1];
        const author = receipt.tags.find((t) => t[0] === "p")?.[1];
        if (!skillName || !author) continue;
        const key = `${author}:${skillName}`;
        if (!counts.has(key)) counts.set(key, new Set());
        counts.get(key)!.add(receipt.pubkey);
      }
      const merged = new Map([...counts.entries()].map(([key, pks]) => [key, pks.size]));
      // Cross-relay index overrides this relay's local view when reachable.
      try {
        if (!countsUrl()) throw new Error("no index configured");
        const res = await fetch(countsUrl(), { signal: AbortSignal.timeout(5000) });
        const body = (await res.json()) as { counts?: { skill_name: string; listing_author: string; installs: number }[] };
        for (const row of body.counts ?? []) merged.set(`${row.listing_author}:${row.skill_name}`, row.installs);
      } catch { /* index unreachable — relay-local counts stand */ }
      setInstalls(merged);
    })();
  }, [wire, reload]);

  const runsLine = (skill: SkillConfig | Listing) =>
    skill.url ?? [skill.command, ...(skill.args ?? [])].join(" ");

  const publish = async (name: string, meta: { description: string; github?: string; npm?: string }) => {
    const config = installed[name];
    if (!config) return;
    const envKeys = Object.keys(config.env ?? {});
    await wire.publish({
      kind: KIND_SKILL_LISTING,
      tags: [["d", name]],
      content: JSON.stringify({
        name,
        artifact: "mcp",
        description: meta.description,
        ...(config.url ? { type: "http", url: config.url } : { command: config.command, args: config.args ?? [] }),
        envKeys, // names only — values stay home
        installCmd: `fez skill install ${name}${envKeys.length ? " " + envKeys.map((key) => `--env ${key}=<value>`).join(" ") : ""}`,
        ...(meta.github ? { github: meta.github } : {}),
        ...(meta.npm ? { npm: meta.npm } : {}),
      }),
    });
    setPublishing(undefined);
    flash(`📡 published "${name}" — signed by you, env values not included`);
  };

  /** Marketplace persona → DRAFT for review in the agents pane. */
  const [personaState, setPersonaState] = useState<Record<string, string>>({});
  const installPersona = async (listing: Listing) => {
    if (!listing.persona) return;
    const stamped = listing.persona.replace(
      /^---\r?\n/,
      `---\nproposedBy: marketplace:${listing.authorPk.slice(0, 12)}\nproposedAt: ${new Date().toISOString()}\n`
    );
    const key = `${listing.authorPk}:${listing.name}`;
    try {
      await invoke("write_persona_draft", { name: listing.name, content: stamped });
      const receipt = wire.signEvent({ kind: KIND_SKILL_INSTALL, tags: [["skill", `persona:${listing.name}`], ["p", listing.authorPk]], content: "" });
      await wire.publish({ kind: receipt.kind, tags: receipt.tags, content: receipt.content }).catch(() => {});
      if (countsUrl()) void fetch(countsUrl(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(receipt), signal: AbortSignal.timeout(5000) }).catch(() => {});
      setPersonaState({ ...personaState, [key]: "done" });
      flash(`📝 "${listing.name}" is a draft — review the prompt in the agents pane (@ → proposed) and approve`);
    } catch (err) {
      setPersonaState({ ...personaState, [key]: String(err) });
    }
  };

  const copyCmd = (listing: Listing) => {
    const cmd = listing.installCmd ?? `fez skill install ${listing.name}`;
    void navigator.clipboard.writeText(cmd);
    setCopied(`${listing.authorPk}:${listing.name}`);
    setTimeout(() => setCopied(undefined), 2000);
  };

  const personas = (listings ?? []).filter((l) => l.artifact === "persona");
  const skillListings = (listings ?? []).filter((l) => (l.artifact ?? "mcp") === "mcp");
  const otherListings = (listings ?? []).filter((l) => l.artifact && !["persona", "mcp"].includes(l.artifact));

  return (
    <main className="main">
      <header className="topbar">
        ⌂ market
        <span className="agent-tabs market-tabs">
          {(["agents", "more"] as const).map((name) => (
            <button key={name} className={tab === name ? "agent-tab active" : "agent-tab"} onClick={() => setTab(name)}>
              {name === "more" ? "teams · workflows · extensions" : name}
            </button>
          ))}
        </span>
      </header>
      <div className="timeline">
        {notice && <div className="manage-notice">{notice}</div>}

        {tab === "agents" && (
          <>
            {agentDeps.length > 0 && (
              <>
                <div className="home-section">your agents — what they need on this machine</div>
                {agentDeps.map(({ agent, skills }) => (
                  <div key={agent} className="dep-row">
                    <span className="dep-agent">@{agent}</span>
                    <span className="dep-skills">
                      {skills.map((skill) => (
                        <SkillDep
                          key={skill}
                          skill={skill}
                          config={installed[skill]}
                          listing={skillListings.find((l) => l.name === skill)}
                          onInstall={(l) => setInstalling(l)}
                        />
                      ))}
                    </span>
                  </div>
                ))}
              </>
            )}
            <div className="home-section">agents on the marketplace</div>
            <div className="settings-hint">
              An agent IS its text — the listing carries the complete persona. Installing downloads it as a DRAFT:
              you read the system prompt like a PR in the agents pane, then approve. Nothing runs until you do.
            </div>
            {!listings && <div className="pane-empty">loading…</div>}
            {listings && personas.length === 0 && (
              <div className="pane-empty">no agents listed yet — publish yours: fez persona publish &lt;name&gt;</div>
            )}
            {personas.map((listing) => {
              const key = `${listing.authorPk}:${listing.name}`;
              const count = installs.get(key) ?? 0;
              const state = personaState[key];
              return (
                <div key={key} className="skill-row market">
                  <div className="skill-main">
                    <span className="skill-name">
                      @{listing.name}
                      <span className="role-tag">agent</span>
                      <span className="skill-installs">⇩ {count} install{count === 1 ? "" : "s"}</span>
                    </span>
                    {listing.description && <span className="skill-desc">{listing.description}</span>}
                    {listing.requiredSkills && listing.requiredSkills.length > 0 && (
                      <span className="skill-env skill-deps">
                        needs:{" "}
                        {listing.requiredSkills.map((skill) => {
                          const definition = skillListings.find((l) => l.name === skill);
                          return (
                            <span key={skill} className="skill-dep">
                              {skill}
                              {installed[skill] ? (
                                " ✓"
                              ) : definition ? (
                                <button className="skill-link" title="install this skill definition (env values stay yours to fill)" onClick={() => setInstalling(definition)}>
                                  install
                                </button>
                              ) : (
                                " (no definition listed)"
                              )}
                            </span>
                          );
                        })}
                      </span>
                    )}
                    {listing.persona && (
                      <details className="persona-peek">
                        <summary>view the persona (read before installing)</summary>
                        <pre className="draft-content">{listing.persona}</pre>
                      </details>
                    )}
                    <span className="skill-author">
                      <Avatar pk={listing.authorPk} size={14} /> {client.displayName(listing.authorPk)}
                      {listing.github && <button className="skill-link" onClick={() => void openUrl(listing.github!)}>github</button>}
                    </span>
                    {state && state !== "done" && <span className="ob-error">{state}</span>}
                  </div>
                  <div className="skill-actions">
                    {state === "done" ? (
                      <span className="role-tag installed-tag">drafted — review in @ agents</span>
                    ) : (
                      <button className="agent-action" onClick={() => void installPersona(listing)}>install as draft…</button>
                    )}
                  </div>
                </div>
              );
            })}
          </>
        )}

        {tab === "more" && (
          <>
            <div className="home-section">teams · workflows · extensions</div>
            <div className="settings-hint">
              Listings of other fez artifacts — install with the command shown (teams and packs go through fez
              install; workflows land in ~/.fez/workflows).
            </div>
            {otherListings.length === 0 && <div className="pane-empty">none listed on this relay yet</div>}
            {otherListings.map((listing) => {
              const key = `${listing.authorPk}:${listing.name}`;
              const count = installs.get(key) ?? 0;
              return (
                <div key={key} className="skill-row market">
                  <div className="skill-main">
                    <span className="skill-name">
                      {listing.name}
                      <span className="role-tag">{listing.artifact}</span>
                      <span className="skill-installs">⇩ {count}</span>
                    </span>
                    {listing.description && <span className="skill-desc">{listing.description}</span>}
                    <code className="skill-install-cmd" title="click to copy" onClick={() => copyCmd(listing)}>
                      {copied === key ? "✓ copied" : `$ ${listing.installCmd ?? ""}`}
                    </code>
                    <span className="skill-author">
                      <Avatar pk={listing.authorPk} size={14} /> {client.displayName(listing.authorPk)}
                    </span>
                  </div>
                </div>
              );
            })}

        <div className="home-section">skill definitions — installed on this machine</div>
        <div className="settings-hint">
          Skills are MCP servers agents declare — dependencies, not merchandise. Agents above pull these in;
          manage or publish the definitions here.
        </div>
        {Object.keys(installed).length === 0 && (
          <div className="pane-empty">
            no skills defined — install one from the marketplace below, or `fez skill add` from a terminal.
            Personas opt in via their mcpServers list; agents get them on next spawn.
          </div>
        )}
        {Object.entries(installed).map(([name, config]) => (
          <div key={name} className="skill-row">
            <div className="skill-main">
              <span className="skill-name">{name}</span>
              <code className="skill-cmd">{runsLine(config)}</code>
              {config.env && Object.keys(config.env).length > 0 && (
                <span className="skill-env skill-deps">
                  env:{" "}
                  {Object.keys(config.env).map((key) => (
                    <EnvKeyStatus key={key} skill={name} envKey={key} plaintext={!!config.env?.[key]?.trim()} editable={false} />
                  ))}
                </span>
              )}
            </div>
            <div className="skill-actions">
              {publishing === name ? (
                <PublishForm onPublish={(meta) => void publish(name, meta)} onCancel={() => setPublishing(undefined)} />
              ) : (
                <>
                  <button className="mini" title="publish a listing to the marketplace" onClick={() => setPublishing(name)}>📡 publish</button>
                  <button
                    className="mini"
                    title="remove from this machine"
                    onClick={() => void invoke("remove_skill", { name }).then(reload)}
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          </div>
        ))}

        <div className="home-section">skill definitions — listed on your relay</div>
        <div className="settings-hint">
          A listing is a recommendation signed by its author's key. The command runs on YOUR machine — read it
          before installing, exactly like reading a PR.
        </div>
        {!listings && <div className="pane-empty">loading…</div>}
        {listings?.length === 0 && (
          <div className="pane-empty">no listings on this relay yet — publish one of yours above</div>
        )}
        {skillListings.map((listing) => {
          const isInstalled = !!installed[listing.name];
          const key = `${listing.authorPk}:${listing.name}`;
          const count = installs.get(key) ?? 0;
          const isMcp = (listing.artifact ?? "mcp") === "mcp";
          return (
            <div key={key} className="skill-row market">
              <div className="skill-main">
                <span className="skill-name">
                  {listing.name}
                  <span className="role-tag">{listing.artifact ?? "mcp"}</span>
                  {isInstalled && <span className="role-tag installed-tag">installed</span>}
                  <span className="skill-installs">⇩ {count} install{count === 1 ? "" : "s"}</span>
                </span>
                {listing.description && <span className="skill-desc">{listing.description}</span>}
                {runsLine(listing) && <code className="skill-cmd">{runsLine(listing)}</code>}
                {listing.envKeys && listing.envKeys.length > 0 && (
                  <span className="skill-env">needs env: {listing.envKeys.join(", ")}</span>
                )}
                <code className="skill-install-cmd" title="click to copy" onClick={() => copyCmd(listing)}>
                  {copied === key ? "✓ copied" : `$ ${listing.installCmd ?? `fez skill install ${listing.name}`}`}
                </code>
                <span className="skill-author">
                  <Avatar pk={listing.authorPk} size={14} /> {client.displayName(listing.authorPk)}
                  {listing.github && (
                    <button className="skill-link" onClick={() => void openUrl(listing.github!)}>github</button>
                  )}
                  {listing.npm && (
                    <button className="skill-link" onClick={() => void openUrl(`https://www.npmjs.com/package/${listing.npm}`)}>npm</button>
                  )}
                  {listing.homepage && (
                    <button className="skill-link" onClick={() => void openUrl(listing.homepage!)}>docs</button>
                  )}
                </span>
              </div>
              <div className="skill-actions">
                {!isInstalled && isMcp && (
                  <button className="agent-action" onClick={() => setInstalling(listing)}>install…</button>
                )}
              </div>
            </div>
          );
        })}
          </>
        )}


        {installing && (
          <InstallDialog
            listing={installing}
            wire={wire}
            onDone={(didInstall) => {
              setInstalling(undefined);
              if (didInstall) {
                reload();
                flash(`✓ "${installing.name}" installed — declare it in a persona (mcpServers) and it loads on next spawn`);
              }
            }}
          />
        )}
      </div>
    </main>
  );
}

function PublishForm({
  onPublish,
  onCancel,
}: {
  onPublish: (meta: { description: string; github?: string; npm?: string }) => void;
  onCancel: () => void;
}) {
  const [description, setDescription] = useState("");
  const [github, setGithub] = useState("");
  const [npm, setNpm] = useState("");
  const submit = () => {
    if (!description.trim()) return;
    onPublish({ description: description.trim(), github: github.trim() || undefined, npm: npm.trim() || undefined });
  };
  return (
    <span className="publish-form stacked">
      <input className="manage-input" value={description} autoFocus placeholder="what does it do?" onChange={(e) => setDescription(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }} />
      <input className="manage-input" value={github} spellCheck={false} placeholder="github url (optional)" onChange={(e) => setGithub(e.target.value)} />
      <input className="manage-input" value={npm} spellCheck={false} placeholder="npm package (optional)" onChange={(e) => setNpm(e.target.value)} />
      <span className="agent-actions">
        <button className="mini" disabled={!description.trim()} onClick={submit}>publish</button>
        <button className="mini" onClick={onCancel}>cancel</button>
      </span>
    </span>
  );
}

/** The consent gate: full command verbatim + env values filled locally. */
function InstallDialog({ listing, wire, onDone }: { listing: Listing; wire: BrowserWire; onDone: (didInstall: boolean) => void }) {
  const [env, setEnv] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();

  const install = async () => {
    const missing = (listing.envKeys ?? []).filter((key) => !env[key]?.trim());
    if (missing.length > 0) return setError(`fill in: ${missing.join(", ")}`);
    const config: SkillConfig = listing.url
      ? { type: "http", url: listing.url }
      : {
          command: listing.command,
          ...(listing.args?.length ? { args: listing.args } : {}),
          ...(listing.envKeys?.length ? { env } : {}),
        };
    try {
      await invoke("write_skill", { name: listing.name, configJson: JSON.stringify(config) });
      // The receipt: +1 on the listing's install count, signed by you —
      // on the relay (truth) and pushed to the cross-relay index (number).
      const receipt = wire.signEvent({ kind: KIND_SKILL_INSTALL, tags: [["skill", listing.name], ["p", listing.authorPk]], content: "" });
      await wire.publish({ kind: receipt.kind, tags: receipt.tags, content: receipt.content, created_at: receipt.created_at }).catch(() => {});
      if (countsUrl()) void fetch(countsUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(receipt),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
      onDone(true);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="overlay" onMouseDown={() => onDone(false)}>
      <div className="search-box install-box" onMouseDown={(e) => e.stopPropagation()}>
        <div className="install-head">install "{listing.name}"</div>
        <div className="settings-hint">
          This exact command will run on your machine whenever an agent with this skill spawns:
        </div>
        <pre className="draft-content">{listing.url ?? [listing.command, ...(listing.args ?? [])].join(" ")}</pre>
        {(listing.envKeys ?? []).map((key) => (
          <div key={key} className="settings-field">
            <label>{key} (stored locally, never published)</label>
            <input
              className="manage-input"
              type="password"
              value={env[key] ?? ""}
              onChange={(e) => setEnv({ ...env, [key]: e.target.value })}
            />
          </div>
        ))}
        {error && <div className="ob-error">{error}</div>}
        <div className="agent-actions">
          <button className="agent-action" onClick={() => void install()}>I read the command — install</button>
          <button className="agent-action" onClick={() => onDone(false)}>cancel</button>
        </div>
      </div>
    </div>
  );
}


/**
 * One declared skill on the dependency board: ready / needs env (with
 * inline keychain fill) / undefined (with install if a listing exists).
 */
function SkillDep({
  skill,
  config,
  listing,
  onInstall,
}: {
  skill: string;
  config?: SkillConfig;
  listing?: Listing;
  onInstall: (listing: Listing) => void;
}) {
  const envKeys = Object.keys(config?.env ?? {});
  const [secretStatus, setSecretStatus] = useState<Record<string, boolean>>({});
  useEffect(() => {
    void (async () => {
      const status: Record<string, boolean> = {};
      for (const key of envKeys) {
        status[key] = await invoke<boolean>("has_skill_secret", { skill, key }).catch(() => false);
      }
      setSecretStatus(status);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill, envKeys.join(",")]);

  if (!config) {
    return (
      <span className="skill-dep missing">
        {skill}
        {listing ? (
          <button className="skill-link" onClick={() => onInstall(listing)}>install</button>
        ) : (
          " — no definition"
        )}
      </span>
    );
  }
  const unfilled = envKeys.filter((key) => !secretStatus[key] && !config.env?.[key]?.trim());
  if (unfilled.length === 0) {
    return <span className="skill-dep ready" title={envKeys.length ? "env resolved (keychain/settings)" : "no env needed"}>{skill} ✓</span>;
  }
  return (
    <span className="skill-dep needs-env" title={`needs ${unfilled.join(", ")} — fill in settings (⌘,) → skills & secrets`}>
      {skill} ○ needs {unfilled.join(", ")} — settings ⌘,
    </span>
  );
}
