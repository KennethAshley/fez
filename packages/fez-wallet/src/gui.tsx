import type { GuiClient, GuiExtensionApi } from "@fezchat/extension-api/gui";
import type { SpendEntry } from "./log.js";
import type { Network } from "./storage-mirror.js";
import qrcode from "qrcode-generator";
import {
  parseConsentRequest,
  requestStatus,
  parseReceiveAddress,
  personaFor,
  matchSpend,
  remainingText,
  extractAddresses,
  logsFor,
  networkLabel,
  validThreshold,
  mergeThresholds,
  receiptAmount,
  playMoneyBadge,
  receiptStateText,
  isRenderableReceipt,
  panelEndpoint,
  resolveNetwork,
  ledgerTime,
  erc20BalanceCall,
  parseUsdcBalance,
  validUsd,
  x402TxLink,
  x402NetworkLabel,
  X402_NETWORKS,
  X402_DISPLAY,
} from "./gui-logic.js";
import type { X402MirrorRow, X402Meta } from "./storage-mirror.js";
import { parseReceipt, type ParsedReceipt } from "./receipt.js";
import type { SignedNostrEvent } from "./consent.js";

/** `toggleReaction`, `msgById` and `myReactionTo` aren't in the shared
 * GuiClient slice (extension-api types only what most gui parts need) —
 * reach for them the way fez-git reaches under GuiClient for things it
 * needs, typed against what's actually used (fez-client:738, :922, :930). */
interface WalletClient extends GuiClient {
  /** pk → persona name — the derive ceremony offers accounts for the
   * agents this workspace actually has (elevenlabs reaches for the same
   * member, same reasoning: typed against what's actually used). */
  agents(): Map<string, string>;
  msgById(id: string): { authorPk: string; ts: number } | undefined;
  /** My own live reaction on a target, if any (fez-client:922) — keyed by
   * MY pubkey, which is exactly the owner check this card needs: the
   * person viewing the wallet's consent card in their own client IS the
   * owner whose ✅/❌ is authoritative. */
  myReactionTo(targetId: string, emoji: string): string | undefined;
  /** WHEN that reaction was placed (seconds) — requestStatus only counts
   * a decision made inside the consent window. */
  myReactionTimeTo(targetId: string, emoji: string): number | undefined;
  toggleReaction(channelId: string, targetId: string, emoji: string): Promise<void>;
  /** Payment receipts (47040) e-tagging one message, verbatim (fez-client's
   * own paymentReceiptsFor()) — the AUTHENTICATED connection the desktop
   * already maintains. A bare relay pool was tried here first and reverted:
   * fez's relays are membership-gated (NIP-42), and an anonymous pool
   * connection gets silently refused reads on one — indistinguishable from
   * "nobody has paid anyone yet". Only `client`'s own connection has
   * already authenticated. */
  paymentReceiptsFor(targetId: string): readonly SignedNostrEvent[];
  /** Restates GuiClient's own `on` overload alongside the new one: TS
   * does not merge a narrower override of an inherited method, it
   * replaces it, so both signatures have to be spelled out here. */
  on(event: "channelsChanged", handler: () => void): () => void;
  /** Fires once a live receipt lands e-tagging `targetId`, so an
   * already-open message can pick it up without a remount. */
  on(event: "paymentReceipt", handler: (channelId: string, targetId: string) => void): () => void;
}

type AddressBook = { treasury?: string; personas?: Record<string, string> };

/**
 * fez-wallet, GUI part — the consent inbox, receive cards, and the
 * treasury window.
 *
 * Approve/Decline publish the owner's ordinary ✅/❌ reaction — the
 * exact event the wallet's awaitDecision trusts. The buttons are
 * convenience, not a second consent mechanism. Balances are public
 * chain reads; addresses/endpoint/history come from the read-only
 * storage seam (the CLI/MCP wrote them there — the webview can't read
 * wallet.json and shouldn't).
 *
 * Cards only render for the persona's OWN message: `msgById(msgId)`
 * gives the actual poster's pubkey, compared against `pkByName(persona)`
 * resolved from the parsed name. Any other rostered member echoing the
 * format under their own message renders a plain bubble — no buttons
 * (and no address anyone might pay) lent to a message that authorizes
 * nothing.
 *
 * JSX with `--jsx-factory=h` (the shared-React shape): the markup reads
 * as markup and compiles to the same host-React createElement calls —
 * one React on the page, nothing bundled.
 */

