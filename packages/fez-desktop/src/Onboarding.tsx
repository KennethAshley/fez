import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { nip44 } from "nostr-tools";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { BrowserWire } from "./wire";
import { openBackup } from "./backup";

/**
 * Where a fresh install lands. Mirrors src/settings.ts — the desktop
 * bundle deliberately doesn't depend on the CLI package. A generic
 * public relay carries the events but enforces none of fez's membership
 * gating, so channel content there is unlisted rather than private.
 */
const DEFAULT_RELAY = "wss://67-205-188-204.sslip.io";

const ACCOUNT = (import.meta as { env?: Record<string, string> }).env?.VITE_FEZ_ACCOUNT ?? "default";

/**
 * First-launch onboarding (Buzz's machine-onboarding decisions, fez-
 * shaped): welcome → relay → identity → name → backup note. The
 * existing-user path is fez pairing — the new device shows a command +
 * 6-digit SAS, the old device runs `fez pair send`, and the identity
 * arrives encrypted between ephemeral keys. Wire-compatible with the
 * CLI's pairing (same kind 24134, same URI, same SAS derivation).
 */

const KIND_PAIRING = 24134;
const PAIR_FRESHNESS_S = 120;

export function deriveSas(a: string, b: string): string {
  const [lo, hi] = [a.toLowerCase(), b.toLowerCase()].sort();
  const digest = sha256(new TextEncoder().encode(`fez-pair-sas:${lo}:${hi}`));
  // node's readUIntBE(0, 6) % 1e6, in float-safe arithmetic (2^48 < 2^53).
  const n = digest[0] * 2 ** 40 + digest[1] * 2 ** 32 + digest[2] * 2 ** 24 + digest[3] * 2 ** 16 + digest[4] * 256 + digest[5];
  return String(n % 1_000_000).padStart(6, "0");
}

type Step = "welcome" | "invite" | "pairing" | "restore" | "done";

