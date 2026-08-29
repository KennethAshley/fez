import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FezClient } from "@fezchat/client";
import { PERM_LABEL, SENSITIVE, norm, catalogEntry, installExtension } from "./extensions-catalog";
import { flash } from "./toast";
import { generateArtifact } from "./artifact-sprite";
import { AnimatedSprite } from "@fezchat/ui";

// @fez offers an install by putting `fez:install @fezchat/<name>` in its
// message. Only the official @fezchat scope is honored — a stray marker
// can't smuggle an arbitrary npm package past the consent card.
const MARKER = /fez:install\s+(@fezchat\/[a-z0-9-]+)/gi;

/** The package names offered in a message, deduped. Empty = no card. */
export function installOffers(content: string): string[] {
  const out = [...content.matchAll(MARKER)].map((m) => m[1]);
  return [...new Set(out)];
}

/** The message text with the raw `fez:install …` markers removed — the card renders instead. */
export function stripInstallMarkers(content: string): string {
  return content
    .replace(/^[ \t]*fez:install[ \t]+@fezchat\/[a-z0-9-]+[ \t]*$/gim, "")
    .replace(/fez:install[ \t]+@fezchat\/[a-z0-9-]+/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The `📦 … (artifact)` placeholder the agent runtime leaves where an
 * artifact fence was — a text stand-in for bare clients. The desktop
 * renders the artifact card itself, so the placeholder is a redundant
 * second copy; strip it so a tool never shows up twice. */
export function stripArtifactMarkers(content: string): string {
  return content
    .replace(/^[ \t]*📦 .+? \(artifact\)[ \t]*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Renders under a message that offers an install. Crucially LOCAL: the
 * button installs onto THIS machine, gated by this user's click and the
 * permission consent — no matter who posted the offer. @fez proposes; the
 * human at each desktop decides for their own machine.
 */
export function InstallOffer({ content, authorName, client }: { content: string; authorName: string; client: FezClient }) {
  const names = installOffers(content);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string>();
  const [confirming, setConfirming] = useState<string>();

  useEffect(() => {
    void invoke<[string, string[]][]>("list_local_extensions")
      .then((rows) => setInstalled(new Set(rows.map(([n]) => norm(n)))))
      .catch(() => {});
  }, [content]);

  if (names.length === 0) return null;

  const run = async (name: string) => {
    setConfirming(undefined);
    setBusy(name);
    const entry = catalogEntry(name);
    try {
      await installExtension(client, name);
      flash(`✓ ${entry?.title ?? name} installed — ${entry?.where ?? ""}`);
      setInstalled((s) => new Set(s).add(norm(name)));
    } catch (e) {
      flash(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="install-offers">
      {names.map((name) => {
        const entry = catalogEntry(name);
        const done = installed.has(norm(name));
        if (!entry) {
          return (
            <div key={name} className="install-offer unknown">
              ⚠ {authorName} offered <code>{name}</code>, which isn't an official fez extension.
            </div>
          );
        }
        return (
          <div key={name} className={`install-offer ${done ? "lit" : "dormant"}`}>
            <div className="install-offer-row">
              <span className="artifact-slot">
                <AnimatedSprite sprite={generateArtifact(name)} scale={3} />
              </span>
              <div className="install-offer-main">
                <span className="install-offer-title">{authorName} suggests installing {entry.title}</span>
                <span className="install-offer-blurb">{entry.blurb}</span>
              </div>
              {done ? (
                <span className="gallery-install installed">installed</span>
              ) : busy === name ? (
                <span className="gallery-install">installing…</span>
              ) : (
                <button className="gallery-install" onClick={() => setConfirming(confirming === name ? undefined : name)}>
                  review & install
                </button>
              )}
            </div>
            {confirming === name && (
              <div className="install-offer-consent">
                <div className="settings-hint">Installs on THIS machine and grants:</div>
                <ul className="gallery-perms">
                  {entry.permissions.map((p) => (
                    <li key={p} className={SENSITIVE.has(p) ? "sensitive" : ""}>
                      {SENSITIVE.has(p) ? "⚠ " : "· "}{PERM_LABEL[p] ?? p} <code>{p}</code>
                    </li>
                  ))}
                </ul>
                <div className="ext-modal-actions">
                  <button className="mini" onClick={() => setConfirming(undefined)}>cancel</button>
                  <button className="mini primary" onClick={() => void run(name)}>install &amp; grant</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