export default function activate(api: GuiExtensionApi): void {
  const h = api.React.createElement;
  const { useState, useEffect, useCallback, useRef } = api.React;
  const client = api.client as WalletClient;
  if (!client) return; // read:channels ungranted — nothing works without it

  const shortAddr = (s: string) => (s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);

  /** WKWebView doesn't always grant navigator.clipboard — fall back to
   * the selection dance so copy never silently does nothing. */
  const copyText = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
  };

  const card = {
    border: "1px solid var(--hairline, #333)",
    borderRadius: 8,
    padding: 10,
    marginTop: 6,
    background: "var(--bg1, transparent)",
    maxWidth: 440,
  };
  const dim = { opacity: 0.75, fontSize: 12 };
  /** The host app's section-label grammar: mono caps, then a hairline
   * running out to the edge. Built here because a gui part cannot reach
   * App.css's classes. */
  const sectionLabel = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontFamily: "var(--font-mono, monospace)",
    fontSize: 10.5,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: "var(--fg-dim, #999)",
  };
  const labelRule = { flex: 1, height: 1, background: "var(--hairline, #333)" };
  const Label = (text: string): JSX.Element => (
    <div style={sectionLabel}>
      {text}
      <span style={labelRule} />
    </div>
  );
  const mono = { fontFamily: "var(--font-mono, monospace)", fontSize: 12 };

  /* The spend ledger's cells. `.wallet-ledger` was set as a className and
     nothing anywhere styled it, so the table rendered with browser
     defaults: centred bold headers, no padding, and — the visible fault —
     no white-space rule, so a truncated address and a tx link still broke
     across two lines. Every cell here holds an identifier that is wrong
     when wrapped; memo is the only one that may give up its width. */
  const th = {
    textAlign: "left" as const,
    fontFamily: "var(--font-mono, monospace)",
    fontSize: 10.5,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    fontWeight: 400,
    color: "var(--fg-dim, #999)",
    padding: "0 10px 6px 0",
    borderBottom: "1px solid var(--hairline, #333)",
    whiteSpace: "nowrap" as const,
  };
  const td = {
    fontSize: 12,
    padding: "7px 10px 7px 0",
    borderTop: "1px solid var(--hairline, #333)",
    whiteSpace: "nowrap" as const,
    verticalAlign: "middle" as const,
  };
  const tdDim = { ...td, color: "var(--fg-dim, #999)" };
  const tdMono = { ...td, fontFamily: "var(--font-mono, monospace)", color: "var(--fg-dim, #999)" };
  const memoBox = {
    maxWidth: 110,
    overflow: "hidden",
    textOverflow: "ellipsis" as const,
    whiteSpace: "nowrap" as const,
  };

  function CopyButton({
    text,
    label = "copy",
    title = "copy full address",
  }: {
    text: string;
    label?: string;
    title?: string;
  }): JSX.Element {
    const [copied, setCopied] = useState(false);
    return (
      <button
        className="skill-link"
        title={title}
        onClick={() => {
          void copyText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "copied ✓" : label}
      </button>
    );
  }

  /** The address as an SVG QR — generated in-bundle, no network. */
  function Qr({ text }: { text: string }): JSX.Element {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const cells: JSX.Element[] = [];
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++)
        if (qr.isDark(r, c)) cells.push(<rect key={`${r}-${c}`} x={c} y={r} width={1} height={1} />);
    return (
      <svg
        viewBox={`-2 -2 ${n + 4} ${n + 4}`}
        width={160}
        height={160}
        style={{ background: "#fff", borderRadius: 6, marginTop: 8, display: "block" }}
      >
        <g fill="#000">{cells}</g>
      </svg>
    );
  }

  /** One address, everywhere it appears: short form (full in the hover
   * title), copy, and a QR the owner can flip open to scan. */
  function AddressRow({ address }: { address: string }): JSX.Element {
    const [qrOpen, setQrOpen] = useState(false);
    return (
      <div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={mono} title={address}>
            {shortAddr(address)}
          </span>
          <CopyButton text={address} />
          <button className="skill-link" onClick={() => setQrOpen(!qrOpen)}>
            {qrOpen ? "hide QR" : "QR"}
          </button>
        </div>
        {qrOpen ? <Qr text={address} /> : null}
      </div>
    );
  }

  /** The mirrored address book, for naming recipients. */
  function useAddressBook(): AddressBook {
    const [book, setBook] = useState<AddressBook>({});
    useEffect(() => {
      void api.storage.get("addresses").then((a) => setBook((a as AddressBook) ?? {}));
    }, []);
    return book;
  }

  // ── consent cards ────────────────────────────────────────────────
  api.registerMessageDecorator(
    (content) => parseConsentRequest(content) !== undefined,
    ({ content, msgId, channelId }) => {
      const req = parseConsentRequest(content);
      if (!req) return null as never;
      // The card must be bound to the persona's OWN message — not merely
      // to a rostered member who happens to know the format. If either
      // lookup is unavailable, render nothing but the plain bubble.
      const msg = client.msgById(msgId);
      const personaPk = client.pkByName(req.persona);
      if (!msg || !personaPk || msg.authorPk !== personaPk) return null as never;
      return <ConsentCard req={req} msgId={msgId} channelId={channelId} msgTs={msg.ts} />;
    }
  );

  function ConsentCard({
    req,
    msgId,
    channelId,
    msgTs,
  }: {
    req: { persona: string; amount: string; to: string; memo?: string; notes?: string[] };
    msgId: string;
    channelId: string;
    msgTs: number;
  }): JSX.Element {
    const book = useAddressBook();
    const [now, setNow] = useState(Date.now() / 1000);
    const [spend, setSpend] = useState<{ txHash: string } | undefined>(undefined);

    const react = (emoji: string) => () => void client.toggleReaction(channelId, msgId, emoji);
    // The TIME of each reaction rides along: requestStatus only counts a
    // decision made inside the consent window, so a late ✅ renders as
    // expired instead of "waiting for a transfer" the wallet refused.
    const approvedTs = client.myReactionTimeTo(msgId, "✅");
    const declinedTs = client.myReactionTimeTo(msgId, "❌");
    const reactions: { content: string; authorPk: string; ts: number }[] = [
      ...(approvedTs !== undefined ? [{ content: "✅", authorPk: client.pubkey, ts: approvedTs }] : []),
      ...(declinedTs !== undefined ? [{ content: "❌", authorPk: client.pubkey, ts: declinedTs }] : []),
    ];
    const status = requestStatus(reactions, client.pubkey, msgTs, now);

    // A pending card counts down; the tick stops mattering (and is torn
    // down) once a decision or expiry lands.
    useEffect(() => {
      if (status !== "pending") return;
      const t = setInterval(() => setNow(Date.now() / 1000), 30_000);
      return () => clearInterval(t);
    }, [status]);

    // After approval, the transfer's ledger entry is the receipt — poll
    // the mirrored log briefly until it lands, then stop for good.
    useEffect(() => {
      if (status !== "approved" || spend) return;
      let dead = false;
      let tries = 0;
      const look = async () => {
        const logs = (await api.storage.get("logs")) as Partial<Record<Network, SpendEntry[]>> | undefined;
        const network = (await api.storage.get("network")) as Network | undefined;
        const hit = matchSpend(req, msgTs, logsFor(logs, network));
        if (dead) return;
        if (hit) setSpend(hit);
        else if (++tries < 10) setTimeout(() => void look(), 3_000);
      };
      void look();
      return () => {
        dead = true;
      };
    }, [status, spend]);

    const who = personaFor(req.to, book);
    const countdown = status === "pending" ? remainingText(msgTs, now) : undefined;

    return (
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <div style={{ fontWeight: 600 }}>{`${req.persona} → ${req.amount}`}</div>
          {countdown ? <span style={dim}>{countdown}</span> : null}
        </div>
        <div style={{ ...dim, marginTop: 2 }}>
          to {who ? <strong>{`@${who} · `}</strong> : null}
          <span style={mono} title={req.to}>
            {shortAddr(req.to)}
          </span>
          {req.memo ? ` — ${req.memo}` : ""}
        </div>
        {/* Whatever walletSend put above the 💸 line: "first payment to
            this agent", "network could not be checked …". The owner is
            approving on the strength of these, so they render in the card
            and not only in the raw bubble text. */}
        {(req.notes ?? []).map((note) => (
          <div key={note} style={{ ...dim, marginTop: 4 }}>
            {`⚠ ${note}`}
          </div>
        ))}
        {status === "pending" ? (
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button onClick={react("✅")}>approve</button>
            <button onClick={react("❌")}>decline</button>
          </div>
        ) : (
          <div style={{ marginTop: 8, ...dim }}>
            {status === "approved" ? (
              spend ? (
                <span>
                  ✅ sent — tx{" "}
                  <button
                    className="skill-link"
                    onClick={() => void api.openUrl(`https://taostats.io/transfer/${spend.txHash}`)}
                  >
                    {shortAddr(spend.txHash)}
                  </button>
                </span>
              ) : (
                "✅ approved — waiting for the transfer to land…"
              )
            ) : status === "declined" ? (
              "❌ declined"
            ) : (
              "expired — nothing was transferred"
            )}
          </div>
        )}
      </div>
    );
  }

  // ── receive cards ────────────────────────────────────────────────
  api.registerMessageDecorator(
    (content) => parseReceiveAddress(content) !== undefined,
    ({ content, msgId }) => {
      const rcv = parseReceiveAddress(content);
      if (!rcv) return null as never;
      // Attribution stays the BUBBLE's job — it names the real author,
      // so a message still cannot dress an address up as someone
      // else's, and the card no longer repeats the name above it. The
      // message must exist for that attribution to mean anything.
      const msg = client.msgById(msgId);
      if (!msg) return null as never;
      return (
        <div style={card}>
          {Label(`${rcv.chain} · receive`)}
          <div style={{ marginTop: 8 }}>
            <AddressRow address={rcv.address} />
          </div>
        </div>
      );
    }
  );

  // ── payment receipts ─────────────────────────────────────────────
  // The bolt under the message that earned it. registerMessageDecorator
  // only ever sees a message's CONTENT, never its id, so there is no way
  // to match "this bubble has a receipt" ahead of render time — the
  // match predicate is unconditional, and ReceiptLine itself renders
  // nothing for the (overwhelming) common case of a message nobody paid
  // for. Receipt data comes from `client.paymentReceiptsFor()` — the
  // desktop's own authenticated relay connection, subscribed to kind
  // 47040 alongside messages/reactions/etc (fez-client's resubscribe()
  // and loadChannelHistory()). An in-process SimplePool was tried here
  // first and reverted: fez's relays are membership-gated (NIP-42) and
  // silently withhold reads from an anonymous pool connection — a
  // read that looks empty and a read that never happened are the same
  // failure shape, which is exactly the trap this file must not repeat.
  // Filtered to the receipts this panel can render HONESTLY: a 47040 names
  // its own chain, and the line below prints TAO's 9 decimals. A receipt
  // for anything else is dropped rather than misprinted by nine orders of
  // magnitude (isRenderableReceipt).
  const parseAll = (events: readonly SignedNostrEvent[]): ParsedReceipt[] =>
    events
      .map((e) => parseReceipt(e))
      .filter((r): r is ParsedReceipt => r !== undefined && isRenderableReceipt(r));

  function ReceiptLine({ msgId }: { msgId: string }): JSX.Element | null {
    const [receipts, setReceipts] = useState<ParsedReceipt[]>(() => parseAll(client.paymentReceiptsFor(msgId)));
    useEffect(() => {
      setReceipts(parseAll(client.paymentReceiptsFor(msgId)));
      return client.on("paymentReceipt", (_channelId, targetId) => {
        if (targetId === msgId) setReceipts(parseAll(client.paymentReceiptsFor(msgId)));
      });
    }, [msgId]);
    if (receipts.length === 0) return null;
    return (
      <div>
        {receipts.map((r, i) => (
          <ReceiptCard key={`${r.txHash}-${i}`} r={r} />
        ))}
      </div>
    );
  }

  /**
   * A payment is the one message in a channel whose facts are signed and
   * checkable, and it used to render as a dim one-liner underneath the
   * agent's own prose about it — the trustworthy half small, the
   * unverifiable half large. This is the receipt as the object: the
   * amount as the headline, who it went to, and the transaction, with
   * the agent's sentence left above as its caption.
   */
  function ReceiptCard({ r }: { r: ParsedReceipt }): JSX.Element | null {
    const amount = receiptAmount(r);
    if (!amount) return null;
    // Both rules live in gui-logic where they are tested — the card must
    // not re-decide either of them inline.
    const badge = playMoneyBadge(r.network);
    const short = `${r.txHash.slice(0, 10)}…${r.txHash.slice(-6)}`;
    return (
      // No border: the message bubble is already the container, and the
      // app's rule is label-plus-hairline rather than a bordered card.
      <div style={{ marginTop: 10, maxWidth: 440 }}>
        {Label("payment")}
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginTop: 9 }}>
          <span
            style={{
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 19,
              fontWeight: 600,
              color: "var(--fg)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {amount}
          </span>
          {/* Play money must never pass for real money. The badge is loud
              precisely because its ABSENCE is what carries "this was real". */}
          {badge ? (
            <span
              style={{
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 10.5,
                textTransform: "uppercase" as const,
                letterSpacing: "0.08em",
                color: "var(--yellow, #fabd2f)",
                border: "1px solid var(--yellow, #fabd2f)",
                borderRadius: 5,
                padding: "1px 6px",
              }}
            >
              {badge}
            </span>
          ) : null}
        </div>
        {/* Names, not pubkeys — displayName is what the rest of the app
            calls these same people. The payee is optional on a 47040. */}
        <div style={{ ...mono, color: "var(--fg-dim, #999)", marginTop: 6 }}>
          {r.payee
            ? `to ${client.displayName(r.payee)} · from ${client.displayName(r.payer)}`
            : `from ${client.displayName(r.payer)}`}
        </div>
        {r.memo ? <div style={{ fontSize: 12, color: "var(--fg-dim, #999)", marginTop: 4 }}>{r.memo}</div> : null}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9, flexWrap: "wrap" }}>
          <span style={{ ...mono, fontSize: 11.5, color: "var(--fg-dim, #999)" }} title={r.txHash}>
            {`tx ${short}`}
          </span>
          <CopyButton text={r.txHash} label="copy tx" title="copy the full transaction hash" />
          <button
            className="skill-link"
            style={{ whiteSpace: "nowrap" as const }}
            onClick={() => void api.openUrl(`https://taostats.io/transfer/${r.txHash}`)}
          >
            ↗ taostats
          </button>
        </div>
        {/* A block we haven't fetched or couldn't reach is UNVERIFIABLE,
            never rendered as verified and never as false — this part wires
            the render only; actual chain verification (comparing the block
            named on the receipt against the chain) is a further round-trip
            this gui part does not make. Never claiming "verified" without
            having checked is exactly the ordering rule this exists to obey. */}
        <div style={{ ...mono, fontSize: 11.5, color: "var(--fg-dim, #999)", marginTop: 7 }}>
          {`· ${receiptStateText("unverifiable")}`}
        </div>
      </div>
    );
  }

  api.registerMessageDecorator(
    () => true,
    ({ msgId }) => <ReceiptLine msgId={msgId} />
  );

  // ── address chips ────────────────────────────────────────────────
  // Any SS58 address loose in chat gets copy + a taostats link. Consent
  // and receive messages are excluded — their cards already carry the
  // address with copy (and QR); a second row under the same bubble is
  // noise, not help.
  api.registerMessageDecorator(
    (content) =>
      parseConsentRequest(content) === undefined &&
      parseReceiveAddress(content) === undefined &&
      extractAddresses(content).length > 0,
    ({ content }) => (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
        {extractAddresses(content).map((addr) => (
          <AddressChip key={addr} address={addr} />
        ))}
      </div>
    )
  );

  function AddressChip({ address }: { address: string }): JSX.Element {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          border: "1px solid var(--hairline, #333)",
          borderRadius: 8,
          padding: "1px 8px",
          fontSize: 12,
        }}
      >
        <span style={mono} title={address}>
          {shortAddr(address)}
        </span>
        <CopyButton text={address} />
        <button
          className="skill-link"
          title="open on taostats"
          onClick={() => void api.openUrl(`https://taostats.io/account/${address}`)}
        >
          taostats ↗
        </button>
      </span>
    );
  }

  // ── the ceremony ─────────────────────────────────────────────────
  // fez-wallet init, from the panel — the terminal is no longer the
  // door. Runs through api.processes (the `processes` grant + the
  // manifest's own bin, both enforced host-side); custody is unchanged:
  // the mnemonic is minted BY the CLI in its own process, stored in the
  // wallet keychain, and crosses into the webview exactly once, to be
  // shown exactly once. Nothing here can read it back afterward.
  function Ceremony({ onDone }: { onDone: () => void }): JSX.Element {
    const [phase, setPhase] = useState<"idle" | "running" | "reveal">("idle");
    const [error, setError] = useState<string | undefined>(undefined);
    const [reveal, setReveal] = useState<{ mnemonic: string; treasuryAddress: string } | undefined>(undefined);
    const [adopted, setAdopted] = useState<string | undefined>(undefined);
    const run = api.processes?.run;

    if (!run) {
      return (
        <p className="settings-hint">
          No wallet yet. Creating one from here needs the `processes` permission — reinstall the wallet extension to
          grant it (or run <code>fez-wallet init</code> in a terminal).
        </p>
      );
    }

    const create = async () => {
      setPhase("running");
      setError(undefined);
      try {
        const out = await run("fez-wallet", ["init", "--json"]);
        if (out.code !== 0) throw new Error(out.stderr.trim() || `init exited ${out.code}`);
        const parsed = JSON.parse(out.stdout) as { adopted?: boolean; mnemonic?: string; treasuryAddress: string };
        if (parsed.adopted) {
          // An existing root was found and reconnected — there are no new
          // words to reveal, and pretending otherwise would be alarming.
          setAdopted(parsed.treasuryAddress);
          setPhase("reveal");
          return;
        }
        setReveal(parsed as { mnemonic: string; treasuryAddress: string });
        setPhase("reveal");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("idle");
      }
    };

    if (phase === "reveal" && adopted) {
      return (
        <div style={{ ...card, maxWidth: 560 }}>
          <div style={{ fontWeight: 600 }}>existing wallet reconnected</div>
          <div style={{ ...dim, marginTop: 2 }}>
            A wallet root was already on this Mac — it was adopted, not replaced. Your backup words stay the ones you
            wrote down when it was created.
          </div>
          <div style={{ ...mono, fontSize: 12, marginTop: 8 }}>treasury: {adopted}</div>
          <button className="agent-action" style={{ marginTop: 10 }} onClick={() => { setAdopted(undefined); onDone(); }}>
            continue
          </button>
        </div>
      );
    }
    if (phase === "reveal" && reveal) {
      return (
        <div style={{ ...card, maxWidth: 560 }}>
          <div style={{ fontWeight: 600 }}>wallet created — write these 24 words down</div>
          <div style={{ ...dim, marginTop: 2 }}>
            They are shown exactly once and never stored anywhere you can read them again. Anyone holding them holds
            the money.
          </div>
          <div
            style={{
              ...mono,
              fontSize: 13,
              lineHeight: 1.9,
              marginTop: 10,
              padding: "10px 12px",
              border: "1px solid var(--hairline, #333)",
              borderRadius: 8,
              userSelect: "text" as const,
            }}
          >
            {reveal.mnemonic}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
            <CopyButton text={reveal.mnemonic} label="copy words" title="copy the backup phrase" />
            <button
              className="agent-action"
              onClick={() => {
                setReveal(undefined);
                onDone();
              }}
            >
              I wrote them down
            </button>
          </div>
          <div style={{ ...dim, marginTop: 10 }}>
            treasury address — fund it, then open your agents' accounts below:
          </div>
          <div style={{ marginTop: 4 }}>
            <AddressRow address={reveal.treasuryAddress} />
          </div>
        </div>
      );
    }

    return (
      <div>
        <p className="settings-hint">
          No wallet yet. One master wallet funds every agent's allowance — created here, stored in the macOS keychain,
          backed up by 24 words you'll see exactly once.
        </p>
        {error ? <p className="ob-error">{error}</p> : null}
        <button className="agent-action" disabled={phase === "running"} onClick={() => void create()}>
          {phase === "running" ? "creating…" : "create this workspace's wallet"}
        </button>
      </div>
    );
  }

  /** Agents the workspace knows that have no allowance account yet — one
   * button each; derive is idempotent, so a re-click re-mirrors. */
  function DeriveRows({ have, onDone }: { have: string[]; onDone: () => void }): JSX.Element | null {
    const [busy, setBusy] = useState<string | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const run = api.processes?.run;
    const names = [...new Set([...client.agents().values()])].filter((n) => n && !have.includes(n)).sort();
    if (!run || names.length === 0) return null;

    const derive = async (name: string) => {
      setBusy(name);
      setError(undefined);
      try {
        const out = await run("fez-wallet", ["derive", name, "--json"]);
        if (out.code !== 0) throw new Error(out.stderr.trim() || `derive exited ${out.code}`);
        onDone();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(undefined);
      }
    };

    return (
      // Stacked, not the name-left/action-right settings grammar: three
      // account buttons crushed the explainer into a five-line sliver.
      // This is the page's primary act while accounts are missing —
      // heading, one line of why, then real buttons (fez-git's "what
      // now" card sets the same shape).
      <div className="skill-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="skill-name">agents without an account</span>
        <div className="skill-desc">an account is the agent's own address — what you put in it is the most it can spend</div>
        {error ? <p className="ob-error">{error}</p> : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
          {names.map((name) => (
            <button key={name} className="agent-action" disabled={busy === name} onClick={() => void derive(name)}>
              {busy === name ? "opening…" : `open @${name}'s account`}
            </button>
          ))}
        </div>
      </div>
    );
  }

  /**
   * The stake rehearsal, as a row (spec 2026-09-03): register → stake →
   * unstake, testnet only, through the same ceremony seam as init/derive —
   * every act is a CLI verb over api.processes, custody never enters the
   * webview. `status <persona> --json` is the display source; a chain that
   * won't answer renders "unknown", never zero, and a wiped testnet renders
   * unregistered because that is what the chain now says.
   */
  interface SubnetStatus { netuid: number; uid?: number; free: string; staked?: string; network: string }
  function SubnetRow({ persona }: { persona: string }): JSX.Element | null {
    const run = api.processes?.run;
    const [status, setStatus] = useState<SubnetStatus | "unreachable" | undefined>(undefined);
    const [busy, setBusy] = useState<string | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [amt, setAmt] = useState("");

    const refresh = () => {
      if (!run) return;
      void run("fez-wallet", ["status", persona, "--json"])
        .then((out) => {
          if (out.code !== 0) throw new Error(out.stderr.trim());
          setStatus(JSON.parse(out.stdout) as SubnetStatus);
        })
        .catch(() => setStatus("unreachable"));
    };
    useEffect(refresh, [persona]);

    if (!run) return null; // no ceremony seam — the row has nothing honest to offer

    const verb = async (label: string, args: string[]) => {
      setBusy(label);
      setError(undefined);
      try {
        const out = await run("fez-wallet", args);
        if (out.code !== 0) throw new Error(out.stderr.trim() || `${label} exited ${out.code}`);
        setAmt("");
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(undefined);
      }
    };

    const line = { display: "flex", alignItems: "center", gap: 8, marginTop: 4, fontSize: 12 } as const;
    if (status === undefined) return <div style={{ ...line, color: "var(--fg-dim, #928374)" }}>subnet: …</div>;
    if (status === "unreachable") {
      return <div style={{ ...line, color: "var(--fg-dim, #928374)" }}>subnet: chain unreachable — unknown, not zero</div>;
    }
    // Testnet money must never read as real: values wear the t prefix.
    const t = status.network === "finney" ? "" : "t";
    if (status.uid === undefined) {
      return (
        <div style={line}>
          <span style={{ color: "var(--fg-dim, #928374)" }}>{`netuid ${status.netuid}: not registered`}</span>
          <button className="mini" disabled={busy !== undefined} onClick={() => void verb("register", ["register", persona])}>
            {busy === "register" ? "registering… (the treasury pays the burn)" : "register on the subnet"}
          </button>
          {error ? <span className="ob-error">{error}</span> : null}
        </div>
      );
    }
    return (
      <div style={line}>
        <span style={{ color: "var(--fg-dim, #928374)" }}>
          {`uid ${status.uid} · netuid ${status.netuid} · staked ${status.staked !== undefined ? `${status.staked} ${t}α` : "unknown"}`}
        </span>
        <input
          className="manage-input"
          style={{ width: 90 }}
          placeholder={`${t}TAO`}
          value={amt}
          onChange={(e) => setAmt(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <button className="mini" disabled={busy !== undefined || !amt.trim()} onClick={() => void verb("stake", ["stake", persona, amt.trim()])}>
          {busy === "stake" ? "staking…" : "stake"}
        </button>
        <button className="mini" disabled={busy !== undefined || !amt.trim()} onClick={() => void verb("unstake", ["unstake", persona, amt.trim()])}>
          {busy === "unstake" ? "unstaking…" : "unstake"}
        </button>
        {error ? <span className="ob-error">{error}</span> : null}
      </div>
    );
  }

  // ── wallet panel ─────────────────────────────────────────────────
  api.registerSettingsPanel("Wallet", () => <WalletPanel />);

  function WalletPanel(): JSX.Element {
    const [addresses, setAddresses] = useState<AddressBook>({});
    const [endpoint, setEndpoint] = useState<string | undefined>(undefined);
    const [logs, setLogs] = useState<Partial<Record<Network, SpendEntry[]>>>({});
    const [balances, setBalances] = useState<Record<string, string>>({});

    // prefs IS the source of truth for both of these — the wallet reads it
    // on every call — so the panel derives what it shows from the selection
    // rather than waiting for some other process to mirror a consequence.
    // Precedence must match loadConfig exactly: prefs, then what the wallet
    // last resolved (mirrored — already includes the legacy-pin inference
    // loadConfig does), then the conservative default. Reading only prefs
    // made the panel say finney on a wallet whose every payment went out on
    // test, which is the divergence this whole feature exists to prevent.
    const [prefsNetwork, setPrefsNetwork] = useState<string | undefined>(undefined);
    const [mirroredNetwork, setMirroredNetwork] = useState<Network | undefined>(undefined);
    const network = resolveNetwork(prefsNetwork, mirroredNetwork);
    // `threshold` is what's saved; `draft` is what's typed. Free text is
    // composed and saved deliberately (the repo's own settings pane batches
    // relay/media behind one save); a select is a decision and applies at once.
    const [threshold, setThreshold] = useState<string>("0.01");
    const [draft, setDraft] = useState<string>("0.01");
    // No toast in GuiApi, so the confirmation lives in the panel. Buzz
    // toasts every settings mutation; the point is the same — a write you
    // cannot see is indistinguishable from one that didn't happen.
    const [flash, setFlash] = useState<string | null>(null);
    const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const say = useCallback((msg: string) => {
      setFlash(msg);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(null), 2500);
    }, []);
    useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

    useEffect(() => {
      void api.prefs.get<string>("network").then((n) => setPrefsNetwork(n ?? undefined));
      void api.prefs.get<Record<string, string>>("thresholds").then((t) => {
        setThreshold(t?.default ?? "0.01");
        setDraft(t?.default ?? "0.01");
      });
    }, []);

    // An error sticks: it is not news that expires, and a `say` timer still
    // in flight must not wipe it.
    const complain = useCallback((msg: string) => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
      setFlash(msg);
    }, []);

    // Writes are serialised and the UI settles on what actually persisted.
    // Two overlapping changes used to be able to leave the selector showing
    // one network while prefs held the other — and the direction that bites
    // is the panel saying "play money" over a wallet on mainnet.
    const writes = useRef<Promise<unknown>>(Promise.resolve());
    const latest = useRef(0);

    const onNetwork = useCallback((next: string) => {
      const seq = ++latest.current;
      setPrefsNetwork(next); // optimistic; reconciled below
      writes.current = writes.current
        .catch(() => {})
        .then(async () => {
          let failure: string | undefined;
          try {
            await api.prefs.set("network", next);
          } catch (err) {
            failure = err instanceof Error ? err.message : String(err);
          }
          // Only the newest change owns the UI, and it shows the persisted
          // value rather than what it hoped to write.
          if (seq !== latest.current) return;
          const actual = await api.prefs.get<string>("network").catch(() => undefined);
          setPrefsNetwork(actual ?? undefined);
          if (failure) complain(`✗ not changed: ${failure}`);
          else say(`✓ now on ${networkLabel(actual ?? next)}`);
        });
    }, [say, complain]);

    // Read-modify-write, never write: `thresholds` holds per-persona
    // entries this panel neither shows nor owns (see mergeThresholds).
    const saveThreshold = useCallback(async () => {
      if (!validThreshold(draft) || draft === threshold) return;
      try {
        const existing = await api.prefs.get<Record<string, string>>("thresholds");
        await api.prefs.set("thresholds", mergeThresholds(existing, draft));
        setThreshold(draft);
        say(`✓ threshold saved — ${draft} TAO`);
      } catch (err) {
        // The draft stays in the box and `threshold` is untouched, so the
        // hint below still reads "unsaved — X is still in force". True.
        complain(`✗ not saved: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, [draft, threshold, say, complain]);

    // Reused by the ceremony: init/derive run out-of-process and write
    // the mirror; the panel re-reads it instead of guessing at results.
    const reloadMirror = useCallback(async () => {
      setAddresses(((await api.storage.get("addresses")) as AddressBook) ?? {});
      setEndpoint(await api.storage.get("endpoint"));
      setLogs(((await api.storage.get("logs")) as Partial<Record<Network, SpendEntry[]>>) ?? {});
      setMirroredNetwork((await api.storage.get("network")) as Network | undefined);
    }, []);
    useEffect(() => {
      void reloadMirror();
    }, []);

    // ── x402 / USDC ─────────────────────────────────────────────────
    // Same shape as the TAO half: prefs is the layer the panel edits
    // (config.ts's x402Settings gives it precedence), the mirror is the
    // wallet's own read-only account of addresses/spends/effective
    // settings, and the panel derives what it shows from the selection.
    const [evmAddresses, setEvmAddresses] = useState<Record<string, string>>({});
    const [x402Log, setX402Log] = useState<X402MirrorRow[]>([]);
    const [x402Meta, setX402Meta] = useState<X402Meta | undefined>(undefined);
    const [x402Prefs, setX402Prefs] = useState<Record<string, unknown>>({});
    const [usdcBalances, setUsdcBalances] = useState<Record<string, string>>({});
    const x402Network = (x402Prefs.network as string | undefined) ?? x402Meta?.network ?? "base-sepolia";
    // Caps shown: the prefs draft the panel edits, falling back to what the
    // wallet last resolved (which already applied the finite-guard).
    const [capDraft, setCapDraft] = useState<string>("");
    const [autoDraft, setAutoDraft] = useState<string>("");
    const capSaved = String((x402Prefs.dailyCapUsd as number | undefined) ?? x402Meta?.dailyCapUsd ?? 25);
    const autoSaved = String(
      ((x402Prefs.autoApproveUnderUsd as Record<string, number> | undefined)?.default ?? x402Meta?.autoApproveDefault ?? 0)
    );

    useEffect(() => {
      void (async () => {
        setEvmAddresses(((await api.storage.get("evmAddresses")) as Record<string, string>) ?? {});
        setX402Log(((await api.storage.get("x402Log")) as X402MirrorRow[]) ?? []);
        setX402Meta((await api.storage.get("x402Meta")) as X402Meta | undefined);
        const p = ((await api.prefs.get("x402")) as Record<string, unknown>) ?? {};
        setX402Prefs(p);
        setCapDraft(String((p.dailyCapUsd as number | undefined) ?? ""));
        setAutoDraft(String(((p.autoApproveUnderUsd as Record<string, number> | undefined)?.default ?? "")));
      })();
    }, []);

    // Read-modify-write the ONE prefs key, exactly like thresholds —
    // never clobber sibling x402 overrides this panel doesn't edit.
    const writeX402 = useCallback(async (patch: Record<string, unknown>, doneMsg: string) => {
      try {
        const existing = ((await api.prefs.get("x402")) as Record<string, unknown>) ?? {};
        const next = { ...existing, ...patch };
        await api.prefs.set("x402", next);
        setX402Prefs(next);
        say(doneMsg);
      } catch (err) {
        complain(`✗ not saved: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, [say, complain]);

    const onX402Network = useCallback((next: string) => {
      // Flipping to mainnet is the one click in this panel that turns play
      // money into real money — it gets a confirm the TAO selector (which
      // moves between two funded-on-purpose chains) doesn't need.
      // I3: auto-approve/daily-cap are network-agnostic prefs that carry
      // straight into mainnet — name the effective numbers here, or the
      // owner confirms a network flip with no idea agents can already
      // spend real money unattended up to whatever they last set for testnet.
      if (
        next === "base" &&
        !confirm(
          `Flip x402 payments to Base MAINNET? Agents will spend REAL USDC — auto-approving up to $${autoSaved} per call, $${capSaved}/day, without asking you.`
        )
      )
        return;
      void writeX402({ network: next }, `✓ x402 now on ${x402NetworkLabel(next)}`);
    }, [writeX402, autoSaved, capSaved]);

    const saveX402Numbers = useCallback(() => {
      const patch: Record<string, unknown> = {};
      if (capDraft !== "" && validUsd(capDraft) && capDraft !== capSaved) patch.dailyCapUsd = Number(capDraft);
      if (autoDraft !== "" && validUsd(autoDraft) && autoDraft !== autoSaved) {
        const existing = (x402Prefs.autoApproveUnderUsd as Record<string, number> | undefined) ?? {};
        patch.autoApproveUnderUsd = { ...existing, default: Number(autoDraft) };
      }
      if (Object.keys(patch).length === 0) return;
      void writeX402(patch, "✓ x402 limits saved");
    }, [capDraft, autoDraft, capSaved, autoSaved, x402Prefs, writeX402]);

    // Read-only USDC balances over plain eth_call — display, not custody.
    // The display table keys off the SELECTED network so a fresh flip reads
    // the right chain even before any agent has re-mirrored its settings.
    useEffect(() => {
      const display = X402_DISPLAY[x402Network] ?? X402_DISPLAY["base-sepolia"];
      const rpcUrl = (x402Meta && x402Meta.network === x402Network ? x402Meta.rpcUrl : undefined) ?? display.rpcUrl;
      const usdc = (x402Meta && x402Meta.network === x402Network ? x402Meta.usdcAddress : undefined) ?? display.usdcAddress;
      const entries = Object.entries(evmAddresses);
      if (entries.length === 0) return;
      let dead = false;
      setUsdcBalances({});
      void (async () => {
        for (const [who, addr] of entries) {
          try {
            const call = erc20BalanceCall(usdc, String(addr));
            const res = await fetch(rpcUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [call, "latest"] }),
            });
            const out = (await res.json()) as { result?: string };
            const usd = out.result !== undefined ? parseUsdcBalance(out.result) : undefined;
            if (dead) return;
            setUsdcBalances((b) => ({ ...b, [who]: usd !== undefined ? `$${usd} USDC` : "unreadable" }));
          } catch {
            if (dead) return;
            setUsdcBalances((b) => ({ ...b, [who]: "rpc unreachable" }));
          }
        }
      })();
      return () => { dead = true; };
    }, [JSON.stringify(evmAddresses), x402Network, JSON.stringify(x402Meta ?? {})]);

    // The chain the panel dials: derived from the selection, with a genuine
    // override (local node / fork) still winning — same precedence loadConfig
    // uses, so panel and wallet can never disagree about which chain is live.
    const chainEndpoint = panelEndpoint(network as Network, endpoint);
    // The ledger shown follows the selection too — flipping the network and
    // still seeing the other chain's spends would be the same lie as balances.
    const log = logsFor(logs, network as Network);

    useEffect(() => {
      if (!chainEndpoint) return;
      let dead = false;
      // Blank first: leaving the previous chain's numbers on screen under a
      // freshly-changed network label is the same wrong answer, worse dressed.
      setBalances({});
      // Held outside the async body so cleanup can disconnect a connection
      // that resolves AFTER we stopped caring. ApiPromise.create does not
      // reject on an unreachable endpoint — it retries forever — so a few
      // network flips offline would otherwise pile up live WsProviders.
      type Chain = {
        disconnect(): Promise<unknown>;
        query: { system: { account(addr: string): Promise<unknown> } };
      };
      let opened: Promise<Chain> | undefined;
      void (async () => {
        const { ApiPromise, WsProvider } = await import("@polkadot/api");
        opened = ApiPromise.create({ provider: new WsProvider(chainEndpoint), noInitWarn: true }) as unknown as Promise<Chain>;
        const chain = await opened;
        if (dead) { void chain.disconnect(); return; }
        const rows: [string, string][] = [
          ...(addresses.treasury ? ([["treasury", addresses.treasury]] as [string, string][]) : []),
          ...Object.entries(addresses.personas ?? {}),
        ];
        for (const [who, addr] of rows) {
          const acct = (await chain.query.system.account(addr)) as unknown as {
            data: { free: { toBigInt(): bigint } };
          };
          if (dead) break;
          const raw = acct.data.free.toBigInt();
          const whole = raw / 1_000_000_000n;
          const frac = (raw % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
          setBalances((b) => ({ ...b, [who]: `${whole}${frac ? "." + frac : ""} TAO` }));
        }
        void chain.disconnect();
      })().catch(() => {});
      return () => {
        dead = true;
        void opened?.then((c) => c.disconnect()).catch(() => {});
      };
    }, [chainEndpoint, JSON.stringify(addresses)]);

    const balanceRows: [string, string][] = [
      ...(addresses.treasury ? ([["treasury", addresses.treasury]] as [string, string][]) : []),
      ...Object.entries(addresses.personas ?? {}),
    ];

    return (
      <div className="ext-panel">
        {flash ? <p className="settings-hint">{flash}</p> : null}
        <div className="manage-section">network</div>
        <div className="skill-row">
          <div className="skill-main">
            <span className="skill-name">{networkLabel(network)}</span>
            <div className="skill-desc">which chain new payments go out on — applies immediately</div>
          </div>
          <select
            className="skill-actions"
            value={network}
            onChange={(e: { target: { value: string } }) => void onNetwork(e.target.value)}
          >
            <option value="finney">finney (mainnet)</option>
            <option value="test">test — play money</option>
          </select>
        </div>

        <div className="manage-section">consent threshold</div>
        <div className="skill-row">
          <div className="skill-main">
            <span className="skill-name">auto-approve below</span>
            <div className="skill-desc">spends at or under this amount skip the consent card</div>
          </div>
          <div className="skill-actions">
            <input
              type="text"
              value={draft}
              spellCheck={false}
              style={validThreshold(draft) ? undefined : { borderColor: "var(--danger, #c00)", color: "var(--danger, #c00)" }}
              aria-invalid={!validThreshold(draft)}
              onChange={(e: { target: { value: string } }) => setDraft(e.target.value)}
              // Enter saves, so the field behaves like the form it is.
              onKeyDown={(e: { key: string }) => { if (e.key === "Enter") void saveThreshold(); }}
            />
            <button
              className="agent-action"
              disabled={!validThreshold(draft) || draft === threshold}
              onClick={() => void saveThreshold()}
            >
              save
            </button>
          </div>
        </div>
        {!validThreshold(draft) ? (
          <p className="settings-hint">not a valid TAO amount (up to 9 decimal places)</p>
        ) : draft !== threshold ? (
          <p className="settings-hint">{`unsaved — ${threshold} TAO is still in force`}</p>
        ) : null}

        <div className="manage-section">balances</div>
        {!chainEndpoint ? (
          <p className="settings-hint">
            {`no endpoint for network "${network}" — prefs names a network this build doesn't know`}
          </p>
        ) : balanceRows.length === 0 ? (
          <Ceremony onDone={() => void reloadMirror()} />
        ) : (
          <div>
            {balanceRows.map(([who, addr]) => (
              <div key={who} className="skill-row">
                <div className="skill-main">
                  <span className="skill-name">{who}</span>
                  <div className="skill-desc">
                    <AddressRow address={addr} />
                  </div>
                  {/* The economic loop's last two buttons (register, stake)
                      live on the agent's own row. Testnet-only for now, so
                      finney simply shows no subnet line. */}
                  {who !== "treasury" && network !== "finney" ? <SubnetRow persona={who} /> : null}
                </div>
                <div className="skill-actions">{balances[who] ?? "…"}</div>
              </div>
            ))}
          </div>
        )}

        {addresses.treasury ? <DeriveRows have={Object.keys(addresses.personas ?? {})} onDone={() => void reloadMirror()} /> : null}

        <div className="manage-section">spend ledger</div>
        {log.length === 0 ? (
          <p className="settings-hint">no transfers yet</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="wallet-ledger" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>time</th>
                  <th style={th}>agent</th>
                  <th style={{ ...th, textAlign: "right" as const }}>amount</th>
                  <th style={th}>to</th>
                  <th style={th}>memo</th>
                  <th style={th}>consent</th>
                  <th style={th}>tx</th>
                </tr>
              </thead>
              <tbody>
                {[...log].reverse().map((entry, i) => (
                  <tr key={`${entry.txHash}-${i}`}>
                    {/* The exact instant stays on hover; the column shows
                        the day and the minute you actually scan for. */}
                    <td style={tdDim} title={entry.ts}>
                      {ledgerTime(entry.ts)}
                    </td>
                    <td style={td}>{entry.persona}</td>
                    {/* The number is the point of the row: right-aligned so
                        the decimals line up down the column, and tabular so
                        the digits do not shift width between rows. */}
                    <td style={{ ...td, textAlign: "right" as const, fontVariantNumeric: "tabular-nums" }}>
                      {`${entry.amount} ${entry.asset}`}
                    </td>
                    {/* Name the recipient when the address book knows it.
                        "quill" is what you actually recognise, it is far
                        shorter than base58, and the full address stays on
                        hover for the one time you need to check it. */}
                    <td style={personaFor(entry.to, addresses) ? td : tdMono} title={entry.to}>
                      {personaFor(entry.to, addresses) ?? shortAddr(entry.to)}
                    </td>
                    {/* The one column allowed to give up its width — every
                        other cell is an identifier that must stay whole.
                        The cap goes on an inner box, NOT the cell: a td's
                        max-width is advisory under `table-layout: auto`, and
                        the memo taking the width it wanted pushed the tx
                        link off the right edge of the panel. */}
                    <td style={td} title={entry.memo ?? ""}>
                      <div style={memoBox}>{entry.memo ?? ""}</div>
                    </td>
                    <td style={tdDim}>{entry.consent}</td>
                    <td style={td}>
                      <button
                        className="skill-link"
                        style={{ whiteSpace: "nowrap" as const, fontFamily: "var(--font-mono, monospace)" }}
                        title={entry.txHash}
                        onClick={() => void api.openUrl(`https://taostats.io/transfer/${entry.txHash}`)}
                      >
                        {shortAddr(entry.txHash)}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── x402 / USDC ─────────────────────────────────────────────── */}
        <div className="manage-section">x402 · USDC</div>
        <div className="skill-row">
          <div className="skill-main">
            <span className="skill-name">{x402NetworkLabel(x402Network)}</span>
            <div className="skill-desc">which chain agents use to pay per-call services (x402) — applies on their next call</div>
          </div>
          <select
            className="skill-actions"
            value={x402Network}
            onChange={(e: { target: { value: string } }) => onX402Network(e.target.value)}
          >
            {X402_NETWORKS.map((n) => (
              <option key={n} value={n}>
                {x402NetworkLabel(n)}
              </option>
            ))}
          </select>
        </div>
        <div className="skill-row">
          <div className="skill-main">
            <span className="skill-name">daily cap / auto-approve (USD)</span>
            <div className="skill-desc">
              {`in force: $${capSaved} cap · auto-approve under $${autoSaved} (0 = every spend asks you)`}
            </div>
          </div>
          <div className="skill-actions">
            <input
              type="text"
              placeholder={`cap ${capSaved}`}
              value={capDraft}
              spellCheck={false}
              style={{ width: "5.5em", ...(capDraft === "" || validUsd(capDraft) ? {} : { borderColor: "var(--danger, #c00)" }) }}
              onChange={(e: { target: { value: string } }) => setCapDraft(e.target.value)}
            />
            <input
              type="text"
              placeholder={`auto ${autoSaved}`}
              value={autoDraft}
              spellCheck={false}
              style={{ width: "5.5em", ...(autoDraft === "" || validUsd(autoDraft) ? {} : { borderColor: "var(--danger, #c00)" }) }}
              onChange={(e: { target: { value: string } }) => setAutoDraft(e.target.value)}
            />
            <button
              className="agent-action"
              disabled={
                (capDraft === "" || !validUsd(capDraft) || capDraft === capSaved) &&
                (autoDraft === "" || !validUsd(autoDraft) || autoDraft === autoSaved)
              }
              onClick={() => saveX402Numbers()}
            >
              save
            </button>
          </div>
        </div>

        {Object.keys(evmAddresses).length === 0 ? (
          <p className="settings-hint">
            no USDC addresses yet — opening an agent's account (above) creates one; fund it with USDC to let that
            agent pay per-call services
          </p>
        ) : (
          <div>
            {Object.entries(evmAddresses).map(([who, addr]) => (
              <div key={who} className="skill-row">
                <div className="skill-main">
                  <span className="skill-name">{who}</span>
                  <div className="skill-desc">
                    <AddressRow address={addr} />
                  </div>
                </div>
                <div className="skill-actions">{usdcBalances[who] ?? "…"}</div>
              </div>
            ))}
          </div>
        )}

        {x402Log.length === 0 ? (
          <p className="settings-hint">no x402 payments yet</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="wallet-ledger" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>time</th>
                  <th style={th}>agent</th>
                  <th style={{ ...th, textAlign: "right" as const }}>usd</th>
                  <th style={th}>url</th>
                  <th style={th}>status</th>
                  <th style={th}>tx</th>
                </tr>
              </thead>
              <tbody>
                {[...x402Log].reverse().map((row, i) => (
                  <tr key={`${row.ts}-${row.status}-${i}`}>
                    <td style={tdDim} title={row.ts}>
                      {ledgerTime(row.ts)}
                    </td>
                    <td style={td}>{row.persona}</td>
                    <td style={{ ...td, textAlign: "right" as const, fontVariantNumeric: "tabular-nums" }}>
                      {`$${row.usd.toFixed(2)}`}
                    </td>
                    <td style={td} title={row.url}>
                      <div style={memoBox}>{row.url}</div>
                    </td>
                    {/* Status text stays honest: "ambiguous" is a row the
                        owner should look at, never silently promoted. */}
                    <td style={row.status === "ambiguous" ? td : tdDim}>
                      {row.status === "ambiguous" ? "⚠ may have settled" : row.status}
                    </td>
                    {row.txHash ? (
                      <td style={td}>
                        <button
                          className="skill-link"
                          style={{ whiteSpace: "nowrap" as const, fontFamily: "var(--font-mono, monospace)" }}
                          title={row.txHash}
                          onClick={() => void api.openUrl(x402TxLink(row.network, row.txHash!))}
                        >
                          {shortAddr(row.txHash)}
                        </button>
                      </td>
                    ) : (
                      <td style={tdDim}>—</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }
}
