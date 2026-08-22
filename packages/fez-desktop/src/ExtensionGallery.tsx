import { useState } from "react";
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
  permissions: string[];
}

// Accurate permissions, read from each package's fez.permissions.
const GALLERY: GalleryEntry[] = [
  { name: "@fezchat/git", title: "Git", blurb: "Host repositories on the relay — a repo is a channel, agents push as themselves, and merge is a button.", permissions: ["ui", "commands", "read:channels", "publish", "background", "personas", "network:relay"] },
  { name: "@fezchat/kanban", title: "Kanban", blurb: "Boards on your docs — columns are headings, cards are checkboxes; agents move their own cards.", permissions: ["ui", "read:channels", "publish"] },
  { name: "@fezchat/polls", title: "Polls", blurb: "/poll in any channel, vote by reaction, tally in real time.", permissions: ["ui", "commands", "read:channels", "publish"] },
  { name: "@fezchat/github", title: "GitHub", blurb: "A window onto a GitHub repo — a pull request becomes a thread you can talk in.", permissions: ["ui", "commands", "read:channels", "publish", "background"] },
  { name: "@fezchat/obsidian", title: "Obsidian", blurb: "/obsidian exports a channel's docs to your Obsidian vault.", permissions: ["ui", "commands", "read:channels"] },
  { name: "@fezchat/live-blocks", title: "Live Blocks", blurb: "A markdown block an agent keeps breathing — live data that updates itself inside a doc.", permissions: ["ui", "commands", "read:channels", "publish", "background"] },
];

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

  const isInstalled = (entry: GalleryEntry) =>
    installed.has(entry.name) || installed.has(entry.name.replace(/^@fezchat\//, ""));

  const run = async (entry: GalleryEntry) => {
    setConfirming(undefined);
    setInstalling(entry.name);
    try {
      await invoke<string>("install_package", { name: entry.name });
      // A gui part appears live; headless/relay parts need a restart.
      await loadGuiExtensions(client).catch(() => {});
      onInstalled();
      onNotice(`✓ ${entry.title} installed — a panel appears now; a background part needs a sentinel restart`);
    } catch (err) {
      onNotice(`✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setInstalling(undefined);
    }
  };

  return (
    <div className="ext-gallery">
      <div className="settings-hint">
        Official fez extensions. Installing runs <code>fez install</code> on your machine and grants the permissions
        shown. Anything not listed: <code>fez install &lt;name&gt;</code> in a terminal.
      </div>
      {GALLERY.map((entry) => {
        const done = isInstalled(entry);
        const busy = installing === entry.name;
        return (
          <div key={entry.name} className="gallery-card">
            <div className="gallery-main">
              <div className="gallery-head">
                <span className="gallery-title">{entry.title}</span>
                <code className="gallery-name">{entry.name}</code>
              </div>
              <div className="gallery-blurb">{entry.blurb}</div>
            </div>
            <button
              className={done ? "gallery-install installed" : "gallery-install"}
              disabled={done || busy}
              onClick={() => setConfirming(entry)}
            >
              {done ? "installed" : busy ? "installing…" : "install"}
            </button>
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
