import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FezClient } from "@fezchat/client";
import { PERM_LABEL, SENSITIVE, norm, permLabel, catalogEntry, installExtension, useInstalledExtensions } from "./extensions-catalog";
import { flash } from "./toast";
import { reloadGuiExtensions } from "./gui-extensions";
import { generateArtifact } from "./artifact-sprite";
import { AnimatedSprite } from "@fezchat/ui";

// @fez offers an install by putting `fez:install @fezchat/<name>` in its
// message. Only the official @fezchat scope is honored — a stray marker
// can't smuggle an arbitrary npm package past the consent card.
const MARKER = /fez:install\s+(@fezchat\/[a-z0-9-]+)/gi;

// Preserve the complete GitHub source; a file or directory must not become a repo import.
const GIT_MARKER = /fez:install\s+git:((?:https?:\/\/)?github\.com\/[^\s<>"`()[\]]+)/gi;

/** Routes GitHub web sources to package inspection instead of treating them as MCP endpoints. */
export function isGitHubSource(value: string): boolean {
  return /^(?:https?:\/\/)?github\.com\/[^\s]+$/i.test(value.trim());
}

/** The package names offered in a message, deduped. Empty = no card. */
export function installOffers(content: string): string[] {
  const out = [...content.matchAll(MARKER)].map((m) => m[1]);
  return [...new Set(out)];
}

/** The github.com urls offered via `fez:install git:…`, deduped. */
export function gitInstallOffers(content: string): string[] {
  const out = [...content.matchAll(GIT_MARKER)].map((m) => m[1]);
  return [...new Set(out)];
}

/** The message text with the raw `fez:install …` markers removed — the card renders instead. */
export function stripInstallMarkers(content: string): string {
  return content
    .replace(/^[ \t]*fez:install[ \t]+@fezchat\/[a-z0-9-]+[ \t]*$/gim, "")
    .replace(/fez:install[ \t]+@fezchat\/[a-z0-9-]+/gi, "")
    .replace(GIT_MARKER, "")
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
  const installed = useInstalledExtensions();
  const [busy, setBusy] = useState<string>();
  const [confirming, setConfirming] = useState<string>();

  if (names.length === 0) return null;

  const run = async (name: string) => {
    setConfirming(undefined);
    setBusy(name);
    const entry = catalogEntry(name);
    try {
      await installExtension(client, name);
      flash(`✓ ${entry?.title ?? name} installed — ${entry?.where ?? ""}`);
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
                      {SENSITIVE.has(p) ? "⚠ " : "· "}{permLabel(p)} <code>{p}</code>
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

interface GitPersonaFound { id: string; description: string; path: string }
interface GitInspectReport {
  kind: "skills" | "fez-package";
  name: string;
  skills: GitPersonaFound[];
  agents: GitPersonaFound[];
  ignored: string[];
  refused: string[];
  unsupported: string[];
  permissions: string[];
  components: string[];
  sha: string;
  url: string;
  installed: boolean;
}
type GitPhase =
  | { kind: "idle" | "inspecting" }
  | { kind: "report" | "installing" | "done"; report: GitInspectReport }
  | { kind: "error"; message: string };

/** One review for chat, Tools, and Extensions. Inspection chooses package semantics;
 * the install uses its immutable revision and the exact paths the owner selected. */
export function GitInstallOffer({ url, authorName, client, inspectOnMount = false }: {
  url: string; authorName: string; client: FezClient; inspectOnMount?: boolean;
}) {
  const [phase, setPhase] = useState<GitPhase>({ kind: "idle" });
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const inspect = async () => {
    setPhase({ kind: "inspecting" });
    try {
      const report = JSON.parse(await invoke<string>("inspect_git_package", { url })) as GitInspectReport;
      // An old host cannot enforce selected paths or distinguish native package consent.
      if (!["skills", "fez-package"].includes(report.kind) ||
          ![report.skills, report.agents, report.unsupported, report.permissions, report.components, report.refused, report.ignored].every(Array.isArray) ||
          ![...report.skills, ...report.agents].every(item => typeof item.path === "string" && item.path.length > 0) ||
          typeof report.url !== "string" || !isGitHubSource(report.url) ||
          typeof report.sha !== "string" || !/^[a-f0-9]{40}$/i.test(report.sha)) {
        throw new Error("Update Fez before importing this source; its inspection must include package type and exact instruction paths.");
      }
      setSelectedPaths([...report.skills, ...report.agents].map(item => item.path));
      setPhase({ kind: "report", report });
    } catch (e) { setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) }); }
  };
  useEffect(() => {
    if (inspectOnMount) void inspect();
    // Each source mounts its own keyed card; inspecting again requires an explicit click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, inspectOnMount]);

  const install = async (report: GitInspectReport) => {
    if (phase.kind !== "report" || report.refused.length || (report.kind === "skills" && !selectedPaths.length)) return;
    setPhase({ kind: "installing", report });
    try {
      await invoke<string>("install_git_package", {
        url: `${report.url.split("#")[0]}#${report.sha}`,
        ...(report.kind === "skills" ? { selectedPaths, allowSkillsOnly: true } : {}),
      });
      if (report.kind === "fez-package") await reloadGuiExtensions(client).catch(() => {});
      window.dispatchEvent(new CustomEvent("fez-extensions-changed"));
      flash(`✓ ${report.name} ${report.kind === "skills" ? "instructions imported" : "installed"}`);
      setPhase({ kind: "done", report });
    } catch (e) {
      flash(`✗ ${e instanceof Error ? e.message : String(e)}`);
      setPhase({ kind: "report", report });
    }
  };

  if (phase.kind === "error") return <div className="install-offers git-import"><div className="install-offer unknown">
    <div role="alert">{phase.message}</div><button className="mini" onClick={() => void inspect()}>Try inspection again</button>
  </div></div>;
  if (phase.kind === "report" || phase.kind === "installing" || phase.kind === "done") {
    const { report } = phase;
    if (report.refused.length) return <div className="install-offers git-import"><div className="install-offer unknown" role="alert">
      This source cannot be installed.
      <details className="install-offer-files"><summary>Show why</summary>
        <ul className="gallery-perms">{report.refused.map(path => <li key={path}>{path}</li>)}</ul>
      </details>
    </div></div>;
    const native = report.kind === "fez-package";
    const done = phase.kind === "done", installing = phase.kind === "installing";
    const candidates = [...report.skills.map(item => ({ ...item, label: "Skill" })), ...report.agents.map(item => ({ ...item, label: "Persona" }))];
    return <div className="install-offers git-import">
      <div className={`install-offer ${done ? "lit" : "dormant"}`}>
        <div className="install-offer-row">
          <span className="artifact-slot"><AnimatedSprite sprite={generateArtifact(url)} scale={3} /></span>
          <div className="install-offer-main"><span className="install-offer-title">{authorName === "you" ? "Review" : `${authorName} suggests`} {url}</span></div>
          {done && <span className="gallery-install installed">{native ? "Installed on this computer" : "Instructions imported. Choose an agent in Tools."}</span>}
          {installing && <span className="gallery-install">installing…</span>}
        </div>
        {!done && !installing && <div className="install-offer-consent">
          <strong>{native ? "Native Fez package" : "Skills-only import"}</strong>
          <div className="settings-hint">{report.name} @ <code>{report.sha.slice(0, 7)}</code></div>
          {native ? <>
            <div className="settings-hint">Installs the full package on this computer.</div>
            <div>Components: {report.components.join(", ") || "none declared"}</div>
            <div>Permissions to grant:</div>
            {report.permissions.length ? <ul className="gallery-perms">{report.permissions.map(permission => <li key={permission} className={SENSITIVE.has(permission) ? "sensitive" : ""}>
              {permLabel(permission)} <code>{permission}</code>
            </li>)}</ul> : <div className="settings-hint">No permissions requested.</div>}
          </> : <>
            <p className="settings-hint">Import selected instructions. This does not install the source's plugin runtime or assign skills to an agent.</p>
            {report.unsupported.length > 0 && <div className="git-import-unsupported">
              <strong>Plugin features not included</strong>
              <ul className="gallery-perms">{report.unsupported.map(feature => <li key={feature}>{feature}</li>)}</ul>
            </div>}
            <fieldset className="git-import-selection"><legend>Choose instructions to import</legend>
              {candidates.map(item => <label key={item.path} className="git-import-choice">
                <input type="checkbox" checked={selectedPaths.includes(item.path)} onChange={event => setSelectedPaths(paths => event.target.checked ? [...paths, item.path] : paths.filter(path => path !== item.path))} />
                <span><strong>{item.label}: {item.id}</strong>{item.description && <span>{item.description}</span>}<code>{item.path}</code></span>
              </label>)}
              {!candidates.length && <p>No importable instructions found.</p>}
            </fieldset>
            {selectedPaths.some(path => report.agents.some(agent => agent.path === path)) && <div className="settings-hint">Selected personas add agent definitions: {PERM_LABEL.personas}.</div>}
            <div className="settings-hint">These instructions can steer the agents you assign them to. Import only what you want them to use.</div>
          </>}
          {report.ignored.length > 0 && <details className="install-offer-files">
            <summary className="settings-hint">Other files not included</summary>
            <ul className="gallery-perms">{report.ignored.map(path => <li key={path}>{path}</li>)}</ul>
          </details>}
          {report.installed && <div className="settings-hint">already installed; importing again refreshes the selected content — persona files you've edited are kept.</div>}
          <div className="ext-modal-actions">
            <button className="mini" onClick={() => setPhase({ kind: "idle" })}>cancel</button>
            <button className="mini primary" disabled={!native && !selectedPaths.length} onClick={() => void install(report)}>{native ? "Install & grant" : "Import selected instructions"}</button>
          </div>
        </div>}
      </div>
    </div>;
  }
  return <div className="install-offers git-import"><div className="install-offer dormant">
    <div className="install-offer-row">
      <span className="artifact-slot"><AnimatedSprite sprite={generateArtifact(url)} scale={3} /></span>
      <div className="install-offer-main"><span className="install-offer-title">{authorName === "you" ? "Review" : `${authorName} suggests`} {url}</span></div>
      {phase.kind === "inspecting" ? <span className="gallery-install">inspecting…</span> : <button className="gallery-install" onClick={() => void inspect()}>review &amp; install</button>}
    </div>
  </div></div>;
}
