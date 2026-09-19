import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FezClient } from "@fezchat/client";
import { mediaServer, setMediaServer } from "./upload";
import { createBackup, openBackup, sealText, downloadText } from "./backup";
import type { BrowserWire } from "./wire";
import { applyTheme, applyMode, currentTheme, currentMode, themeNames, themeFollowsScheme, themePalette, resolvedScheme, guiExtensionStatus, extensionSettingsPanels } from "./gui-extensions";
import { DEFAULT_DISPLAY, loadDisplayPrefs, saveDisplayPrefs, type DisplayPrefs } from "./display-prefs";
import { version } from "../package.json";
import { ExtensionPanel } from "./SkillsView";
import { SkillSecretsSection } from "./SkillSecrets";
import { KeyboardSettings } from "./KeyboardSettings";
import { flash } from "./toast";
import { relayRaw, setRelays } from "./relay";
import { AnimatedSprite } from "@fezchat/ui";
import { SPRITES } from "@fezchat/ui";
import { loadNotifyPrefs, saveNotifyPrefs } from "./notify";
import { NOTIFY_KINDS, NOTIFY_LABELS, NOTIFY_UNBUILT, type NotifyPrefs } from "./notify-prefs";
import { SOUND_NAMES, playSound } from "./sounds";
import { norm } from "./extensions-catalog";

const ACCOUNT = (import.meta as { env?: Record<string, string> }).env?.VITE_FEZ_ACCOUNT ?? "default";

/**
 * What the RUNNING app booted with. The wire is a boot-time singleton,
 * so localStorage can say one thing while the live connection is another
 * — these are captured at module load, which happens once per page, so
 * "saved but not yet applied" is a computable fact rather than a hint in
 * a flash message the user already dismissed.
 */
const BOOT_RELAY = relayRaw();
const BOOT_MEDIA = localStorage.getItem("fez-media-server") ?? "";

/**
 * Settings — the small set that matters on a decentralized surface:
 * who you appear as (kind-0 profile, 30315 status), which relay and
 * media server you bring, and your key's escape hatch (backup reveal
 * from the keychain). Relay changes take effect on relaunch — the live
 * wire is a boot-time singleton by design.
 */

const SETTINGS_TABS = {
  profile: "Profile",
  servers: "Servers",
  appearance: "Appearance",
  notifications: "Notifications",
  keyboard: "Keyboard shortcuts",
  skills: "Secrets",
  backup: "Backup & identity",
  about: "About",
} as const;
type SettingsSection = keyof typeof SETTINGS_TABS;

const SETTINGS_SEARCH: Record<SettingsSection, string> = {
  profile: "display name status public",
  servers: "relay workspace connection media uploads blossom",
  appearance: "theme color light dark system text size font message spacing compact comfortable animations motion reset",
  notifications: "alerts sounds mentions questions banners mute",
  keyboard: "keys hotkeys bindings shortcuts",
  skills: "api keys credentials skills providers passwords",
  backup: "export archive restore encryption identity key account factory reset",
  about: "version app diagnostics extensions loaded errors",
};

// Buzz's grouped-nav decision: sections cluster by whose thing they
// configure, not by feature age. Labels share the rail's divider grammar.
const SETTINGS_GROUPS: { label: string; sections: SettingsSection[] }[] = [
  { label: "Personal", sections: ["profile", "appearance", "notifications", "keyboard", "backup"] },
  { label: "Workspace", sections: ["servers", "skills", "about"] },
];

/**
 * The guide, sitting at the foot of the settings rail. Click him and he
 * says something; keep clicking and he gets more aware of it, until the
 * rest of the cast files past and he gives up on the bit.
 *
 * It is an easter egg, so the rules are: it costs nothing when ignored,
 * it never blocks the page, and it holds still for anyone who asked the
 * system for less motion.
 */
const FEZ_LINES = [
  "ask me anything",
  "settings are back up there",
  "nothing to configure down here",
  "still here",
  "you found me",
  "keep going, then",
];
const PARADE = ["scout", "quill", "drift", "loom", "vault", "chip"] as const;

