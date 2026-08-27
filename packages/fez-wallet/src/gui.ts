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
  receiptLine,
  isRenderableReceipt,
  panelEndpoint,
  resolveNetwork,
} from "./gui-logic.js";
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

  function CopyButton({ text }: { text: string }): El {
    const [copied, setCopied] = useState(false);
    return h(
      "button",
      {
        className: "skill-link",
        title: "copy full address",
        onClick: () => {
          void copyText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        },
      },
      copied ? "copied ✓" : "copy"
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
    const approved = client.myReactionTo(msgId, "✅") !== undefined;
    const declined = client.myReactionTo(msgId, "❌") !== undefined;
    const reactions: { content: string; authorPk: string }[] = [
      ...(approved ? [{ content: "✅", authorPk: client.pubkey }] : []),
      ...(declined ? [{ content: "❌", authorPk: client.pubkey }] : []),
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
      { style: { ...dim, marginTop: 4 } },
      // A block we haven't fetched or couldn't reach is UNVERIFIABLE,
      // never rendered as verified and never as false — this task wires
      // the render only; actual chain verification (comparing the block
      // named on the receipt against the chain) is a further round-trip
      // this gui part does not make. Never claiming "verified" without
      // having checked is exactly the ordering rule this exists to obey.
      ...receipts.map((r, i) => h("div", { key: `${r.txHash}-${i}` }, receiptLine(r, "unverifiable") ?? ""))
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
                  h("th", null, "time"),
                  h("th", null, "agent"),
                  h("th", null, "amount"),
                  h("th", null, "to"),
                  h("th", null, "memo"),
                  h("th", null, "consent"),
                  h("th", null, "tx")
                )
              ),
              h(
                "tbody",
                null,
                ...[...log].reverse().map((entry, i) =>
                  h(
                    "tr",
                    { key: `${entry.txHash}-${i}` },
                    h("td", null, entry.ts),
                    h("td", null, entry.persona),
                    h("td", null, `${entry.amount} ${entry.asset}`),
                    h("td", { title: entry.to }, shortAddr(entry.to)),
                    h("td", null, entry.memo ?? ""),
                    h("td", null, entry.consent),
                    h(
                      "td",
                      null,
                      h(
                        "button",
                        {
                          className: "skill-link",
                          onClick: () => void api.openUrl(`https://taostats.io/transfer/${entry.txHash}`),
                        },
                        shortAddr(entry.txHash)
                      )
                    )
                  )
                )
              )
            )
          )
    );
  }
}