export default function Onboarding({ onComplete }: { onComplete: (relayUrl: string) => void }) {
  const [step, setStep] = useState<Step>("welcome");
  // No relay question. A first-time user does not have an opinion about
  // WebSocket URLs, and asking produced the worst possible default:
  // whatever we prefilled. It lives in settings now, and an invite code
  // can add its own.
  const [relayUrl, setRelayUrl] = useState(localStorage.getItem("fez-relay") ?? DEFAULT_RELAY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [keyHex, setKeyHex] = useState<string>();
  const [name, setName] = useState("");
  const [showBackup, setShowBackup] = useState(false);

  /**
   * The whole happy path: a name, a key, a profile, in.
   *
   * These used to be three screens (identity → name → done) because they
   * are three things technically. They are one thing to the person doing
   * it, and every screen between "I want to try this" and "I am in it"
   * is a place to stop.
   */
  const start = async () => {
    setError(undefined);
    setBusy(true);
    try {
      const secret = generateSecretKey();
      const hex = bytesToHex(secret);
      await invoke("set_identity", { hex, account: ACCOUNT });
      setKeyHex(hex);
      localStorage.setItem("fez-relay", relayUrl);
      if (name.trim()) {
        // Best-effort: a profile that didn't publish is a display name to
        // fix later, not a reason to hold someone at the door.
        try {
          const wire = new BrowserWire(relayUrl.split(","), hex);
          await new Promise((r) => setTimeout(r, 600));
          await wire.publish({ kind: 0, tags: [], content: JSON.stringify({ name: name.trim() }) });
          wire.close();
        } catch { /* identity is what matters */ }
      }
      setStep("done");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  /** An invite names the relay its community lives on — add it to the set. */
  const acceptInvite = (code: string): boolean => {
    const match = /^fez-join:(.+)#([0-9a-f-]+)$/i.exec(code.trim());
    if (!match) {
      setError("that doesn't look like an invite — expected fez-join:<relay>#<community>");
      return false;
    }
    const [, relay, communityId] = match;
    const set = relayUrl.split(",").map((r) => r.trim()).filter(Boolean);
    if (!set.includes(relay)) set.unshift(relay);
    setRelayUrl(set.join(","));
    localStorage.setItem("fez-relay", set.join(","));
    // Joined after the identity exists — you cannot be a member before
    // you are anybody.
    localStorage.setItem("fez-pending-invite", communityId);
    setError(undefined);
    return true;
  };

  return (
    <div className="onboarding">
      <div className="ob-card">
        {step === "welcome" && (
          <>
            <div className="ob-logo">🧢</div>
            <h1>fez</h1>
            <p className="ob-lede">
              Communities for you and your agents. Your identity is a key on this machine, not an account on
              someone's server — and everything private is encrypted before it leaves.
            </p>
            <input
              className="ob-input"
              value={name}
              autoFocus
              spellCheck={false}
              placeholder="your name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) void start();
              }}
            />
            {error && <p className="ob-error">{error}</p>}
            <button className="ob-primary" disabled={busy} onClick={() => void start()}>
              {busy ? "setting up…" : name.trim() ? `continue as ${name.trim()}` : "get started"}
            </button>
            <div className="ob-alts">
              <button className="ob-link" onClick={() => setStep("invite")}>I have an invite</button>
              <button className="ob-link" onClick={() => setStep("pairing")}>I use fez on another device</button>
              <button className="ob-link" onClick={() => setStep("restore")}>restore from backup</button>
            </div>
          </>
        )}

        {step === "invite" && (
          <InviteStep
            error={error}
            onAccept={(code) => {
              if (acceptInvite(code)) setStep("welcome");
            }}
            onBack={() => {
              setError(undefined);
              setStep("welcome");
            }}
          />
        )}

        {step === "pairing" && (
          <PairingStep
            relayUrl={relayUrl.split(",")[0]}
            onPaired={(hex) => {
              setKeyHex(hex);
              setStep("done");
            }}
            onBack={() => setStep("welcome")}
          />
        )}

        {step === "restore" && (
          <RestoreStep
            onRestored={(hex) => {
              setKeyHex(hex);
              setStep("done");
            }}
            onBack={() => setStep("welcome")}
          />
        )}

        {step === "done" && (
          <>
            <div className="ob-logo">✓</div>
            <h2>You're in</h2>
            <p className="ob-lede">
              Your key lives in the macOS keychain. If you lose this machine without a backup, the identity is gone —
              that's the deal with owning it.
            </p>
            {keyHex && (
              <div className="ob-backup">
                {!showBackup ? (
                  <button className="ob-secondary" onClick={() => setShowBackup(true)}>reveal backup key (write it somewhere safe)</button>
                ) : (
                  <code className="ob-key" onClick={() => void navigator.clipboard.writeText(keyHex)} title="click to copy">
                    {keyHex}
                  </code>
                )}
              </div>
            )}
            <button className="ob-primary" onClick={() => onComplete(relayUrl)}>open fez</button>
          </>
        )}
      </div>
    </div>
  );
}

/** Restore from the encrypted backup created in settings. */
function RestoreStep({ onRestored, onBack }: { onRestored: (hex: string) => void; onBack: () => void }) {
  const [file, setFile] = useState<File>();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const restore = async () => {
    if (!file || !password) return;
    setBusy(true);
    setError(undefined);
    try {
      const hex = await openBackup(await file.text(), password);
      await invoke("set_identity", { hex, account: ACCOUNT });
      onRestored(hex);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2>Restore from backup</h2>
      <p className="ob-lede">The fez-backup.json you created in settings, plus its password.</p>
      <input className="ob-input" type="file" accept=".json" onChange={(e) => setFile(e.target.files?.[0])} />
      <input
        className="ob-input"
        type="password"
        value={password}
        placeholder="backup password"
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void restore();
        }}
      />
      {error && <p className="ob-error">{error}</p>}
      <button className="ob-primary" onClick={() => void restore()} disabled={busy || !file || !password}>
        {busy ? "decrypting…" : "restore identity"}
      </button>
      <button className="ob-secondary" onClick={onBack}>back</button>
    </>
  );
}

/**
 * The receive side of fez pairing, in the webview: ephemeral key, URI
 * for the old device, SAS confirm, encrypted key delivery. Speaks the
 * exact CLI protocol — the other side is `fez pair send "<uri>"`.
 */