function FezCorner() {
  const [clicks, setClicks] = useState(0);
  const [parading, setParading] = useState(false);
  useEffect(() => {
    if (!parading) return;
    const t = setTimeout(() => setParading(false), 5200);
    return () => clearTimeout(t);
  }, [parading]);
  const line = clicks === 0 ? undefined : parading ? "…fine. everyone up." : FEZ_LINES[Math.min(clicks, FEZ_LINES.length) - 1];
  return (
    <div className="fez-corner">
      {parading && (
        <div className="fez-parade" aria-hidden>
          {PARADE.map((who, i) => (
            <span key={who} className="fez-parade-face" style={{ "--march": `${i * 0.42}s` } as React.CSSProperties}>
              <AnimatedSprite sprite={SPRITES[who]} scale={3} />
            </span>
          ))}
        </div>
      )}
      {line && <div className="fez-says">{line}</div>}
      <button
        /* Remount per poke so the tip animation replays — a class that
           is already there does not restart a CSS animation. */
        key={clicks}
        className={clicks > 0 ? "fez-corner-btn poked" : "fez-corner-btn"}
        title="fez"
        onClick={() => {
          const next = clicks + 1;
          setClicks(next);
          if (next > FEZ_LINES.length) setParading(true);
        }}
      >
        <AnimatedSprite sprite={SPRITES.fez} scale={3} />
      </button>
    </div>
  );
}

/**
 * A settings page is a head and a list of rows — Buzz's structure, fez's
 * skin. Three primitives make every section, so a page nobody has
 * written yet still lands in the same shape as the rest.
 */

/** The page says where you are and what changing things here costs. */
function Head({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="set-head">
      <h1 className="set-title">{title}</h1>
      <div className="set-sub">{sub}</div>
    </div>
  );
}

/**
 * One setting, one row: label and description left, control right.
 * `stacked` is for controls too wide for the right column (a relay URL,
 * a password) — same row, control full-width beneath the description.
 */
function Row({
  label,
  desc,
  control,
  stacked,
}: {
  label: string;
  desc?: React.ReactNode;
  control: React.ReactNode;
  stacked?: boolean;
}) {
  return (
    <div className={stacked ? "set-row stacked" : "set-row"}>
      <div className="set-label">{label}</div>
      {desc !== undefined && <div className="set-desc">{desc}</div>}
      <div className="set-control">{control}</div>
    </div>
  );
}

/**
 * A handful of options, all visible. A dropdown makes you open it to
 * learn what the choices even are, which for three of them is a worse
 * deal than the width it saves.
 */
