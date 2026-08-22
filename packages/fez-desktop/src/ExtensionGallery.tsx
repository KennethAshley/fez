import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FezClient } from "@fezchat/client";
import { reloadGuiExtensions } from "./gui-extensions";

const REPO = "https://github.com/KennethAshley/fez";
const githubUrl = (name: string) => `${REPO}/tree/main/packages/fez-${name.replace(/^@fezchat\//, "")}`;
const npmUrl = (name: string) => `https://www.npmjs.com/package/${name}`;

/**
 * The install gallery — discover the official fez extensions and install
 * one with a click. Each card names what the extension ADDS and the
 * permissions it asks for; installing runs `fez install` (the same CLI
 * that handles npm + copying parts into ~/.fez) and then re-scans gui
 * extensions so a new panel appears live. A headless part still needs a
 * sentinel restart — the notice says so.
 *
 * The list is curated on purpose: an npm scope search returns the infra
 * libraries (client, relay, protocol) that aren't features, so a
 * hand-kept set of the packages a person would actually install is
 * clearer than a filtered dump. `fez install <name>` stays the escape
 * hatch for anything not listed.
 */
interface GalleryEntry {
  name: string;
  title: string;
  blurb: string;
  /** Where the extension shows up once installed — so "nothing happened" isn't a mystery. */
  where: string;
  permissions: string[];
}

// Accurate permissions, read from each package's fez.permissions.
const GALLERY: GalleryEntry[] = [
  { name: "@fezchat/git", title: "Git", blurb: "Host repositories on the relay — a repo is a channel, agents push as themselves, and merge is a button.", where: "Adds a Repos panel in Settings, and a board on repo threads.", permissions: ["ui", "commands", "read:channels", "publish", "background", "personas", "network:relay"] },
  { name: "@fezchat/kanban", title: "Kanban", blurb: "Boards on your docs — columns are headings, cards are checkboxes; agents move their own cards.", where: "Opens on any doc that's a board — use the ▦ board toggle in a doc.", permissions: ["ui", "read:channels", "publish"] },
  { name: "@fezchat/polls", title: "Polls", blurb: "Vote by reaction, tally in real time.", where: "Adds /poll to the composer; poll cards render under the message.", permissions: ["ui", "commands", "read:channels", "publish"] },
  { name: "@fezchat/github", title: "GitHub", blurb: "A window onto a GitHub repo — a pull request becomes a thread you can talk in.", where: "Adds /github and a GitHub settings panel.", permissions: ["ui", "commands", "read:channels", "publish", "background"] },
  { name: "@fezchat/obsidian", title: "Obsidian", blurb: "Export a channel's docs to your Obsidian vault.", where: "Adds /obsidian to the composer.", permissions: ["ui", "commands", "read:channels"] },
  { name: "@fezchat/live-blocks", title: "Live Blocks", blurb: "A markdown block an agent keeps breathing — live data that updates itself inside a doc.", where: "Renders live blocks inside docs.", permissions: ["ui", "commands", "read:channels", "publish", "background"] },
];