function PairingStep({ relayUrl, onPaired, onBack }: { relayUrl: string; onPaired: (hex: string) => void; onBack: () => void }) {
  const [phase, setPhase] = useState<"waiting" | "sas" | "receiving" | "error">("waiting");
  const [sas, setSas] = useState<string>();
  const [error, setError] = useState<string>();
  const stateRef = useRef<{ ws?: WebSocket; secret?: Uint8Array; peer?: string; uri?: string; confirm?: (ok: boolean) => void }>({});

  useEffect(() => {
    const secret = generateSecretKey();
    const myPk = getPublicKey(secret);
    const uri = `fez-pair:${relayUrl}#${myPk}`;
    const ws = new WebSocket(relayUrl);
    stateRef.current = { ws, secret, uri };

    const send = (frame: unknown[]) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(frame));
    const sendPayload = (peer: string, payload: unknown) => {
      const event = finalizeEvent(
        {
          kind: KIND_PAIRING,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", peer]],
          content: nip44.encrypt(JSON.stringify(payload), nip44.getConversationKey(secret, peer)),
        },
        secret
      );
      send(["EVENT", event]);
    };

    ws.onopen = () => send(["REQ", "pair", { kinds: [KIND_PAIRING], "#p": [myPk] }]);
    ws.onmessage = (raw) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(raw.data as string);
      } catch {
        return;
      }
      if (msg[0] !== "EVENT") return;
      const event = msg[2] as { pubkey: string; created_at: number; content: string };
      if (Math.abs(Math.floor(Date.now() / 1000) - event.created_at) > PAIR_FRESHNESS_S) return;
      const state = stateRef.current;
      if (state.peer && event.pubkey !== state.peer) return;
      let payload: { type?: string; key?: string; reason?: string };
      try {
        payload = JSON.parse(nip44.decrypt(event.content, nip44.getConversationKey(secret, event.pubkey)));
      } catch {
        return;
      }
      if (payload.type === "hello" && !state.peer) {
        state.peer = event.pubkey;
        setSas(deriveSas(myPk, event.pubkey));
        setPhase("sas");
        state.confirm = (ok: boolean) => {
          if (!ok) {
            sendPayload(event.pubkey, { type: "abort", reason: "sas rejected on receiving device" });
            setError("cancelled — the codes didn't match");
            setPhase("error");
            return;
          }
          sendPayload(event.pubkey, { type: "sas-ok" });
          setPhase("receiving");
        };
      } else if (payload.type === "key" && typeof payload.key === "string") {
        const hex = payload.key.toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(hex)) return;
        sendPayload(event.pubkey, { type: "done" });
        void invoke("set_identity", { hex, account: ACCOUNT })
          .then(() => onPaired(hex))
          .catch((err) => {
            setError(String(err));
            setPhase("error");
          });
      } else if (payload.type === "abort") {
        setError(`the other device aborted: ${payload.reason ?? "unknown"}`);
        setPhase("error");
      }
    };
    ws.onerror = () => {
      setError("lost the relay connection");
      setPhase("error");
    };
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayUrl]);

  return (
    <>
      <h2>Pair from your other device</h2>
      {phase === "waiting" && (
        <>
          <p className="ob-lede">On the device that already has fez, run:</p>
          <code className="ob-key" onClick={() => void navigator.clipboard.writeText(`fez pair send "${stateRef.current.uri}"`)} title="click to copy">
            fez pair send "{stateRef.current.uri}"
          </code>
          <p className="ob-dim">waiting for it to connect…</p>
        </>
      )}
      {phase === "sas" && sas && (
        <>
          <p className="ob-lede">Both screens must show the same code:</p>
          <div className="ob-sas">
            {sas.slice(0, 3)} {sas.slice(3)}
          </div>
          <button className="ob-primary" onClick={() => stateRef.current.confirm?.(true)}>the codes match</button>
          <button className="ob-secondary" onClick={() => stateRef.current.confirm?.(false)}>they don't match</button>
        </>
      )}
      {phase === "receiving" && <p className="ob-lede">confirmed — receiving your identity (encrypted)…</p>}
      {phase === "error" && (
        <>
          <p className="ob-error">{error}</p>
          <button className="ob-secondary" onClick={onBack}>back</button>
        </>
      )}
      {phase !== "error" && <button className="ob-secondary" onClick={onBack}>back</button>}
    </>
  );
}

/**
 * Paste an invite. It names the relay its community lives on, so
 * accepting one WIDENS your relay set rather than moving you — a guest
 * should never have to reconfigure anything to walk through a door.
 */
function InviteStep({
  error,
  onAccept,
  onBack,
}: {
  error?: string;
  onAccept: (code: string) => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState("");
  return (
    <>
      <h2>Your invite</h2>
      <p className="ob-lede">Paste the code someone sent you. You'll join their community once your identity exists.</p>
      <input
        className="ob-input"
        value={code}
        autoFocus
        spellCheck={false}
        placeholder="fez-join:wss://…#…"
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && code.trim()) onAccept(code);
        }}
      />
      {error && <p className="ob-error">{error}</p>}
      <button className="ob-primary" disabled={!code.trim()} onClick={() => onAccept(code)}>
        accept invite
      </button>
      <button className="ob-secondary" onClick={onBack}>back</button>
    </>
  );
}
