import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { nip44 } from "nostr-tools";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { BrowserWire, rustSigner } from "./wire";
import { openBackup } from "./backup";
import { DEFAULT_RELAY, PAIRING_RELAY, setRelays } from "./relay";
import { type Step, nextStep, prevStep } from "./onboarding-steps";

export { nextStep, prevStep };

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

  // The Claude probe is lifted here (not local to HarnessStep) so the
  // defaults page can read the same READY-ness without re-detecting —
  // "installed but the page you're on right now didn't check" is not a
  // state either page should have to explain.
  const [claude, setClaude] = useState<ClaudeBrain>();
  const probeClaude = () =>
    invoke<string>("claude_brain_status")
      .then((json) => setClaude(JSON.parse(json) as ClaudeBrain))
      .catch(() => setClaude({ installed: false, authed: false, adapterReady: false }));
  useEffect(() => {
    // Once per visit to the page that cares, not once per app lifetime —
    // the guard is "haven't probed yet", not a ref, so navigating away
    // and back re-checks (e.g. after installing Claude Code and returning).
    if (step === "harness" && !claude) void probeClaude();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  const setupClaude = async () => {
    await invoke("ensure_claude_adapter");
    setClaude((c) => (c ? { ...c, adapterReady: true } : c));
  };
  const [brain, setBrain] = useState<Brain>({});

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
      // Cold path (no invite): this machine becomes the workspace — the
      // app spawns a local relay claimed by the new identity. An invite
      // instead means joining THEIR relay; no local spawn.
      let activeRelay = relayUrl;
      if (!localStorage.getItem("fez-pending-invite")) {
        activeRelay = await invoke<string>("ensure_local_relay", {
          owner: getPublicKey(secret),
          name: "your workspace",
        });
        setRelayUrl(activeRelay);
      }
      setRelays(activeRelay);
      // Buzz's harness page, fez-sized: one step that gives @fez a brain
      // before it ever speaks — so the first greeting is a working guide,
      // not an apology.
      setStep("harness");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  // TODO(task-9): this belongs in ProfileStep, run when the name is
  // collected and saved, not stapled onto the terminal "team" step. It
  // lives here for now because the welcome card no longer asks for a
  // name and profile/community are still placeholders.
  const completeLegacySetup = async () => {
    localStorage.setItem("fez-name", name.trim()); // the welcome opener greets by name
    if (name.trim() && keyHex) {
      // Best-effort: a profile that didn't publish is a display name to
      // fix later, not a reason to hold someone at the door.
      try {
        // Identity already exists — the wire signs via Rust custody, so
        // it gets the pubkey-bearing signer, never the secret.
        const secretBytes = Uint8Array.from(keyHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
        const wire = new BrowserWire(relayUrl.split(","), rustSigner(getPublicKey(secretBytes)));
        await new Promise((r) => setTimeout(r, 600));
        await wire.publish({ kind: 0, tags: [], content: JSON.stringify({ name: name.trim() }) });
        wire.close();
      } catch { /* identity is what matters */ }
    }
  };

  /**
   * An invite names the relay its community lives on — add it to the
   * set. Two shapes (Buzz's join page accepts both): a fez-join code, or
   * a bare community URL (wss://…) for "I already have a community" —
   * Builder Lab, the team relay, wherever your key is already known.
   */
  const acceptInvite = (code: string): boolean => {
    const trimmed = code.trim();
    const bare = /^wss?:\/\/.+/i.test(trimmed) ? trimmed : undefined;
    const match = /^fez-join:(.+)#([0-9a-f-]+)$/i.exec(trimmed);
    if (!bare && !match) {
      setError("that doesn't look like an invite — paste a fez-join:… code or the community's wss:// URL");
      return false;
    }
    const relay = bare ?? match![1];
    const set = relayUrl.split(",").map((r) => r.trim()).filter(Boolean);
    if (!set.includes(relay)) set.unshift(relay);
    setRelayUrl(set.join(","));
    setRelays(set);
    // Joined after the identity exists — you cannot be a member before
    // you are anybody. The stored value is the RELAY: the workspace IS
    // the relay, and boot opens exactly this URL.
    localStorage.setItem("fez-pending-invite", relay);
    setError(undefined);
    return true;
  };

  return (
    <div className="onboarding">
      <div className="ob-card">
        {step === "welcome" && (
          <>
            {/* The wordmark IS the name — an <h1>fez</h1> under it just
                said it twice. That only read as sensible while the logo
                was an emoji standing in for a logo. */}
            <div className="ob-logo">fez<span className="ob-tri">▴</span></div>
            <p className="ob-lede">
              Communities for you and your agents. Your identity is a key on this machine, not an account on
              someone's server — and everything private is encrypted before it leaves.
            </p>
            {error && <p className="ob-error">{error}</p>}
            <button className="ob-primary" disabled={busy} onClick={() => void start()}>
              {busy ? "setting up…" : "get started"}
            </button>
            <div className="ob-alts">
              <button className="ob-link" onClick={() => setStep("invite")}>I have an invite or a community</button>
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
            relayUrl={PAIRING_RELAY /* rendezvous: both devices must reach it — loopback can't */}
            onPaired={(hex) => {
              setKeyHex(hex);
              // The paired identity gets a local workspace here too — the
              // pairing protocol moves the KEY, not the old device's
              // workspace set, and a stored loopback default with no relay
              // behind it would boot dead. Best-effort: on failure the
              // manage (+) doors still let them join a workspace.
              void invoke<string>("ensure_local_relay", {
                owner: getPublicKey(Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)))),
                name: "your workspace",
              })
                .then((url) => setRelays(url))
                .catch(() => {});
              setStep("reconnect");
            }}
            onBack={() => setStep("welcome")}
          />
        )}

        {step === "restore" && (
          <RestoreStep
            onRestored={(hex) => {
              setKeyHex(hex);
              // A restored identity gets a local workspace too — restore
              // moves the KEY, not a relay set, and this path used to set
              // neither: the app booted against the loopback default with
              // nothing behind it and sat at "reconnecting…" forever.
              // Best-effort, same shape as pairing; the boot self-heal in
              // App.tsx catches a failure here.
              void invoke<string>("ensure_local_relay", {
                owner: getPublicKey(Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)))),
                name: "your workspace",
              })
                .then((url) => setRelays(url))
                .catch(() => {});
              setStep("reconnect");
            }}
            onBack={() => setStep("welcome")}
          />
        )}

        {step === "reconnect" && <ReconnectStep onNext={() => setStep("harness")} />}

        {step === "harness" && (
          <HarnessStep
            claude={claude}
            onProbe={probeClaude}
            onSetup={setupClaude}
            onNext={() => setStep(nextStep("harness"))}
            onBack={() => setStep(prevStep("harness"))}
          />
        )}

        {step === "defaults" && (
          <DefaultsStep
            claudeReady={!!claude?.installed && !!claude?.authed && !!claude?.adapterReady}
            brain={brain}
            setBrain={setBrain}
            onNext={() => setStep(nextStep("defaults"))}
            onBack={() => setStep(prevStep("defaults"))}
          />
        )}

        {step === "community" && (
          <PlaceholderStep step="community" onBack={() => setStep(prevStep("community"))} onNext={() => setStep(nextStep("community"))} />
        )}

        {step === "profile" && (
          <>
            {/* The one placeholder with real content this task: the name
                field that used to live on the welcome card now lives
                here, where it belongs — Task 9 builds out the rest of
                ProfileStep (avatar, etc.) around it. */}
            <h2>profile</h2>
            <input
              className="ob-input"
              value={name}
              autoFocus
              spellCheck={false}
              placeholder="your name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setStep(nextStep("profile"));
              }}
            />
            <button className="ob-primary" onClick={() => setStep(nextStep("profile"))}>continue</button>
            <button className="ob-secondary" onClick={() => setStep(prevStep("profile"))}>back</button>
          </>
        )}

        {step === "team" && (
          <>
            {/* Task 9 replaces this with the real TeamStep (roster +
                backup-key reveal); the "you're in" content stays here for
                now so the wizard is still walkable end-to-end. */}
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
            <button
              className="ob-primary"
              onClick={() => {
                void completeLegacySetup().finally(() => onComplete(relayUrl));
              }}
            >
              open fez
            </button>
            <button className="ob-secondary" onClick={() => setStep(prevStep(step))}>back</button>
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
      <h2>Join a community</h2>
      <p className="ob-lede">
        Paste an invite code, or the community's relay URL if you already know it. You'll join once your identity
        exists.
      </p>
      <input
        className="ob-input"
        value={code}
        autoFocus
        spellCheck={false}
        placeholder="fez-join:… or wss://…"
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

/**
 * Placeholder body for community/profile — Task 9 fills these in with
 * the real pages (join/create/reconnect, name + avatar). Keeping a
 * generic shell here means the wizard is walkable end-to-end at every
 * commit on this branch, not just once the real pages land.
 */
function PlaceholderStep({ step, onBack, onNext }: { step: Step; onBack: () => void; onNext: () => void }) {
  return (
    <>
      <h2>{step}</h2>
      <button className="ob-primary" onClick={onNext}>continue</button>
      <button className="ob-secondary" onClick={onBack}>back</button>
    </>
  );
}

/**
 * The reconnect page (Buzz's "I already have a community", fez-shaped):
 * pairing and restore move your KEY, not the old machine's workspace
 * list — so a second device knows who you are but not where you live.
 * Enter the relay URLs of communities you're already part of; your key
 * is your membership, nothing to re-apply for. Added relays go FIRST so
 * you land in the community you came back for, with the local workspace
 * still in the set behind it.
 */
function ReconnectStep({ onNext }: { onNext: () => void }) {
  const [url, setUrl] = useState("");
  const [added, setAdded] = useState<string[]>([]);
  const [error, setError] = useState<string>();

  const add = () => {
    const trimmed = url.trim();
    if (!/^wss?:\/\/.+/i.test(trimmed)) {
      setError("a community URL starts with wss:// (or ws:// for local)");
      return;
    }
    setError(undefined);
    const current = localStorage.getItem("fez-relay")?.split(",").map((r) => r.trim()).filter(Boolean) ?? [];
    const next = [...new Set([...added, trimmed, ...current])];
    setRelays(next);
    setAdded([...new Set([...added, trimmed])]);
    setUrl("");
  };

  return (
    <>
      <h2>Reconnect your communities</h2>
      <p className="ob-lede">
        Your identity travelled; your community list didn't. Enter the relay URL of a community you're already in —
        your key is your membership.
      </p>
      <div className="ob-brain-auth">
        <input
          className="ob-input"
          value={url}
          autoFocus
          spellCheck={false}
          placeholder="wss://relay.example"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim()) add();
          }}
        />
        <button className="ob-secondary" disabled={!url.trim()} onClick={add}>add</button>
      </div>
      {added.map((a) => (
        <p key={a} className="ob-brain-hint">✓ {a}</p>
      ))}
      {error && <p className="ob-error">{error}</p>}
      <button className="ob-primary" onClick={onNext}>{added.length > 0 ? "continue" : "skip — just this machine"}</button>
    </>
  );
}