function Seg<T extends string>({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onPick: (value: T) => void;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          className={option.value === value ? "on" : undefined}
          aria-pressed={option.value === value}
          onClick={() => onPick(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A switch. The one control here that is a real toggle rather than a
 * choice between named options — it reads as on or off at a glance and
 * needs no label of its own, since the row already carries one.
 */
function Toggle({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={on ? "toggle on" : "toggle"}
      onClick={() => onChange(!on)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

const MODES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

function ThemeMiniature() {
  return <span className="theme-mini" aria-hidden="true">
    <span className="theme-mini-rail"><i /><i /><i /></span>
    <span className="theme-mini-chat"><i /><i /><i /><i /></span>
  </span>;
}

function AppearanceSettings() {
  const [mode, setMode] = useState(currentMode);
  const [theme, setTheme] = useState(currentTheme);
  const [prefs, setPrefs] = useState(loadDisplayPrefs);
  const [error, setError] = useState<string>();
  const [scheme, setScheme] = useState(resolvedScheme);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-color-scheme: dark)");
    const updateScheme = () => setScheme(resolvedScheme());
    query.addEventListener("change", updateScheme);
    return () => query.removeEventListener("change", updateScheme);
  }, []);
  const names = [...new Set(["default", ...themeNames(), theme])];
  const change = (action: () => void) => {
    try { action(); setError(undefined); }
    catch { setError("Couldn't save appearance on this Mac. Try the change again."); }
  };
  const update = (next: DisplayPrefs) => change(() => { saveDisplayPrefs(next); setPrefs(next); });
  return <>
    <Head title="Appearance" sub="Choose your colors and make conversations comfortable to read." />
    <fieldset className="appearance-section">
      <legend>Color mode</legend>
      <div className="appearance-modes">
        {MODES.map(option => <button key={option.value} type="button" className="appearance-mode"
          data-mode-preview={option.value} style={themePalette(theme, option.value === "system" ? scheme : option.value) as React.CSSProperties}
          aria-label={option.label} aria-pressed={mode === option.value}
          onClick={() => change(() => { applyMode(option.value); setMode(option.value); setScheme(resolvedScheme()); })}>
          {option.value === "system" ? <span className="theme-mini-split">
            <span style={themePalette(theme, "light") as React.CSSProperties}><ThemeMiniature /></span>
            <span style={themePalette(theme, "dark") as React.CSSProperties}><ThemeMiniature /></span>
          </span> : <ThemeMiniature />}
          <span className="appearance-mode-name">{option.label}<span aria-hidden="true">{mode === option.value ? "✓" : ""}</span></span>
        </button>)}
      </div>
      <p className="appearance-hint">{!themeFollowsScheme(theme)
        ? `${theme} has one palette for both light and dark.`
        : mode === "system" ? "Follows your Mac’s light and dark appearance." : `Always uses ${mode} colors.`}</p>
    </fieldset>
    <fieldset className="appearance-section">
      <legend>Theme</legend>
      <div className="appearance-themes" aria-label="Installed themes">
        {names.map(name => <button type="button" key={name} className="theme-option" aria-label={`Theme: ${name === "default" ? "Default" : name}`}
          aria-pressed={theme === name} onClick={() => change(() => { applyTheme(name); setTheme(name); })}>
          <span className="theme-swatches" aria-hidden="true">{["--bg0", "--fg", "--accent"].map(token => <i key={token} style={{ background: themePalette(name, scheme)[token] }} />)}</span>
          <span>{name === "default" ? "Default" : name}</span><span className="theme-picked" aria-hidden="true">{theme === name ? "✓" : ""}</span>
        </button>)}
      </div>
      <p className="appearance-hint">Installed theme packs appear here automatically.</p>
    </fieldset>
    <section className="appearance-preview" aria-label="Conversation preview">
      <div className="appearance-preview-head"><span># design</span><span>Preview</span></div>
      <div className="bubble">
        <span className="appearance-avatar" aria-hidden="true">Y</span>
        <div className="bubble-head"><span className="author">You</span><span className="time">9:41 AM</span></div>
        <div className="bubble-body">Can you review the board?</div>
      </div>
      <div className="bubble">
        <span className="appearance-avatar fez" aria-hidden="true"><AnimatedSprite sprite={SPRITES.fez} scale={2} /></span>
        <div className="bubble-head"><span className="author">fez</span><span className="time">9:41 AM</span></div>
        <div className="bubble-body">Two cards are ready for your review.<br />The notes and checks are on each card.</div>
      </div>
    </section>
    <div className="appearance-reading">
      <Row label="Message text size" desc="Applies to channel and direct message text."
        control={<Seg label="Message text size" options={[{ value: "14", label: "14 px" }, { value: "16", label: "16 px" }, { value: "18", label: "18 px" }]}
          value={String(prefs.messageSize)} onPick={value => update({ ...prefs, messageSize: Number(value) as DisplayPrefs["messageSize"] })} />} />
      <Row label="Message spacing" desc="Keep room between messages, or fit more on screen."
        control={<Seg label="Message spacing" options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]}
          value={prefs.messageSpacing} onPick={value => update({ ...prefs, messageSpacing: value })} />} />
      <Row label="Reduce motion" desc="Limit interface animations. Your Mac’s Reduce Motion setting is always respected."
        control={<Toggle label="Reduce motion" on={prefs.reduceMotion} onChange={reduceMotion => update({ ...prefs, reduceMotion })} />} />
    </div>
    {error && <p role="alert" className="ob-error">{error}</p>}
    <div className="set-actions appearance-footer">
      <span className="set-note">Changes apply immediately and stay on this Mac.</span>
      <button className="agent-action" onClick={() => change(() => {
        saveDisplayPrefs(DEFAULT_DISPLAY); setPrefs({ ...DEFAULT_DISPLAY });
        applyTheme("default"); setTheme("default"); applyMode("system"); setMode("system"); setScheme(resolvedScheme());
      })}>Reset appearance</button>
    </div>
  </>;
}

export default function SettingsPane({ client, wire, onClose }: { client: FezClient; wire: BrowserWire; onClose: () => void }) {
  const [name, setName] = useState(client.knownNames().get(client.pubkey) ?? "");
  const [status, setStatus] = useState(client.statusOf(client.pubkey) ?? "");
  const [relay, setRelay] = useState(relayRaw());
  const [media, setMedia] = useState(mediaServer());
  const [keyHex, setKeyHex] = useState<string>();
  // Written on every change rather than behind a save button: there is
  // nothing to publish and nothing to relaunch, so a save button would
  // only be a way to lose the change.
  const [notify, setNotifyState] = useState(loadNotifyPrefs);
  const setNotify = (next: NotifyPrefs) => {
    setNotifyState(next);
    saveNotifyPrefs(next);
  };
  // Either a built-in section, or "ext:<panel name>" — every installed
  // extension gets its own row rather than hiding behind one called
  // "extensions" inside a group also called "extensions".
  const [section, setSection] = useState<SettingsSection | `ext:${string}`>("profile");
  const [search, setSearch] = useState("");
  const extPanels = extensionSettingsPanels();
  const openExt = section.startsWith("ext:") ? extPanels.find((p) => `ext:${p.name}` === section) : undefined;
  const terms = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = (text: string) => terms.every(term => text.toLowerCase().includes(term));
  const groups = SETTINGS_GROUPS.map(group => ({ ...group, sections: group.sections.filter(key => matches(`${SETTINGS_TABS[key]} ${SETTINGS_SEARCH[key]}`)) })).filter(group => group.sections.length);
  const visibleExtensions = extPanels.filter(panel => matches(`${panel.label ?? norm(panel.name)} ${panel.name}`));

  const saveProfile = async () => {
    try {
      if (name.trim()) await client.setProfile(name.trim());
      await client.setStatus(status.trim());
      flash("✓ profile published");
    } catch (err) {
      flash(`✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const saveServers = async () => {
    setRelays(relay);
    try {
      await setMediaServer(media);
      flash("✓ saved");
    } catch (err) {
      // The relay half already landed; say what didn't rather than
      // reporting a success the agents will never see.
      flash(`✗ media server not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Saved-but-not-applied is read from storage vs boot, not from a flag
  // set by the save button — so the button also appears when you saved,
  // closed the pane, and came back still wondering why nothing changed.
  const needsRelaunch =
    (localStorage.getItem("fez-relay") ?? BOOT_RELAY) !== BOOT_RELAY ||
    (localStorage.getItem("fez-media-server") ?? BOOT_MEDIA) !== BOOT_MEDIA;

  const reveal = async () => {
    try {
      setKeyHex(await invoke<string>("get_identity", { account: ACCOUNT }));
    } catch (err) {
      flash(`✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // A full-screen takeover closes the way every screen does: Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="settings-screen">
      <nav className="settings-rail" aria-label="Settings">
        {/* Settings replaces the whole shell, so it needs its own
            light-well — without one the traffic lights sat on the back
            button. Same band, same grab bar as the main rail. */}
        <div className="rail-titlebar" data-tauri-drag-region />
        <button className="settings-back" onClick={onClose}>← Back to Fez</button>
        <input className="settings-search" type="search" aria-label="Search settings" placeholder="Search settings…"
          value={search} onChange={event => setSearch(event.target.value)} />
        {groups.map((group) => (
          <div key={group.label} className="settings-group">
            <div className="community-name"><span className="community-label">{group.label}</span></div>
            {group.sections.map((key) => (
              <button
                key={key}
                className={section === key ? "settings-nav-item active" : "settings-nav-item"}
                aria-current={section === key ? "page" : undefined}
                onClick={() => setSection(key)}
              >
                {SETTINGS_TABS[key]}
              </button>
            ))}
          </div>
        ))}
        {visibleExtensions.length > 0 && (
          <div className="settings-group">
            <div className="community-name"><span className="community-label">Extensions</span></div>
            {visibleExtensions.map((panel) => (
              <button
                key={panel.name}
                title={panel.name}
                className={section === `ext:${panel.name}` ? "settings-nav-item active" : "settings-nav-item"}
                aria-current={section === `ext:${panel.name}` ? "page" : undefined}
                onClick={() => setSection(`ext:${panel.name}`)}
              >
                {panel.label ?? norm(panel.name)}
              </button>
            ))}
          </div>
        )}
        {!groups.length && !visibleExtensions.length && <p className="settings-no-results" role="status">No settings found. Try “theme”, “sound”, or an extension name.</p>}
        <FezCorner />
      </nav>
      <div className="settings-body" key={section}>
      <div className="settings-col">
        {section === "profile" && (<>
        <Head title="profile" sub="How you appear to everyone on this relay. Both fields are public and signed by your key." />
        <div className="manage-section">you</div>
        <Row
          stacked
          label="display name"
          desc="The name on your messages, your DMs and every roster you appear in."
          control={
            <input className="manage-input" value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} placeholder="your name" />
          }
        />
        <Row
          stacked
          label="status"
          desc="A line under your name saying what you're up to. Leave it empty to clear it."
          control={
            <input className="manage-input" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="what you're up to" />
          }
        />
        <div className="set-actions">
          <button className="agent-action" onClick={() => void saveProfile()}>publish</button>
          <span className="set-note">published to the relay as a signed event</span>
        </div>

        </>)}
        {section === "servers" && (<>
        <Head title="servers" sub="Where fez connects: the relay that holds this workspace, and where your files go." />
        <div className="manage-section">workspace</div>
        <Row
          label="current workspace"
          desc={
            client.state.workspace.owner
              ? client.state.isOwner(client.pubkey)
                ? "You own this one — you can rename it and manage who's in it."
                : `Owned by ${client.displayName(client.state.workspace.owner)}.`
              : "Unclaimed — nobody has taken ownership of this relay yet."
          }
          control={<span className="set-value">{client.state.workspace.name}</span>}
        />
        {/* A relay IS a workspace, so changing this is not a setting in
            the ordinary sense — it moves you somewhere else. Saying so
            is the whole lesson from the time it looked like data loss,
            and the description is where it belongs: a bordered callout
            repeating it was a nested box the grammar already rejected. */}
        <Row
          stacked
          label="relay"
          desc="The relay is the workspace. Pointing fez at a different one takes you somewhere else entirely, with its own channels, members and name. Nothing is deleted — coming back restores it."
          control={<input className="manage-input" value={relay} spellCheck={false} onChange={(e) => setRelay(e.target.value)} />}
        />
        <Row
          stacked
          label="media server"
          desc="Blossom host for the images, video and file attachments you send."
          control={<input className="manage-input" value={media} spellCheck={false} onChange={(e) => setMedia(e.target.value)} />}
        />
        <div className="set-actions">
          <button className="agent-action" onClick={() => void saveServers()}>save</button>
          {needsRelaunch ? (
            <>
              <span className="set-note">saved — still connected to <strong>{BOOT_RELAY}</strong></span>
              {/* A reload IS the relaunch: every singleton (wire, client,
                  boot promise) is webview module state, and a fresh page
                  rebuilds them from what localStorage now says. */}
              <button className="agent-action" onClick={() => window.location.reload()}>relaunch now</button>
            </>
          ) : (
            <span className="set-note">applies on relaunch — the connection is built once at launch</span>
          )}
        </div>

        </>)}
        {section === "appearance" && <AppearanceSettings />}
        {section === "notifications" && (<>
        <Head title="notifications" sub="Native alerts on this machine. Muting a channel already silences its mentions — this is everything else." />
        <div className="manage-section">desktop alerts</div>
        <Row
          label="desktop alerts"
          desc="The master switch. Off means fez never raises a native notification, whatever the categories below say."
          control={<Toggle on={notify.enabled} onChange={(on) => setNotify({ ...notify, enabled: on })} label="desktop alerts" />}
        />
        <Row
          label="alert while I'm looking"
          desc="fez stays quiet about the window you already have open. Turn this on to be told anyway."
          control={
            <Toggle
              on={notify.whileFocused}
              disabled={!notify.enabled}
              onChange={(on) => setNotify({ ...notify, whileFocused: on })}
              label="alert while focused"
            />
          }
        />

        <div className="manage-section">what gets through</div>
        {NOTIFY_KINDS.filter(kind => !NOTIFY_UNBUILT.has(kind)).map((kind) => {
          return (
            <Row
              key={kind}
              label={NOTIFY_LABELS[kind].label}
              desc={NOTIFY_LABELS[kind].desc}
              control={
                  <span className="notify-controls">
                    {/* The picker sits with the toggle it belongs to: one
                        row per category, both of its decisions in reach. */}
                    {SOUND_NAMES.length > 0 && (
                      <>
                        <select
                          className="manage-select"
                          value={notify.sounds[kind]}
                          disabled={!notify.enabled || !notify.sound || !notify.kinds[kind]}
                          aria-label={`sound for ${NOTIFY_LABELS[kind].label}`}
                          onChange={(e) => setNotify({ ...notify, sounds: { ...notify.sounds, [kind]: e.target.value } })}
                        >
                          <option value="">silent</option>
                          {SOUND_NAMES.map((name) => (
                            <option key={name} value={name}>{name}</option>
                          ))}
                        </select>
                        <button
                          className="composer-tool"
                          title="preview"
                          disabled={!notify.sounds[kind]}
                          onClick={() => notify.sounds[kind] && playSound(notify.sounds[kind])}
                        >
                          ▶
                        </button>
                      </>
                    )}
                    <Toggle
                      on={notify.kinds[kind]}
                      disabled={!notify.enabled}
                      onChange={(on) => setNotify({ ...notify, kinds: { ...notify.kinds, [kind]: on } })}
                      label={NOTIFY_LABELS[kind].label}
                    />
                  </span>
              }
            />
          );
        })}

        <div className="manage-section">sound</div>
        <Row
          label="play a sound"
          desc="Alerts make a noise as well as a banner. Each category picks its own above — set one to silent to mute just that one."
          control={
            <Toggle
              on={notify.sound}
              disabled={!notify.enabled}
              onChange={(on) => setNotify({ ...notify, sound: on })}
              label="play a sound"
            />
          }
        />

        </>)}
        {section === "keyboard" && (<>
        <Head title="keyboard" sub="Rebind any shortcut. Click a key to record a new one." />
        <KeyboardSettings onNotice={flash} />
        </>)}
        {section === "skills" && (<>
        <Head title="secrets" sub="Add a key once and every agent you attach the skill to can use it. Keys go straight into the macOS keychain, never into files — saving is write-only, so nothing can read a value back." />
        <SkillSecretsSection onNotice={flash} />

        </>)}
        {section === "about" && (<>
          <Head title="About Fez" sub="Your desktop app and the extensions running here." />
          <div className="settings-about-brand"><AnimatedSprite sprite={SPRITES.fez} scale={4} /><div><strong>Fez Desktop</strong><span>Version {version}</span></div></div>
          <div className="manage-section">Extension status</div>
          {guiExtensionStatus().length ? <ul className="settings-extension-status">
            {guiExtensionStatus().map(ext => <li key={ext.name}><span>{norm(ext.name)}</span><span className={ext.ok ? "" : "ob-error"}>{ext.ok ? "Loaded" : `Couldn't load: ${ext.error ?? "Unknown error"}`}</span></li>)}
          </ul> : <p className="set-note">No extension interfaces are loaded.</p>}
        </>)}
        {/* Configuration lives HERE; the Extensions view is for finding,
            installing and removing. Panels that claim a channel source
            keep configuring from that source's rail group, where the
            thing they configure actually is. */}
        {/* fez supplies the head and the frame; the extension draws its
            own controls below it. An installed page then reads as part
            of the app rather than as a different application. */}
        {openExt ? (
          <div className="ext-settings">
            <Head title={openExt.label ?? norm(openExt.name)} sub="Account and preferences for this extension." />
            <ExtensionPanel panel={openExt} />
          </div>
        ) : section.startsWith("ext:") ? (
          <>
            <Head title="extension" sub="This one is no longer loaded — it was removed while its page was open." />
          </>
        ) : null}
        {section === "backup" && (<>
        <Head title="backup & identity" sub="Your key is your account. Nobody can reissue it for you, so this page is the one that matters." />
        <div className="manage-section">archive</div>
        <ArchiveExport client={client} wire={wire} account={ACCOUNT} onNotice={flash} />

        <div className="manage-section">encrypted backup</div>
        <BackupFlow account={ACCOUNT} onNotice={flash} />

        <div className="manage-section">identity</div>
        <Row
          stacked
          label="backup key"
          desc={'Your key lives in the macOS keychain (service "fez-keys"). Anyone holding it IS you — reveal it only to write it down somewhere safe.'}
          control={
            !keyHex ? (
              <button className="agent-action" onClick={() => void reveal()}>reveal backup key</button>
            ) : (
              <code className="ob-key" onClick={() => void navigator.clipboard.writeText(keyHex)} title="click to copy">
                {keyHex}
              </code>
            )
          }
        />

        <div className="manage-section">danger</div>
        <FactoryResetRow />
        </>)}
      </div>
      </div>
    </div>
  );
}

/**
 * Factory reset — the desktop door to `fez reset --factory`. The typed
 * confirmation is deliberate friction: this deletes the identity and
 * every agent key, and a deleted key cannot be reissued. localStorage is
 * cleared HERE (the onboarding stamp/snapshot, relay set, name) because
 * WebKit owns that store while the app runs; the Rust command wipes the
 * keychain and ~/.fez, then relaunches straight into onboarding.
 */
function FactoryResetRow() {
  const [armed, setArmed] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      localStorage.clear();
      await invoke("factory_reset"); // relaunches on success — nothing runs after this
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <Row
      stacked
      label="factory reset"
      desc="Deletes your identity and your agents' keys from the keychain, all of ~/.fez (settings, personas, runtimes, this machine's workspace relay data), and relaunches into onboarding. Irreversible — reveal and save your backup key first."
      control={
        !armed ? (
          <button className="quiet-danger" onClick={() => setArmed(true)}>factory reset…</button>
        ) : (
          <div className="ob-brain-auth">
            <input
              className="ob-input"
              placeholder={'type "reset" to confirm'}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={busy}
              autoFocus
            />
            <button className="quiet-danger" disabled={busy || typed.trim() !== "reset"} onClick={() => void go()}>
              {busy ? "resetting…" : "erase everything"}
            </button>
            <button className="agent-action" disabled={busy} onClick={() => { setArmed(false); setTyped(""); setError(undefined); }}>
              keep my stuff
            </button>
            {error && <span className="ob-error">{error}</span>}
          </div>
        )
      }
    />
  );
}

/**
 * Create-then-VERIFY backup (Buzz's BackupTestFlow): a backup you never
 * test is a wish. Step 1 downloads the passworded file; step 2 makes
 * you decrypt it before we call it done.
 */
function BackupFlow({ account, onNotice }: { account: string; onNotice: (text: string) => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [phase, setPhase] = useState<"idle" | "created" | "verified">("idle");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (password.length < 8) return onNotice("✗ password needs at least 8 characters");
    if (password !== confirm) return onNotice("✗ passwords don't match");
    setBusy(true);
    try {
      const keyHex = await invoke<string>("get_identity", { account });
      downloadText("fez-backup.json", await createBackup(keyHex, password));
      setPhase("created");
      onNotice("✓ downloaded fez-backup.json — now verify it below");
    } catch (err) {
      onNotice(`✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (file: File | undefined, testPassword: string) => {
    if (!file) return;
    setBusy(true);
    try {
      const keyHex = await invoke<string>("get_identity", { account });
      const restored = await openBackup(await file.text(), testPassword);
      if (restored !== keyHex) throw new Error("decrypted key doesn't match this identity");
      setPhase("verified");
      onNotice("✓ backup verified — it restores this exact identity");
    } catch (err) {
      onNotice(`✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  if (phase === "verified") {
    return <div className="settings-hint">✓ backup created and verified. Stash fez-backup.json somewhere safe — with the password, it IS your identity.</div>;
  }

  return (
    <>
      <Row
        stacked
        label="backup password"
        desc={'A passworded file that restores your identity on any machine (onboarding → "restore from backup"). At least 8 characters.'}
        control={
          <input
            className="manage-input"
            type="password"
            value={password}
            placeholder="backup password"
            onChange={(e) => setPassword(e.target.value)}
          />
        }
      />
      <Row
        stacked
        label="repeat it"
        desc="Typed twice, because a password you mistyped protects a file you can never open."
        control={
          <input
            className="manage-input"
            type="password"
            value={confirm}
            placeholder="repeat it"
            onChange={(e) => setConfirm(e.target.value)}
          />
        }
      />
      <div className="set-actions">
        <button className="agent-action" disabled={busy} onClick={() => void create()}>
          {busy ? "working…" : "create + download"}
        </button>
      </div>
      {phase === "created" && (
        <VerifyRow busy={busy} onVerify={(file, pw) => void verify(file, pw)} />
      )}
    </>
  );
}

function VerifyRow({ busy, onVerify }: { busy: boolean; onVerify: (file: File | undefined, password: string) => void }) {
  const [file, setFile] = useState<File>();
  const [password, setPassword] = useState("");
  return (
    <>
      <div className="manage-section">verify it</div>
      <Row
        stacked
        label="the file you just downloaded"
        desc="A backup you never opened is a wish. This decrypts it and checks it restores this exact identity."
        control={<input className="manage-input" type="file" accept=".json" onChange={(e) => setFile(e.target.files?.[0])} />}
      />
      <Row
        stacked
        label="the password again"
        desc="Typed from memory, not pasted — that is what you are testing."
        control={
          <input
            className="manage-input"
            type="password"
            value={password}
            placeholder="the password again"
            onChange={(e) => setPassword(e.target.value)}
          />
        }
      />
      <div className="set-actions">
        <button className="agent-action" disabled={busy || !file || !password} onClick={() => onVerify(file, password)}>
          verify backup
        </button>
      </div>
    </>
  );
}

/**
 * Local archive — Buzz's local-archive card, fez-shaped: every signed
 * event that involves you (authored, addressed, or in your channels),
 * pulled from the relay and sealed under a password. Data sovereignty
 * in one file: the relay could vanish tomorrow and this is your
 * history. Optionally bundles the identity key — then the file alone
 * (plus password) rebuilds everything anywhere.
 */
function ArchiveExport({
  client,
  wire,
  account,
  onNotice,
}: {
  client: FezClient;
  wire: BrowserWire;
  account: string;
  onNotice: (text: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [includeKey, setIncludeKey] = useState(false);
  const [busy, setBusy] = useState<string | false>(false);

  const exportArchive = async () => {
    if (password.length < 8) return onNotice("✗ password needs at least 8 characters");
    setBusy("collecting events…");
    try {
      const filters = [
        { authors: [client.pubkey], limit: 500 },
        { "#p": [client.pubkey], limit: 500 },
      ];
      {
        for (const channel of client.state.workspace.channels.values()) {
          filters.push({ "#h": [channel.id], limit: 500 } as never);
        }
      }
      const events = await wire.query(filters);
      events.sort((a, b) => a.created_at - b.created_at);
      const payload: Record<string, unknown> = {
        v: 1,
        kind: "fez-archive",
        exportedAt: new Date().toISOString(),
        pubkey: client.pubkey,
        relay: localStorage.getItem("fez-relay") ?? "",
        eventCount: events.length,
        events,
      };
      if (includeKey) payload.key = await invoke<string>("get_identity", { account });
      setBusy("encrypting…");
      downloadText("fez-archive.json", await sealText(JSON.stringify(payload), password));
      onNotice(`✓ archived ${events.length} events${includeKey ? " + identity" : ""} — fez-archive.json`);
      setPassword("");
    } catch (err) {
      onNotice(`✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Row
        stacked
        label="archive password"
        desc="Everything that involves you — messages, DMs (still wrapped), docs, memberships — up to 500 recent events per stream, sealed under this password. The relay could vanish; this file is your history."
        control={
          <input
            className="manage-input"
            type="password"
            value={password}
            placeholder="archive password (8+ chars)"
            onChange={(e) => setPassword(e.target.value)}
          />
        }
      />
      <Row
        label="include identity key"
        desc="The file alone can then rebuild everything, anywhere. Guard it exactly like the key."
        control={
          <input
            type="checkbox"
            checked={includeKey}
            aria-label="include identity key"
            onChange={(e) => setIncludeKey(e.target.checked)}
          />
        }
      />
      <div className="set-actions">
        <button className="agent-action" disabled={!!busy} onClick={() => void exportArchive()}>
          {busy || "export archive"}
        </button>
      </div>
    </>
  );
}
