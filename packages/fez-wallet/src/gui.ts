import type { El, GuiClient, GuiExtensionApi } from "@fezchat/extension-api/gui";
import type { SpendEntry } from "./log.js";
import { parseConsentRequest, requestStatus } from "./gui-logic.js";

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

/**
 * fez-wallet, GUI part — the consent inbox and the treasury window.
 *
 * Approve/Decline publish the owner's ordinary ✅/❌ reaction — the
 * exact event the wallet's awaitDecision trusts. The buttons are
 * convenience, not a second consent mechanism. Balances are public
 * chain reads; addresses/endpoint/history come from the read-only
 * storage seam (the CLI/MCP wrote them there — the webview can't read
 * wallet.json and shouldn't).
 *
 * The card only renders for the persona's OWN message: `msgById(msgId)`
 * gives the actual poster's pubkey, compared against `pkByName(persona)`
 * resolved from the parsed name. Any other rostered member echoing the
 * three-line format under their own message renders a plain bubble —
 * no buttons to absorb a click that authorizes nothing.
 */

export default function activate(api: GuiExtensionApi): void {
  const h = api.React.createElement;
  const client = api.client as WalletClient;
  if (!client) return; // read:channels ungranted — nothing works without it

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

      const react = (emoji: string) => () => void client.toggleReaction(channelId, msgId, emoji);
      const approved = client.myReactionTo(msgId, "✅") !== undefined;
      const declined = client.myReactionTo(msgId, "❌") !== undefined;
      const reactions: { content: string; authorPk: string }[] = [
        ...(approved ? [{ content: "✅", authorPk: client.pubkey }] : []),
        ...(declined ? [{ content: "❌", authorPk: client.pubkey }] : []),
      ];
      const status = requestStatus(reactions, client.pubkey, msg.ts, Date.now() / 1000);

      return h(
        "div",
        { style: { border: "1px solid var(--border, #333)", borderRadius: 8, padding: 10, marginTop: 6 } },
        h("div", { style: { fontWeight: 600 } }, `${req.persona} → ${req.amount}`),
        h("div", { style: { opacity: 0.8, fontSize: 12 } }, `to ${req.to}${req.memo ? ` — ${req.memo}` : ""}`),
        status === "pending"
          ? h(
              "div",
              { style: { marginTop: 8, display: "flex", gap: 8 } },
              h("button", { onClick: react("✅") }, "Approve ✅"),
              h("button", { onClick: react("❌") }, "Decline ❌")
            )
          : h(
              "div",
              { style: { marginTop: 8, opacity: 0.8, fontSize: 12 } },
              status === "approved"
                ? "✅ approved"
                : status === "declined"
                  ? "❌ declined"
                  : "expired — nothing was transferred"
            )
      );
    }
  );

  // ── wallet panel ─────────────────────────────────────────────────
  api.registerSettingsPanel("Wallet", () => h(WalletPanel, { api } as never));

  function WalletPanel({ api }: { api: GuiExtensionApi }): El {
    const { useState, useEffect } = api.React;
    const [addresses, setAddresses] = useState<{ treasury?: string; personas?: Record<string, string> }>({});
    const [endpoint, setEndpoint] = useState<string | undefined>(undefined);
    const [log, setLog] = useState<SpendEntry[]>([]);
    const [balances, setBalances] = useState<Record<string, string>>({});

    useEffect(() => {
      void (async () => {
        setAddresses((await api.storage.get("addresses")) ?? {});
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

    /** Long addresses take too much width in a settings panel — the
     * first 8 chars plus an ellipsis is enough to eyeball-match the
     * chain explorer without wrapping the row. */
    const shortAddr = (s: string) => (s.length > 8 ? `${s.slice(0, 8)}…` : s);

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
                    h("div", { className: "skill-desc" }, shortAddr(addr))
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
                    h("td", null, shortAddr(entry.to)),
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
