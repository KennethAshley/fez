import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FezClient } from "@fezchat/client";
import { reloadGuiExtensions } from "./gui-extensions";
import { CATALOG, SENSITIVE, norm, permLabel, githubUrl, npmUrl, type CatalogEntry } from "./extensions-catalog";
import { useConfig } from "./config-store";
import { generateArtifact } from "./artifact-sprite";
import { AnimatedSprite } from "@fezchat/ui";
import { GitInstallOffer } from "./InstallOffer";

/**
 * The install gallery — discover the official fez extensions and install
 * one with a click. Each card is led by the extension's relic (a
 * deterministic sprite from artifact-sprite.ts) which carries install
 * state in the sultan-statue grammar: dormant relics sit muted and
 * installing lights them. Cards name what the extension ADDS and the
 * permissions it asks for; installing fetches the tarball from npm and
 * copies its parts into ~/.fez (self-sufficient, no CLI), then re-scans
 * gui extensions so a new panel appears live. The catalog itself lives in
 * extensions-catalog.ts, shared with @fez's in-chat install offers.
 */
type GalleryEntry = CatalogEntry;
const GALLERY = CATALOG;

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
  const [urlDraft, setUrlDraft] = useState<string>("");
  const [submitted, setSubmitted] = useState<string>();
  // The shelf's scale furniture: a filter and three views. Built for a
  // catalog of thousands, honest at a dozen — search-first, uniform cells.
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"all" | "installed" | "updates">("all");

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
  // Recorded installed versions come from the config store (reactive);
  // npm's latest is a network fetch, kept local.
  const installedVer = useConfig().versions;
  const [latest, setLatest] = useState<Record<string, string>>({});

  const isInstalled = (entry: GalleryEntry) => [...installed].some((i) => norm(i) === norm(entry.name));

  // When the installed set / recorded versions change, ask npm for latest on
  // the ones we installed (a fez link-era install has no recorded version, so
  // it's skipped — no update badge, no false alarm).
  useEffect(() => {
    let live = true;
    void (async () => {
      const lv: Record<string, string> = {};
      await Promise.all(
        GALLERY.filter(isInstalled).map(async (e) => {
          const key = norm(e.name);
          if (!installedVer[key]) return;
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
  }, [installed, installedVer]);

  // Rewind extension registrations to core, load the current set fresh, and
  // tell the app + config store to re-read — so install/uninstall/update take
  // effect live (the store listens for fez-extensions-changed).
  const applyLive = async () => {
    await reloadGuiExtensions(client).catch(() => {});
    window.dispatchEvent(new CustomEvent("fez-extensions-changed"));
    onInstalled();
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
          <div className={`ext-detail-id ${done ? "lit" : "dormant"}`}>
            <span className="artifact-slot big">
              <AnimatedSprite sprite={generateArtifact(detail.name)} scale={6} />
            </span>
            <div>
              <div className="ext-detail-title">{detail.title}</div>
              <code className="gallery-name">{detail.name}{info?.version ? `@${info.version}` : ""}</code>
            </div>
          </div>
          {done ? (
            newer ? (
              <button className="gallery-install update" onClick={() => void update(detail)}>update → {newer}</button>
            ) : (
              <button className="gallery-uninstall" onClick={() => void uninstall(detail)}>uninstall</button>
            )
          ) : (
            <button className="gallery-install" onClick={() => setConfirming(detail)}>review & install</button>
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
                {SENSITIVE.has(p) ? "⚠ " : "· "}{permLabel(p)} <code>{p}</code>
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

  // Chip math + the filtered shelf. hasUpdate mirrors the card's own
  // "newer" logic so the chip and the yellow button can never disagree.
  const hasUpdate = (entry: GalleryEntry) => {
    const key = norm(entry.name);
    const cur = installedVer[key];
    return !!(latest[key] && cur && latest[key] !== cur);
  };
  const q = query.trim().toLowerCase();
  const shelf = GALLERY.filter((e) => {
    if (view === "installed" && !isInstalled(e)) return false;
    if (view === "updates" && !hasUpdate(e)) return false;
    if (!q) return true;
    return `${e.title} ${e.name} ${e.blurb}`.toLowerCase().includes(q);
  });
  const updateCount = GALLERY.filter(hasUpdate).length;
  const installedCount = GALLERY.filter(isInstalled).length;

  return (
    <div className="ext-gallery">
      <div className="settings-hint">
        Official fez extensions. Installing fetches the package from npm and grants the permissions shown — no
        terminal needed. Anything not listed: <code>fez install &lt;name&gt;</code> in a terminal.
      </div>
      {/* The shelf's toolbar: filter + views. The updates chip wears the
          update button's own yellow when something needs you — one glance
          at this row is the state of the shelf. */}
      <div className="gallery-toolbar">
        <input
          className="gallery-filter"
          value={query}
          spellCheck={false}
          placeholder="filter extensions…"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className={`gallery-chip${view === "all" ? " on" : ""}`} onClick={() => setView("all")}>
          all · {GALLERY.length}
        </button>
        <button className={`gallery-chip${view === "installed" ? " on" : ""}`} onClick={() => setView("installed")}>
          installed · {installedCount}
        </button>
        <button
          className={`gallery-chip${view === "updates" ? " on" : ""}${updateCount ? " alert" : ""}`}
          onClick={() => setView("updates")}
        >
          updates · {updateCount}
        </button>
      </div>
      {shelf.length === 0 && (
        <div className="settings-hint">
          {view === "updates" && !updateCount ? "Everything installed is current." : `Nothing matches “${query.trim()}”.`}
        </div>
      )}
      {shelf.map((entry) => {
        const done = isInstalled(entry);
        const busy = installing === entry.name;
        const key = norm(entry.name);
        const cur = installedVer[key];
        const newer = latest[key] && cur && latest[key] !== cur ? latest[key] : undefined;
        const sens = entry.permissions.filter((p) => SENSITIVE.has(p)).length;
        return (
          <div key={entry.name} className={`gallery-card ${done ? "lit" : "dormant"}`}>
            <button className="gallery-main" onClick={() => setDetail(entry)} title="details">
              <span className="artifact-slot">
                <AnimatedSprite sprite={generateArtifact(entry.name)} scale={4} />
              </span>
              <span className="gallery-body">
                <span className="gallery-head">
                  <span className="gallery-title">{entry.title}</span>
                  <code className="gallery-name">{entry.name}</code>
                </span>
                {/* Two lines, then the knife — the full pitch and the
                    "adds…" prose live one click away in the detail view.
                    A shelf of thousands is scannable only if every card
                    is the same shape. */}
                <span className="gallery-blurb" title={`${entry.blurb}\n\n↳ ${entry.where}`}>{entry.blurb}</span>
              </span>
            </button>
            <div className="gallery-foot">
              <span className="gallery-grants">
                {entry.permissions.length} grants{sens ? <span className="sens"> · ⚠ {sens} sensitive</span> : null}
              </span>
              {done ? (
                <div className="gallery-actions">
                  {newer ? (
                    <button className="gallery-install update" disabled={busy} onClick={() => void update(entry)}>
                      {busy ? "updating…" : `update → ${newer}`}
                    </button>
                  ) : (
                    <span className="gallery-install installed">✓ installed{cur ? ` · ${cur}` : ""}</span>
                  )}
                  <button className="gallery-uninstall" onClick={() => void uninstall(entry)}>uninstall</button>
                </div>
              ) : (
                <button className="gallery-install" disabled={busy} onClick={() => setConfirming(entry)}>
                  {busy ? "installing…" : "review & install"}
                </button>
              )}
            </div>
          </div>
        );
      })}

      {confirming && (
        <div className="consent-backdrop" onClick={() => setConfirming(undefined)}>
          <div className="consent-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ext-modal-head lit">
              <span className="artifact-slot">
                <AnimatedSprite sprite={generateArtifact(confirming.name)} scale={3} />
              </span>
              <span>
                Install <strong>{confirming.title}</strong> <code>{confirming.name}</code>?
              </span>
            </div>
            <div className="settings-hint">It asks for:</div>
            <ul className="gallery-perms">
              {confirming.permissions.map((p) => (
                <li key={p} className={SENSITIVE.has(p) ? "sensitive" : ""}>
                  {SENSITIVE.has(p) ? "⚠ " : "· "}
                  {permLabel(p)} <code>{p}</code>
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

      <div className="gallery-from-url">
        <div className="settings-hint">install a prompt pack from GitHub — markdown skills only, repos with code are refused</div>
        <form onSubmit={(e) => { e.preventDefault(); if (/^(https:\/\/)?github\.com\/[\w.-]+\/[\w.-]+/.test(urlDraft.trim())) setSubmitted(urlDraft.trim()); }}>
          <input value={urlDraft} onChange={(e) => setUrlDraft(e.target.value)} placeholder="github.com/owner/repo" />
          <button className="mini" type="submit">inspect</button>
        </form>
        {submitted && <GitInstallOffer key={submitted} url={submitted} authorName="you" client={client} />}
      </div>
    </div>
  );
}
