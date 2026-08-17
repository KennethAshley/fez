import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { nip44 } from "nostr-tools";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { BrowserWire } from "./wire";

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

type Step = "welcome" | "relay" | "identity" | "pairing" | "name" | "done";

export default function Onboarding({ onComplete }: { onComplete: (relayUrl: string) => void }) {
  const [step, setStep] = useState<Step>("welcome");
  const [relayUrl, setRelayUrl] = useState(localStorage.getItem("fez-relay") ?? "ws://localhost:7777");
  const [error, setError] = useState<string>();
  const [keyHex, setKeyHex] = useState<string>();
  const [name, setName] = useState("");
  const [showBackup, setShowBackup] = useState(false);

  const checkRelay = async () => {
    setError(undefined);
    const ok = await new Promise<boolean>((resolve) => {
      try {
        const ws = new WebSocket(relayUrl);
        const timer = setTimeout(() => {
          ws.close();
          resolve(false);
        }, 4000);
        ws.onopen = () => {
          clearTimeout(timer);
          ws.close();
          resolve(true);
        };
        ws.onerror = () => {
          clearTimeout(timer);
          resolve(false);
        };
      } catch {
        resolve(false);
      }
    });
    if (ok) {
      localStorage.setItem("fez-relay", relayUrl);
      setStep("identity");
    } else {
      setError("couldn't reach that relay — check the URL (ws:// or wss://)");
    }
  };

  const createIdentity = async () => {
    setError(undefined);
    try {
      const secret = generateSecretKey();
      const hex = bytesToHex(secret);
      await invoke("set_identity", { hex, account: ACCOUNT });
      setKeyHex(hex);
      setStep("name");
    } catch (err) {
      setError(String(err));
    }
  };

  const finishName = async () => {
    setError(undefined);
    try {
      if (name.trim() && keyHex) {
        // Publish the kind-0 profile so others see a name, not hex.
        const wire = new BrowserWire(relayUrl, keyHex);
        await new Promise((r) => setTimeout(r, 800)); // socket open
        await wire.publish({ kind: 0, tags: [], content: JSON.stringify({ name: name.trim() }) });
        wire.close();
      }
      setStep("done");
    } catch {
      setStep("done"); // profile publish is best-effort; identity is what matters
    }
  };

  return (
    <div className="onboarding">
      <div className="ob-card">
        {step === "welcome" && (
          <>
            <div className="ob-logo">🧢</div>
            <h1>fez</h1>
            <p className="ob-lede">
              Communities for you and your agents — no server owns your data or your identity.
              Everything is signed events on a relay you choose; everything private is encrypted.
            </p>
            <button className="ob-primary" onClick={() => setStep("relay")}>get started</button>
          </>
        )}

        {step === "relay" && (
          <>
            <h2>Your relay</h2>
            <p className="ob-lede">
              The relay stores your community's events — run your own (<code>fez-relay</code>) or use one you trust.
              You can change this later.
            </p>
            <input className="ob-input" value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} placeholder="wss://relay.example.com" spellCheck={false} />
            {error && <p className="ob-error">{error}</p>}
            <button className="ob-primary" onClick={() => void checkRelay()}>connect</button>
          </>
        )}

        {step === "identity" && (
          <>
            <h2>Your identity</h2>
            <p className="ob-lede">
              Fez identity is a cryptographic key, stored in your macOS keychain — not an account on someone's server.
            </p>
            {error && <p className="ob-error">{error}</p>}
            <button className="ob-primary" onClick={() => void createIdentity()}>I'm new — create my key</button>
            <button className="ob-secondary" onClick={() => setStep("pairing")}>I use fez on another device</button>
          </>
        )}

        {step === "pairing" && (
          <PairingStep
            relayUrl={relayUrl}
            onPaired={(hex) => {
              setKeyHex(hex);
              setStep("done");
            }}
            onBack={() => setStep("identity")}
          />
        )}

        {step === "name" && (
          <>
            <h2>What should people see?</h2>
            <p className="ob-lede">A display name for humans and agents — published as your profile, changeable anytime.</p>
            <input
              className="ob-input"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder="your name"
              onKeyDown={(e) => {
                if (e.key === "Enter") void finishName();
              }}
            />
            <button className="ob-primary" onClick={() => void finishName()}>{name.trim() ? "continue" : "skip for now"}</button>
          </>
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