/** De-scope and drop a `fez-` prefix so @fezchat/git, git, and fez-git all match. */
const norm = (n: string) => n.replace(/^@fezchat\//, "").replace(/^fez-/, "");

const PERM_LABEL: Record<string, string> = {
  ui: "add panels & views",
  commands: "add slash commands",
  "read:channels": "read your channels",
  publish: "post as you",
  "read:agents": "see agent activity",
  personas: "read & edit agent personas",
  background: "run background tasks",
  "network:relay": "talk to your relay",
};

const SENSITIVE = new Set(["publish", "personas", "background"]);

export function ExtensionGallery({
  client,
  installed,
  onInstalled,
  onNotice,
}: {
  client: FezClient;
  installed: Set<string>;
  onInstalled: () => void;
  onNotice: (text: string) => void;
}) {
  const [confirming, setConfirming] = useState<GalleryEntry>();
  const [installing, setInstalling] = useState<string>();
  const [detail, setDetail] = useState<GalleryEntry>();
  const [info, setInfo] = useState<{ version?: string; description?: string; readme?: string }>();

  // Fetch the registry README when a detail page opens.
  useEffect(() => {
    if (!detail) return;
    setInfo(undefined);
    let live = true;
    void (async () => {
      try {
        const raw = await invoke<string>("package_info", { name: detail.name });
        if (live) setInfo(JSON.parse(raw));
      } catch {
        if (live) setInfo({});
      }
    })();
    return () => {
      live = false;
    };
  }, [detail]);
  // Recorded installed versions (keyed by base name) and npm's latest.
  const [installedVer, setInstalledVer] = useState<Record<string, string>>({});
  const [latest, setLatest] = useState<Record<string, string>>({});

  const isInstalled = (entry: GalleryEntry) => [...installed].some((i) => norm(i) === norm(entry.name));

  // On open / when the installed set changes: read recorded versions, then
  // ask npm for latest on the ones we installed (a fez link-era install has
  // no recorded version, so it's skipped — no update badge, no false alarm).
  useEffect(() => {
    let live = true;
    void (async () => {
      let iv: Record<string, string> = {};
      try {
        iv = JSON.parse(await invoke<string>("read_extension_versions"));
      } catch { /* none recorded */ }
      if (!live) return;
      setInstalledVer(iv);
      const lv: Record<string, string> = {};
      await Promise.all(
        GALLERY.filter(isInstalled).map(async (e) => {
          const key = norm(e.name);
          if (!iv[key]) return;
          try {
            lv[key] = await invoke<string>("latest_version", { name: e.name });
          } catch { /* offline / cache */ }
        })
      );
      if (live) setLatest(lv);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installed]);

  const refreshVersions = async () => {
    try {
      setInstalledVer(JSON.parse(await invoke<string>("read_extension_versions")));
    } catch { /* ignore */ }
  };

  // Rewind extension registrations to core, load the current set fresh, and
  // tell the app to re-render — so install/uninstall/update take effect live.
  const applyLive = async () => {
    await reloadGuiExtensions(client).catch(() => {});
    window.dispatchEvent(new CustomEvent("fez-extensions-changed"));
    onInstalled();
    await refreshVersions();
  };

  const uninstall = async (entry: GalleryEntry) => {
    try {
      await invoke<string>("remove_extension", { name: norm(entry.name) });
      await applyLive();
      onNotice(`✓ ${entry.title} removed`);
    } catch (err) {
      onNotice(`✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const run = async (entry: GalleryEntry) => {
    setConfirming(undefined);
    setInstalling(entry.name);
    try {
      await invoke<string>("install_package", { name: entry.name });
      // A gui part appears live; headless/relay parts need a restart.
      await applyLive();
      onNotice(`✓ ${entry.title} installed — ${entry.where}`);
    } catch (err) {
      onNotice(`✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setInstalling(undefined);
    }
  };

  const update = async (entry: GalleryEntry) => {
    setInstalling(entry.name);
    try {
      await invoke<string>("install_package", { name: entry.name });
      await applyLive();
      onNotice(`✓ ${entry.title} updated to ${latest[norm(entry.name)] ?? "latest"}`);
    } catch (err) {
      onNotice(`✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setInstalling(undefined);
    }
  };

  if (detail) {
    const done = isInstalled(detail);
    const key = norm(detail.name);
    const newer = latest[key] && installedVer[key] && latest[key] !== installedVer[key] ? latest[key] : undefined;
    return (
      <div className="ext-detail">
        <button className="pane-back" onClick={() => setDetail(undefined)}>← extensions</button>
        <div className="ext-detail-head">
          <div>
            <div className="ext-detail-title">{detail.title}</div>
            <code className="gallery-name">{detail.name}{info?.version ? `@${info.version}` : ""}</code>
          </div>
          {done ? (
            newer ? (
              <button className="gallery-install update" onClick={() => void update(detail)}>update → {newer}</button>
            ) : (
              <button className="gallery-uninstall" onClick={() => void uninstall(detail)}>uninstall</button>
            )
          ) : (
            <button className="gallery-install" onClick={() => setConfirming(detail)}>install</button>
          )}
        </div>

        <div className="ext-detail-links">
          <button className="skill-link" onClick={() => void openUrl(githubUrl(detail.name))}>GitHub ↗</button>
          <button className="skill-link" onClick={() => void openUrl(npmUrl(detail.name))}>npm ↗</button>
        </div>

        <div className="ext-detail-section">
          <div className="manage-section">what it adds</div>
          <div className="settings-hint">{detail.blurb}</div>
          <div className="gallery-where">{detail.where}</div>
        </div>

        <div className="ext-detail-section">
          <div className="manage-section">permissions</div>
          <ul className="gallery-perms">
            {detail.permissions.map((p) => (
              <li key={p} className={SENSITIVE.has(p) ? "sensitive" : ""}>
                {SENSITIVE.has(p) ? "⚠ " : "· "}{PERM_LABEL[p] ?? p} <code>{p}</code>
              </li>
            ))}
          </ul>
          <div className="settings-hint">Installing fetches it from npm and grants these — no terminal needed.</div>
        </div>

        <div className="ext-detail-section">
          <div className="manage-section">readme</div>
          {info === undefined ? (
            <div className="pane-empty">loading…</div>
          ) : info.readme ? (
            <div className="ext-readme">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{info.readme}</ReactMarkdown>
            </div>
          ) : (
            <div className="pane-empty">no readme published</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="ext-gallery">
      <div className="settings-hint">
        Official fez extensions. Installing fetches the package from npm and grants the permissions shown — no
        terminal needed. Anything not listed: <code>fez install &lt;name&gt;</code> in a terminal.
      </div>
      {GALLERY.map((entry) => {
        const done = isInstalled(entry);
        const busy = installing === entry.name;
        const key = norm(entry.name);
        const cur = installedVer[key];
        const newer = latest[key] && cur && latest[key] !== cur ? latest[key] : undefined;
        return (
          <div key={entry.name} className="gallery-card">
            <div className="gallery-main clickable" onClick={() => setDetail(entry)} title="details">
              <div className="gallery-head">
                <span className="gallery-title">{entry.title}</span>
                <code className="gallery-name">{entry.name}</code>
              </div>
              <div className="gallery-blurb">{entry.blurb}</div>
              <div className="gallery-where">{done ? "✓ installed · " : ""}{entry.where}</div>
            </div>
            {done ? (
              <div className="gallery-actions">
                {newer ? (
                  <button className="gallery-install update" disabled={busy} onClick={() => void update(entry)}>
                    {busy ? "updating…" : `update → ${newer}`}
                  </button>
                ) : (
                  <span className="gallery-install installed">installed{cur ? ` · ${cur}` : ""}</span>
                )}
                <button className="gallery-uninstall" onClick={() => void uninstall(entry)}>uninstall</button>
              </div>
            ) : (
              <button className="gallery-install" disabled={busy} onClick={() => setConfirming(entry)}>
                {busy ? "installing…" : "install"}
              </button>
            )}
          </div>
        );
      })}

      {confirming && (
        <div className="ext-modal-backdrop" onClick={() => setConfirming(undefined)}>
          <div className="ext-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ext-modal-head">
              Install <strong>{confirming.title}</strong> <code>{confirming.name}</code>?
            </div>
            <div className="settings-hint">It asks for:</div>
            <ul className="gallery-perms">
              {confirming.permissions.map((p) => (
                <li key={p} className={SENSITIVE.has(p) ? "sensitive" : ""}>
                  {SENSITIVE.has(p) ? "⚠ " : "· "}
                  {PERM_LABEL[p] ?? p} <code>{p}</code>
                </li>
              ))}
            </ul>
            <div className="ext-modal-actions">
              <button className="mini" onClick={() => setConfirming(undefined)}>cancel</button>
              <button className="mini primary" onClick={() => void run(confirming)}>install & grant</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
