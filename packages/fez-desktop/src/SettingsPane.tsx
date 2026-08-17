import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FezClient } from "@fez/client";
import { mediaServer } from "./upload";

const ACCOUNT = (import.meta as { env?: Record<string, string> }).env?.VITE_FEZ_ACCOUNT ?? "default";

/**
 * Settings — the small set that matters on a decentralized surface:
 * who you appear as (kind-0 profile, 30315 status), which relay and
 * media server you bring, and your key's escape hatch (backup reveal
 * from the keychain). Relay changes take effect on relaunch — the live
 * wire is a boot-time singleton by design.
 */

export default function SettingsPane({ client, onClose }: { client: FezClient; onClose: () => void }) {
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
