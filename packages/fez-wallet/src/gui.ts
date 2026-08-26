import type { El, GuiClient, GuiExtensionApi } from "@fezchat/extension-api/gui";
import type { SpendEntry } from "./log.js";
import qrcode from "qrcode-generator";
import {
  parseConsentRequest,
  requestStatus,
  parseReceiveAddress,
  personaFor,
  matchSpend,
  remainingText,
} from "./gui-logic.js";

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
  const { useState, useEffect } = api.React;
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
    req: { persona: string; amount: string; to: string; memo?: string };
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
        const log = ((await api.storage.get("log")) as SpendEntry[]) ?? [];
        const hit = matchSpend(req, msgTs, log);
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
        h("div", { style: { fontWeight: 600 } }, `💸 ${req.persona} → ${req.amount}`),
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
      status === "pending"
        ? h(
            "div",
            { style: { marginTop: 8, display: "flex", gap: 8 } },
            h("button", { onClick: react("✅") }, "Approve ✅"),
            h("button", { onClick: react("❌") }, "Decline ❌")
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
    ({ content, msgId, authorName }) => {
      const rcv = parseReceiveAddress(content);
      if (!rcv) return null as never;
      // The card names its AUTHOR as the address owner — never a name
      // parsed from text, so a message can't dress an address up as
      // someone else's. It still must be a real message we can attribute.
      const msg = client.msgById(msgId);
      if (!msg) return null as never;
      return h(
        "div",
        { style: card },
        h("div", { style: { fontWeight: 600 } }, `📥 ${authorName} · receive (${rcv.chain})`),
        h("div", { style: { marginTop: 6 } }, h(AddressRow, { address: rcv.address }))
      );
    }
  );

  // ── wallet panel ─────────────────────────────────────────────────
  api.registerSettingsPanel("Wallet", () => h(WalletPanel));

  function WalletPanel(): El {
    const [addresses, setAddresses] = useState<AddressBook>({});
    const [endpoint, setEndpoint] = useState<string | undefined>(undefined);
    const [log, setLog] = useState<SpendEntry[]>([]);
    const [balances, setBalances] = useState<Record<string, string>>({});

    useEffect(() => {
      void (async () => {
        setAddresses(((await api.storage.get("addresses")) as AddressBook) ?? {});
        setEndpoint(await api.storage.get("endpoint"));
        setLog(((await api.storage.get("log")) as SpendEntry[]) ?? []);
      })();
    }, []);

    useEffect(() => {
      if (!endpoint) return;
      let dead = false;
      void (async () => {
        const { ApiPromise, WsProvider } = await import("@polkadot/api");
        const chain = await ApiPromise.create({ provider: new WsProvider(endpoint), noInitWarn: true });
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
      };
    }, [endpoint, JSON.stringify(addresses)]);

    const balanceRows: [string, string][] = [
      ...(addresses.treasury ? ([["treasury", addresses.treasury]] as [string, string][]) : []),
      ...Object.entries(addresses.personas ?? {}),
    ];

    return h(
      "div",
      { className: "ext-panel" },
      h("div", { className: "manage-section" }, "balances"),
      !endpoint
        ? h("p", { className: "settings-hint" }, "no chain endpoint mirrored yet — send once from the agent side first")
        : balanceRows.length === 0
          ? h("p", { className: "settings-hint" }, "no addresses configured yet")
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
