import type { El, GuiClient, GuiExtensionApi } from "@fezchat/extension-api/gui";
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
   * running out to the edge. Built here because a gui part renders
   * through h() and cannot reach App.css's classes. */
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
  const Label = (text: string): El =>
    h("div", { style: sectionLabel }, text, h("span", { style: labelRule }));
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
  }): El {
    const [copied, setCopied] = useState(false);
    return h(
      "button",
      {
        className: "skill-link",
        title,
        onClick: () => {
          void copyText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        },
      },
      copied ? "copied ✓" : label
    );
  }

  /** The address as an SVG QR — generated in-bundle, no network. */
  function Qr({ text }: { text: string }): El {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const cells: El[] = [];
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++)
        if (qr.isDark(r, c)) cells.push(h("rect", { key: `${r}-${c}`, x: c, y: r, width: 1, height: 1 }));
    return h(
      "svg",
      {
        viewBox: `-2 -2 ${n + 4} ${n + 4}`,
        width: 160,
        height: 160,
        style: { background: "#fff", borderRadius: 6, marginTop: 8, display: "block" },
      },
      h("g", { fill: "#000" }, ...cells)
    );
  }

  /** One address, everywhere it appears: short form (full in the hover
   * title), copy, and a QR the owner can flip open to scan. */
  function AddressRow({ address }: { address: string }): El {
    const [qrOpen, setQrOpen] = useState(false);
    return h(
      "div",
      null,
      h(
        "div",
        { style: { display: "flex", gap: 8, alignItems: "center" } },
        h("span", { style: mono, title: address }, shortAddr(address)),
        h(CopyButton, { text: address }),
        h("button", { className: "skill-link", onClick: () => setQrOpen(!qrOpen) }, qrOpen ? "hide QR" : "QR")
      ),
      qrOpen ? h(Qr, { text: address }) : null
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
      return h(ConsentCard, { req, msgId, channelId, msgTs: msg.ts } as never);
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
  }): El {
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

    return h(
      "div",
      { style: card },
      h(
        "div",
        { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 } },
        h("div", { style: { fontWeight: 600 } }, `${req.persona} → ${req.amount}`),
        countdown ? h("span", { style: dim }, countdown) : null
      ),
      h(
        "div",
        { style: { ...dim, marginTop: 2 } },
        "to ",
        who ? h("strong", null, `@${who} · `) : null,
        h("span", { style: mono, title: req.to }, shortAddr(req.to)),
        req.memo ? ` — ${req.memo}` : ""
      ),
      // Whatever walletSend put above the 💸 line: "first payment to
      // this agent", "network could not be checked …". The owner is
      // approving on the strength of these, so they render in the card
      // and not only in the raw bubble text.
      ...(req.notes ?? []).map((note) =>
        h("div", { key: note, style: { ...dim, marginTop: 4 } }, `⚠ ${note}`)
      ),
      status === "pending"
        ? h(
            "div",
            { style: { marginTop: 8, display: "flex", gap: 8 } },
            h("button", { onClick: react("✅") }, "approve"),
            h("button", { onClick: react("❌") }, "decline")
          )
        : h(
            "div",
            { style: { marginTop: 8, ...dim } },
            status === "approved"
              ? spend
                ? h(
                    "span",
                    null,
                    "✅ sent — tx ",
                    h(
                      "button",
                      {
                        className: "skill-link",
                        onClick: () => void api.openUrl(`https://taostats.io/transfer/${spend.txHash}`),
                      },
                      shortAddr(spend.txHash)
                    )
                  )
                : "✅ approved — waiting for the transfer to land…"
              : status === "declined"
                ? "❌ declined"
                : "expired — nothing was transferred"
          )
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
      return h(
        "div",
        { style: card },
        Label(`${rcv.chain} · receive`),
        h("div", { style: { marginTop: 8 } }, h(AddressRow, { address: rcv.address }))
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

  function ReceiptLine({ msgId }: { msgId: string }): El {
    const [receipts, setReceipts] = useState<ParsedReceipt[]>(() => parseAll(client.paymentReceiptsFor(msgId)));
    useEffect(() => {
      setReceipts(parseAll(client.paymentReceiptsFor(msgId)));
      return client.on("paymentReceipt", (_channelId, targetId) => {
        if (targetId === msgId) setReceipts(parseAll(client.paymentReceiptsFor(msgId)));
      });
    }, [msgId]);
    if (receipts.length === 0) return null as never;
    return h(
      "div",
      null,
      ...receipts.map((r, i) => h(ReceiptCard, { key: `${r.txHash}-${i}`, r }))
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
  function ReceiptCard({ r }: { r: ParsedReceipt }): El {
    const amount = receiptAmount(r);
    if (!amount) return null as never;
    // Both rules live in gui-logic where they are tested — the card must
    // not re-decide either of them inline.
    const badge = playMoneyBadge(r.network);
    const short = `${r.txHash.slice(0, 10)}…${r.txHash.slice(-6)}`;
    return h(
      "div",
      // No border: the message bubble is already the container, and the
      // app's rule is label-plus-hairline rather than a bordered card.
      { style: { marginTop: 10, maxWidth: 440 } },
      Label("payment"),
      h(
        "div",
        { style: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginTop: 9 } },
        h(
          "span",
          {
            style: {
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 19,
              fontWeight: 600,
              color: "var(--fg)",
              fontVariantNumeric: "tabular-nums",
            },
          },
          amount
        ),
        // Play money must never pass for real money. The badge is loud
        // precisely because its ABSENCE is what carries "this was real".
        badge
          ? h(
              "span",
              {
                style: {
                  fontFamily: "var(--font-mono, monospace)",
                  fontSize: 10.5,
                  textTransform: "uppercase" as const,
                  letterSpacing: "0.08em",
                  color: "var(--yellow, #fabd2f)",
                  border: "1px solid var(--yellow, #fabd2f)",
                  borderRadius: 5,
                  padding: "1px 6px",
                },
              },
              badge
            )
          : null
      ),
      // Names, not pubkeys — displayName is what the rest of the app
      // calls these same people. The payee is optional on a 47040.
      h(
        "div",
        { style: { ...mono, color: "var(--fg-dim, #999)", marginTop: 6 } },
        r.payee ? `to ${client.displayName(r.payee)} · from ${client.displayName(r.payer)}` : `from ${client.displayName(r.payer)}`
      ),
      r.memo ? h("div", { style: { fontSize: 12, color: "var(--fg-dim, #999)", marginTop: 4 } }, r.memo) : null,
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 9, flexWrap: "wrap" } },
        h("span", { style: { ...mono, fontSize: 11.5, color: "var(--fg-dim, #999)" }, title: r.txHash }, `tx ${short}`),
        h(CopyButton, { text: r.txHash, label: "copy tx", title: "copy the full transaction hash" }),
        h(
          "button",
          {
            className: "skill-link",
            style: { whiteSpace: "nowrap" as const },
            onClick: () => void api.openUrl(`https://taostats.io/transfer/${r.txHash}`),
          },
          "↗ taostats"
        )
      ),
      // A block we haven't fetched or couldn't reach is UNVERIFIABLE,
      // never rendered as verified and never as false — this part wires
      // the render only; actual chain verification (comparing the block
      // named on the receipt against the chain) is a further round-trip
      // this gui part does not make. Never claiming "verified" without
      // having checked is exactly the ordering rule this exists to obey.
      h(
        "div",
        { style: { ...mono, fontSize: 11.5, color: "var(--fg-dim, #999)", marginTop: 7 } },
        `· ${receiptStateText("unverifiable")}`
      )
    );
  }

  api.registerMessageDecorator(
    () => true,
    ({ msgId }) => h(ReceiptLine, { msgId })
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
    ({ content }) =>
      h(
        "div",
        { style: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 } },
        ...extractAddresses(content).map((addr) => h(AddressChip, { key: addr, address: addr }))
      )
  );

  function AddressChip({ address }: { address: string }): El {
    return h(
      "span",
      {
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          border: "1px solid var(--hairline, #333)",
          borderRadius: 8,
          padding: "1px 8px",
          fontSize: 12,
        },
      },
      h("span", { style: mono, title: address }, shortAddr(address)),
      h(CopyButton, { text: address }),
      h(
        "button",
        {
          className: "skill-link",
          title: "open on taostats",
          onClick: () => void api.openUrl(`https://taostats.io/account/${address}`),
        },
        "taostats ↗"
      )
    );
  }

  // ── wallet panel ─────────────────────────────────────────────────
  api.registerSettingsPanel("Wallet", () => h(WalletPanel));

  function WalletPanel(): El {
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

    useEffect(() => {
      void (async () => {
        setAddresses(((await api.storage.get("addresses")) as AddressBook) ?? {});
        setEndpoint(await api.storage.get("endpoint"));
        setLogs(((await api.storage.get("logs")) as Partial<Record<Network, SpendEntry[]>>) ?? {});
        setMirroredNetwork((await api.storage.get("network")) as Network | undefined);
      })();
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
      if (next === "base" && !confirm("Flip x402 payments to Base MAINNET? Agents will spend REAL USDC.")) return;
      void writeX402({ network: next }, `✓ x402 now on ${x402NetworkLabel(next)}`);
    }, [writeX402]);

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

    return h(
      "div",
      { className: "ext-panel" },
      flash ? h("p", { className: "settings-hint" }, flash) : null,
      h("div", { className: "manage-section" }, "network"),
      h(
        "div",
        { className: "skill-row" },
        h(
          "div",
          { className: "skill-main" },
          h("span", { className: "skill-name" }, networkLabel(network)),
          h(
            "div",
            { className: "skill-desc" },
            "which chain new payments go out on — applies immediately"
          )
        ),
        h(
          "select",
          {
            className: "skill-actions",
            value: network,
            onChange: (e: { target: { value: string } }) => void onNetwork(e.target.value),
          },
          h("option", { value: "finney" }, "finney (mainnet)"),
          h("option", { value: "test" }, "test — play money")
        )
      ),

      h("div", { className: "manage-section" }, "consent threshold"),
      h(
        "div",
        { className: "skill-row" },
        h(
          "div",
          { className: "skill-main" },
          h("span", { className: "skill-name" }, "auto-approve below"),
          h("div", { className: "skill-desc" }, "spends at or under this amount skip the consent card")
        ),
        h(
          "div",
          { className: "skill-actions" },
          h("input", {
            type: "text",
            value: draft,
            spellCheck: false,
            style: validThreshold(draft) ? undefined : { borderColor: "var(--danger, #c00)", color: "var(--danger, #c00)" },
            "aria-invalid": !validThreshold(draft),
            onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
            // Enter saves, so the field behaves like the form it is.
            onKeyDown: (e: { key: string }) => { if (e.key === "Enter") void saveThreshold(); },
          }),
          h(
            "button",
            {
              className: "agent-action",
              disabled: !validThreshold(draft) || draft === threshold,
              onClick: () => void saveThreshold(),
            },
            "save"
          )
        )
      ),
      !validThreshold(draft)
        ? h("p", { className: "settings-hint" }, "not a valid TAO amount (up to 9 decimal places)")
        : draft !== threshold
          ? h("p", { className: "settings-hint" }, `unsaved — ${threshold} TAO is still in force`)
          : null,

      h("div", { className: "manage-section" }, "balances"),
      !chainEndpoint
        ? h(
            "p",
            { className: "settings-hint" },
            `no endpoint for network "${network}" — prefs names a network this build doesn't know`
          )
        : balanceRows.length === 0
        ? h(
            "p",
            { className: "settings-hint" },
            "no addresses yet — run fez-wallet init, then derive an agent"
          )
          : h(
              "div",
              null,
              ...balanceRows.map(([who, addr]) =>
                h(
                  "div",
                  { key: who, className: "skill-row" },
                  h(
                    "div",
                    { className: "skill-main" },
                    h("span", { className: "skill-name" }, who),
                    h("div", { className: "skill-desc" }, h(AddressRow, { address: addr }))
                  ),
                  h("div", { className: "skill-actions" }, balances[who] ?? "…")
                )
              )
            ),

      h("div", { className: "manage-section" }, "spend ledger"),
      log.length === 0
        ? h("p", { className: "settings-hint" }, "no transfers yet")
        : h(
            "div",
            { style: { overflowX: "auto" } },
            h(
              "table",
              { className: "wallet-ledger", style: { width: "100%", borderCollapse: "collapse" } },
              h(
                "thead",
                null,
                h(
                  "tr",
                  null,
                  h("th", { style: th }, "time"),
                  h("th", { style: th }, "agent"),
                  h("th", { style: { ...th, textAlign: "right" as const } }, "amount"),
                  h("th", { style: th }, "to"),
                  h("th", { style: th }, "memo"),
                  h("th", { style: th }, "consent"),
                  h("th", { style: th }, "tx")
                )
              ),
              h(
                "tbody",
                null,
                ...[...log].reverse().map((entry, i) =>
                  h(
                    "tr",
                    { key: `${entry.txHash}-${i}` },
                    // The exact instant stays on hover; the column shows
                    // the day and the minute you actually scan for.
                    h("td", { style: tdDim, title: entry.ts }, ledgerTime(entry.ts)),
                    h("td", { style: td }, entry.persona),
                    // The number is the point of the row: right-aligned so
                    // the decimals line up down the column, and tabular so
                    // the digits do not shift width between rows.
                    h(
                      "td",
                      { style: { ...td, textAlign: "right" as const, fontVariantNumeric: "tabular-nums" } },
                      `${entry.amount} ${entry.asset}`
                    ),
                    // Name the recipient when the address book knows it.
                    // "quill" is what you actually recognise, it is far
                    // shorter than base58, and the full address stays on
                    // hover for the one time you need to check it.
                    h(
                      "td",
                      { style: personaFor(entry.to, addresses) ? td : tdMono, title: entry.to },
                      personaFor(entry.to, addresses) ?? shortAddr(entry.to)
                    ),
                    // The one column allowed to give up its width — every
                    // other cell is an identifier that must stay whole.
                    // The cap goes on an inner box, NOT the cell: a td's
                    // max-width is advisory under `table-layout: auto`, and
                    // the memo taking the width it wanted pushed the tx
                    // link off the right edge of the panel.
                    h("td", { style: td, title: entry.memo ?? "" }, h("div", { style: memoBox }, entry.memo ?? "")),
                    h("td", { style: tdDim }, entry.consent),
                    h(
                      "td",
                      { style: td },
                      h(
                        "button",
                        {
                          className: "skill-link",
                          style: { whiteSpace: "nowrap" as const, fontFamily: "var(--font-mono, monospace)" },
                          title: entry.txHash,
                          onClick: () => void api.openUrl(`https://taostats.io/transfer/${entry.txHash}`),
                        },
                        shortAddr(entry.txHash)
                      )
                    )
                  )
                )
              )
            )
          ),

      // ── x402 / USDC ───────────────────────────────────────────────
      h("div", { className: "manage-section" }, "x402 · USDC"),
      h(
        "div",
        { className: "skill-row" },
        h(
          "div",
          { className: "skill-main" },
          h("span", { className: "skill-name" }, x402NetworkLabel(x402Network)),
          h("div", { className: "skill-desc" }, "which chain agents pay 402 services on — applies on their next call")
        ),
        h(
          "select",
          {
            className: "skill-actions",
            value: x402Network,
            onChange: (e: { target: { value: string } }) => onX402Network(e.target.value),
          },
          ...X402_NETWORKS.map((n) => h("option", { key: n, value: n }, x402NetworkLabel(n)))
        )
      ),
      h(
        "div",
        { className: "skill-row" },
        h(
          "div",
          { className: "skill-main" },
          h("span", { className: "skill-name" }, "daily cap / auto-approve (USD)"),
          h(
            "div",
            { className: "skill-desc" },
            `in force: $${capSaved} cap · auto-approve under $${autoSaved} (0 = every spend asks you)`
          )
        ),
        h(
          "div",
          { className: "skill-actions" },
          h("input", {
            type: "text",
            placeholder: `cap ${capSaved}`,
            value: capDraft,
            spellCheck: false,
            style: { width: "5.5em", ...(capDraft === "" || validUsd(capDraft) ? {} : { borderColor: "var(--danger, #c00)" }) },
            onChange: (e: { target: { value: string } }) => setCapDraft(e.target.value),
          }),
          h("input", {
            type: "text",
            placeholder: `auto ${autoSaved}`,
            value: autoDraft,
            spellCheck: false,
            style: { width: "5.5em", ...(autoDraft === "" || validUsd(autoDraft) ? {} : { borderColor: "var(--danger, #c00)" }) },
            onChange: (e: { target: { value: string } }) => setAutoDraft(e.target.value),
          }),
          h(
            "button",
            {
              className: "agent-action",
              disabled:
                (capDraft === "" || !validUsd(capDraft) || capDraft === capSaved) &&
                (autoDraft === "" || !validUsd(autoDraft) || autoDraft === autoSaved),
              onClick: () => saveX402Numbers(),
            },
            "save"
          )
        )
      ),

      Object.keys(evmAddresses).length === 0
        ? h("p", { className: "settings-hint" }, "no EVM addresses yet — run fez-wallet derive <persona> to mint one, then fund it with USDC")
        : h(
            "div",
            null,
            ...Object.entries(evmAddresses).map(([who, addr]) =>
              h(
                "div",
                { key: who, className: "skill-row" },
                h(
                  "div",
                  { className: "skill-main" },
                  h("span", { className: "skill-name" }, who),
                  h("div", { className: "skill-desc" }, h(AddressRow, { address: addr }))
                ),
                h("div", { className: "skill-actions" }, usdcBalances[who] ?? "…")
              )
            )
          ),

      x402Log.length === 0
        ? h("p", { className: "settings-hint" }, "no x402 payments yet")
        : h(
            "div",
            { style: { overflowX: "auto" } },
            h(
              "table",
              { className: "wallet-ledger", style: { width: "100%", borderCollapse: "collapse" } },
              h(
                "thead",
                null,
                h(
                  "tr",
                  null,
                  h("th", { style: th }, "time"),
                  h("th", { style: th }, "agent"),
                  h("th", { style: { ...th, textAlign: "right" as const } }, "usd"),
                  h("th", { style: th }, "url"),
                  h("th", { style: th }, "status"),
                  h("th", { style: th }, "tx")
                )
              ),
              h(
                "tbody",
                null,
                ...[...x402Log].reverse().map((row, i) =>
                  h(
                    "tr",
                    { key: `${row.ts}-${row.status}-${i}` },
                    h("td", { style: tdDim, title: row.ts }, ledgerTime(row.ts)),
                    h("td", { style: td }, row.persona),
                    h(
                      "td",
                      { style: { ...td, textAlign: "right" as const, fontVariantNumeric: "tabular-nums" } },
                      `$${row.usd.toFixed(2)}`
                    ),
                    h("td", { style: td, title: row.url }, h("div", { style: memoBox }, row.url)),
                    // Status text stays honest: "ambiguous" is a row the
                    // owner should look at, never silently promoted.
                    h("td", { style: row.status === "ambiguous" ? td : tdDim }, row.status === "ambiguous" ? "⚠ may have settled" : row.status),
                    row.txHash
                      ? h(
                          "td",
                          { style: td },
                          h(
                            "button",
                            {
                              className: "skill-link",
                              style: { whiteSpace: "nowrap" as const, fontFamily: "var(--font-mono, monospace)" },
                              title: row.txHash,
                              onClick: () => void api.openUrl(x402TxLink(row.network, row.txHash!)),
                            },
                            shortAddr(row.txHash)
                          )
                        )
                      : h("td", { style: tdDim }, "—")
                  )
                )
              )
            )
          )
    );
  }
}
