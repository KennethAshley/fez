import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { FezClient, WireEvent } from "@fez/client";
import type { BrowserWire } from "./wire";
import Avatar from "./Avatar";

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

export default function SkillsView({ client, wire }: { client: FezClient; wire: BrowserWire }) {
  const [installed, setInstalled] = useState<Record<string, SkillConfig>>({});
  const [listings, setListings] = useState<Listing[]>();
  const [installing, setInstalling] = useState<Listing>();
  const [publishing, setPublishing] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [installs, setInstalls] = useState<Map<string, number>>(new Map());
  const [copied, setCopied] = useState<string>();

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
      setInstalls(new Map([...counts.entries()].map(([key, pks]) => [key, pks.size])));
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

  const copyCmd = (listing: Listing) => {
    const cmd = listing.installCmd ?? `fez skill install ${listing.name}`;
    void navigator.clipboard.writeText(cmd);
    setCopied(`${listing.authorPk}:${listing.name}`);
    setTimeout(() => setCopied(undefined), 2000);
  };

  return (
    <main className="main">
      <header className="topbar">⌁ skills</header>
      <div className="timeline">
        {notice && <div className="manage-notice">{notice}</div>}

        <div className="home-section">installed on this machine</div>
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
                <span className="skill-env">env: {Object.keys(config.env).join(", ")}</span>
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

        <div className="home-section">marketplace — listings on your relay</div>
        <div className="settings-hint">
          A listing is a recommendation signed by its author's key. The command runs on YOUR machine — read it
          before installing, exactly like reading a PR.
        </div>
        {!listings && <div className="pane-empty">loading…</div>}
        {listings?.length === 0 && (
          <div className="pane-empty">no listings on this relay yet — publish one of yours above</div>
        )}
        {listings?.map((listing) => {
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
      // The receipt: +1 on the listing's install count, signed by you.
      await wire
        .publish({ kind: KIND_SKILL_INSTALL, tags: [["skill", listing.name], ["p", listing.authorPk]], content: "" })
        .catch(() => {});
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