interface ClaudeBrain {
  installed: boolean;
  authed: boolean;
  adapterReady: boolean;
}

/**
 * The brain @fez ends up with, threaded through defaults → (Task 9)
 * finish, where it becomes a single `write_persona` call. Nothing here
 * writes a persona — that happens once, on wizard completion, so a user
 * who changes their mind three times on this page never leaves a
 * half-written file behind.
 */
interface Brain {
  harness?: "pi" | "claude-code";
  providerId?: string;
  provider?: string;
  model?: string;
  effort?: string;
}

/**
 * Buzz's harness grid, fez-sized: two cards, purely informational — no
 * selection happens here, because it's not a choice yet, it's a status
 * check. Fez ships with the app and is always ready; Claude Code is
 * detected live and walked through install → sign-in → one-time bridge
 * setup. The actual "what does @fez run on" choice is the next page.
 */
function HarnessStep({
  claude,
  onProbe,
  onSetup,
  onNext,
  onBack,
}: {
  claude?: ClaudeBrain;
  onProbe: () => void;
  onSetup: () => Promise<void>;
  onNext: () => void;
  onBack: () => void;
}) {
  const [settingUp, setSettingUp] = useState(false);
  const [error, setError] = useState<string>();

  return (
    <>
      <h2>Your agent harnesses</h2>
      <p className="ob-lede">fez checked this machine. Fez ships with the app; Claude Code is detected if you have it.</p>
      <div className="ob-brains">
        <div className="ob-brain">
          <span className="ob-brain-name">Fez</span>
          <span className="ob-brain-pill ready">READY</span>
          <span className="ob-brain-hint">ships with fez — bring a model key on the next page</span>
        </div>

        <button
          className={`ob-brain ${claude?.installed ? "" : "unavailable"}`}
          disabled={settingUp}
          onClick={() => {
            if (!claude?.installed) return void openBrainInstall();
            if (!claude.authed) return; // SIGN IN state — the hint says how
            if (claude.adapterReady) return; // already READY — nothing to do
            // One-time bridge setup: the managed node runtime + the ACP
            // adapter as a real node program (compiling it was tried and
            // is impossible — its SDK loads dynamically).
            setSettingUp(true);
            setError(undefined);
            void onSetup()
              .catch((err) => setError(err instanceof Error ? err.message : String(err)))
              .finally(() => setSettingUp(false));
          }}
        >
          <span className="ob-brain-name">Claude Code</span>
          {!claude ? (
            <span className="ob-brain-pill">CHECKING…</span>
          ) : !claude.installed ? (
            <>
              <span className="ob-brain-pill">INSTALL</span>
              <span className="ob-brain-hint">not detected — opens the install page</span>
            </>
          ) : !claude.authed ? (
            <>
              <span className="ob-brain-pill">SIGN IN</span>
              <span className="ob-brain-hint">
                installed but signed out — run <code>claude /login</code> in Terminal, then{" "}
                <a
                  onClick={(e) => {
                    e.stopPropagation();
                    void onProbe();
                  }}
                >
                  check again
                </a>
              </span>
            </>
          ) : settingUp ? (
            <>
              <span className="ob-brain-pill">SETTING UP…</span>
              <span className="ob-brain-hint">first-time bridge install (~30s) — one time only</span>
            </>
          ) : claude.adapterReady ? (
            <>
              <span className="ob-brain-pill ready">READY</span>
              <span className="ob-brain-hint">signed in — uses your Claude subscription</span>
            </>
          ) : (
            <>
              <span className="ob-brain-pill">SET UP</span>
              <span className="ob-brain-hint">signed in — click to install the bridge (one time, ~30s)</span>
            </>
          )}
        </button>
      </div>
      {error && <p className="ob-error">{error}</p>}
      <button className="ob-primary" onClick={onNext}>continue</button>
      <button className="ob-secondary" onClick={onBack}>back</button>
    </>
  );
}

