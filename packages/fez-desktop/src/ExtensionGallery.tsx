import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FezClient } from "@fezchat/client";
import { loadGuiExtensions } from "./gui-extensions";

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

  const uninstall = async (entry: GalleryEntry) => {
    try {
      await invoke<string>("remove_extension", { name: norm(entry.name) });
      onInstalled();
      // A gui part already registered stays until relaunch — the registries
      // have no unload path — so the files are gone but the panel lingers.
      onNotice(`✓ ${entry.title} removed — relaunch to fully unload it`);
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
      await loadGuiExtensions(client).catch(() => {});
      onInstalled();
      await refreshVersions();
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
      await loadGuiExtensions(client).catch(() => {});
      onInstalled();
      await refreshVersions();
      onNotice(`✓ ${entry.title} updated to ${latest[norm(entry.name)] ?? "latest"} — relaunch to load the new version`);
    } catch (err) {
      onNotice(`✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setInstalling(undefined);
    }
  };

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
            <div className="gallery-main">
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
