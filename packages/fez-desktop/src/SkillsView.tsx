import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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

interface SkillConfig {
  command?: string;
  args?: string[];
  type?: string;
  url?: string;
  env?: Record<string, string>;
}

interface Listing {
  name: string;
  description?: string;
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
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
    })();
  }, [wire, reload]);

  const runsLine = (skill: SkillConfig | Listing) =>
    skill.url ?? [skill.command, ...(skill.args ?? [])].join(" ");

  const publish = async (name: string, description: string) => {
    const config = installed[name];
    if (!config) return;
    await wire.publish({
      kind: KIND_SKILL_LISTING,
      tags: [["d", name]],
      content: JSON.stringify({
        name,
        description,
        ...(config.url ? { type: "http", url: config.url } : { command: config.command, args: config.args ?? [] }),
        envKeys: Object.keys(config.env ?? {}), // names only — values stay home
      }),
    });
    setPublishing(undefined);
    flash(`📡 published "${name}" — signed by you, env values not included`);
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
                <PublishForm onPublish={(description) => void publish(name, description)} onCancel={() => setPublishing(undefined)} />
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
          return (
            <div key={`${listing.authorPk}:${listing.name}`} className="skill-row market">
              <div className="skill-main">
                <span className="skill-name">
                  {listing.name}
                  {isInstalled && <span className="role-tag">installed</span>}
                </span>
                {listing.description && <span className="skill-desc">{listing.description}</span>}
                <code className="skill-cmd">{runsLine(listing)}</code>
                {listing.envKeys && listing.envKeys.length > 0 && (
                  <span className="skill-env">needs env: {listing.envKeys.join(", ")}</span>
                )}
                <span className="skill-author">
                  <Avatar pk={listing.authorPk} size={14} /> {client.displayName(listing.authorPk)}
                </span>
              </div>
              <div className="skill-actions">
                {!isInstalled && (
                  <button className="agent-action" onClick={() => setInstalling(listing)}>install…</button>
                )}
              </div>
            </div>
          );
        })}

        {installing && (
          <InstallDialog
            listing={installing}
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

function PublishForm({ onPublish, onCancel }: { onPublish: (description: string) => void; onCancel: () => void }) {
  const [description, setDescription] = useState("");
  return (
    <span className="publish-form">
      <input
        className="manage-input"
        value={description}
        autoFocus
        placeholder="what does it do?"
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && description.trim()) onPublish(description.trim());
          if (e.key === "Escape") onCancel();
        }}
      />
      <button className="mini" disabled={!description.trim()} onClick={() => onPublish(description.trim())}>go</button>
    </span>
  );
}

/** The consent gate: full command verbatim + env values filled locally. */
function InstallDialog({ listing, onDone }: { listing: Listing; onDone: (didInstall: boolean) => void }) {
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