/** The vendor's install page — fez never curls-pipes-bash on your behalf. */
async function openBrainInstall(): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl("https://claude.com/claude-code");
}

/** The v1 provider table (mirrors the Rust `provider_spec` list). */
export const PROVIDERS = [
  { id: "chutes", label: "Chutes", hint: "decentralized GPUs — chutes.ai" },
  { id: "anthropic", label: "Anthropic", hint: "api key from console.anthropic.com" },
  { id: "openai", label: "OpenAI", hint: "api key from platform.openai.com" },
  { id: "openrouter", label: "OpenRouter", hint: "one key, many models — openrouter.ai" },
];
export const CLAUDE_MODELS = ["default", "opus", "sonnet", "haiku"];
export const EFFORTS = ["low", "medium", "high"];

/**
 * What @fez runs on, chosen once and changeable later in Settings. Two
 * shapes: Claude Code (nothing to configure — it uses your subscription,
 * gated on the harness page's READY state) or Fez/pi (pick a provider,
 * paste a key, verify it against a live model list — Buzz's page-4
 * verification, generalized past Chutes to the four-provider table).
 */
function DefaultsStep({
  claudeReady,
  brain,
  setBrain,
  onNext,
  onBack,
}: {
  claudeReady: boolean;
  brain: Brain;
  setBrain: (b: Brain) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const [providerKey, setProviderKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const verify = async () => {
    if (!brain.providerId) return;
    setBusy(true);
    setError(undefined);
    try {
      if (providerKey.trim()) {
        const spec = { chutes: "CHUTES_API_KEY", anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" } as const;
        await invoke("set_skill_secret", { skill: brain.providerId, key: spec[brain.providerId as keyof typeof spec], value: providerKey.trim() });
      }
      const json = await invoke<string>("wire_provider_pi", { provider: brain.providerId });
      const r = JSON.parse(json) as { provider: string; models: string[] };
      setModels(r.models);
      setBrain({ ...brain, harness: "pi", provider: r.provider, model: r.models[0], effort: brain.effort ?? "medium" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2>Configure your defaults</h2>
      <p className="ob-lede">Your agents run on this unless you give one its own setup — changeable any time in Settings.</p>
      <label className="ob-label">default harness</label>
      <select
        className="ob-input"
        value={brain.harness ?? ""}
        onChange={(e) => {
          setModels([]);
          setBrain({ ...brain, harness: e.target.value as Brain["harness"], providerId: undefined, provider: undefined, model: undefined });
        }}
      >
        <option value="">choose…</option>
        <option value="pi">Fez</option>
        {claudeReady && <option value="claude-code">Claude Code</option>}
      </select>

      {brain.harness === "claude-code" && (
        <>
          <label className="ob-label">model</label>
          <select className="ob-input" value={brain.model ?? "default"} onChange={(e) => setBrain({ ...brain, model: e.target.value })}>
            {CLAUDE_MODELS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <span className="ob-brain-hint">uses your Claude subscription</span>
        </>
      )}

      {brain.harness === "pi" && (
        <>
          <label className="ob-label">provider</label>
          <select
            className="ob-input"
            value={brain.providerId ?? ""}
            onChange={(e) => {
              setModels([]);
              setBrain({ ...brain, providerId: e.target.value, provider: undefined, model: undefined });
            }}
          >
            <option value="">choose…</option>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          {brain.providerId && models.length === 0 && (
            <div className="ob-brain-auth">
              <input
                className="ob-input"
                type="password"
                placeholder={`${PROVIDERS.find((p) => p.id === brain.providerId)?.label} API key`}
                value={providerKey}
                spellCheck={false}
                onChange={(e) => setProviderKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busy) void verify();
                }}
              />
              <button className="ob-secondary" disabled={busy} onClick={() => void verify()}>
                {busy ? "checking…" : "verify"}
              </button>
              <span className="ob-brain-hint">{PROVIDERS.find((p) => p.id === brain.providerId)?.hint}</span>
            </div>
          )}
          {models.length > 0 && (
            <>
              <label className="ob-label">model</label>
              <select className="ob-input" value={brain.model ?? ""} onChange={(e) => setBrain({ ...brain, model: e.target.value })}>
                {models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <label className="ob-label">effort</label>
              <select className="ob-input" value={brain.effort ?? "medium"} onChange={(e) => setBrain({ ...brain, effort: e.target.value })}>
                {EFFORTS.map((e2) => (
                  <option key={e2} value={e2}>{e2}</option>
                ))}
              </select>
            </>
          )}
        </>
      )}

      {error && <p className="ob-error">{error}</p>}
      <button className="ob-primary" disabled={busy || (brain.harness === "pi" && !brain.model)} onClick={onNext}>
        {brain.harness === "pi" && brain.model ? `continue with ${brain.model}` : brain.harness === "claude-code" ? "continue with Claude Code" : "continue"}
      </button>
      <div className="ob-alts">
        <button className="ob-link" onClick={onNext}>skip for now</button>
      </div>
      <button className="ob-secondary" onClick={onBack}>back</button>
    </>
  );
}
