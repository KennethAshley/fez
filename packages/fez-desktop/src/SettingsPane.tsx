import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FezClient } from "@fez/client";
import { mediaServer } from "./upload";
import { createBackup, openBackup, sealText, downloadText } from "./backup";
import type { BrowserWire } from "./wire";
import { applyTheme, currentTheme, themeNames } from "./gui-extensions";

const ACCOUNT = (import.meta as { env?: Record<string, string> }).env?.VITE_FEZ_ACCOUNT ?? "default";

/**
 * Settings — the small set that matters on a decentralized surface:
 * who you appear as (kind-0 profile, 30315 status), which relay and
 * media server you bring, and your key's escape hatch (backup reveal
 * from the keychain). Relay changes take effect on relaunch — the live
 * wire is a boot-time singleton by design.
 */

export default function SettingsPane({ client, wire, onClose }: { client: FezClient; wire: BrowserWire; onClose: () => void }) {
  const [name, setName] = useState(client.knownNames().get(client.pubkey) ?? "");
  const [status, setStatus] = useState(client.statusOf(client.pubkey) ?? "");
  const [relay, setRelay] = useState(localStorage.getItem("fez-relay") ?? "ws://localhost:7777");
  const [media, setMedia] = useState(mediaServer());
  const [keyHex, setKeyHex] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(undefined), 5000);
  };

  const saveProfile = async () => {
    try {
      if (name.trim()) await client.setProfile(name.trim());
      await client.setStatus(status.trim());
      flash("✓ profile published");
    } catch (err) {
      flash(`✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const saveServers = () => {
    localStorage.setItem("fez-relay", relay.trim());
    localStorage.setItem("fez-media-server", media.trim());
    flash("✓ saved — relay changes apply on relaunch");
  };

  const reveal = async () => {
    try {
      setKeyHex(await invoke<string>("get_identity", { account: ACCOUNT }));
    } catch (err) {
      flash(`✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <aside className="pane">
      <header className="pane-head">
        <span>⚙ settings</span>
        <button className="pane-close" onClick={onClose}>✕</button>
      </header>
      <div className="pane-body">
        {notice && <div className="manage-notice">{notice}</div>}

        <div className="manage-section">profile</div>
        <div className="settings-field">
          <label>display name</label>
          <input className="manage-input" value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} placeholder="your name" />
        </div>
        <div className="settings-field">
          <label>status</label>
          <input className="manage-input" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="what you're up to (empty clears)" />
        </div>
        <button className="agent-action" onClick={() => void saveProfile()}>publish</button>

        <div className="manage-section">servers</div>
        <div className="settings-field">
          <label>relay (applies on relaunch)</label>
          <input className="manage-input" value={relay} spellCheck={false} onChange={(e) => setRelay(e.target.value)} />
        </div>
        <div className="settings-field">
          <label>media server (Blossom)</label>
          <input className="manage-input" value={media} spellCheck={false} onChange={(e) => setMedia(e.target.value)} />
        </div>
        <button className="agent-action" onClick={saveServers}>save</button>

        <div className="manage-section">appearance</div>
        <div className="settings-field">
          <label>theme (extension theme packs appear here)</label>
          <select
            className="manage-select"
            defaultValue={currentTheme()}
            onChange={(e) => applyTheme(e.target.value)}
          >
            {["default", ...themeNames()].map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>

        <div className="manage-section">agent defaults</div>
        <div className="settings-field">
          <label>default harness for new agents</label>
          <select
            className="manage-select"
            defaultValue={localStorage.getItem("fez-default-harness") ?? "claude-code"}
            onChange={(e) => localStorage.setItem("fez-default-harness", e.target.value)}
          >
            <option value="claude-code">claude-code</option>
            <option value="pi">pi</option>
          </select>
        </div>

        <div className="manage-section">archive</div>
        <ArchiveExport client={client} wire={wire} account={ACCOUNT} onNotice={flash} />

        <div className="manage-section">encrypted backup</div>
        <BackupFlow account={ACCOUNT} onNotice={flash} />

        <div className="manage-section">identity</div>
        <div className="settings-hint">
          Your key lives in the macOS keychain (service "fez-keys"). Anyone holding the backup IS you — reveal it
          only to write it somewhere safe.
        </div>
        {!keyHex ? (
          <button className="agent-action" onClick={() => void reveal()}>reveal backup key</button>
        ) : (
          <code className="ob-key" onClick={() => void navigator.clipboard.writeText(keyHex)} title="click to copy">
            {keyHex}
          </code>
        )}
      </div>
    </aside>
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
      <div className="settings-hint">
        A passworded file that restores your identity on any machine (onboarding → "restore from backup").
      </div>
      <div className="settings-field">
        <input
          className="manage-input"
          type="password"
          value={password}
          placeholder="backup password (8+ chars)"
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className="settings-field">
        <input
          className="manage-input"
          type="password"
          value={confirm}
          placeholder="repeat it"
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      <button className="agent-action" disabled={busy} onClick={() => void create()}>
        {busy ? "working…" : "create + download"}
      </button>
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
      <div className="settings-field">
        <input className="manage-input" type="file" accept=".json" onChange={(e) => setFile(e.target.files?.[0])} />
      </div>
      <div className="settings-field">
        <input
          className="manage-input"
          type="password"
          value={password}
          placeholder="the password again"
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <button className="agent-action" disabled={busy || !file || !password} onClick={() => onVerify(file, password)}>
        verify backup
      </button>
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
      for (const communityId of client.state.joined) {
        const community = client.state.communities.get(communityId);
        for (const channel of community?.channels.values() ?? []) {
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
      <div className="settings-hint">
        Everything that involves you — messages, DMs (still wrapped), docs, memberships — up to 500 recent events
        per stream, sealed under a password. The relay could vanish; this file is your history.
      </div>
      <div className="settings-field">
        <input
          className="manage-input"
          type="password"
          value={password}
          placeholder="archive password (8+ chars)"
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <label className="settings-check">
        <input type="checkbox" checked={includeKey} onChange={(e) => setIncludeKey(e.target.checked)} />
        include identity key (file alone can then rebuild everything — guard it like the key)
      </label>
      <button className="agent-action" disabled={!!busy} onClick={() => void exportArchive()}>
        {busy || "export archive"}
      </button>
    </>
  );
}
