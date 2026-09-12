import type { GuiExtensionApi } from "@fezchat/extension-api/gui";
import type { PersonaChainStatus } from "./stake.js";

type ProfileApi = Pick<GuiExtensionApi, "React" | "processes" | "toast"> & Partial<Pick<GuiExtensionApi, "registerAgentProfileSection">>;

/** Reuse the wallet's read-only status command; no chain library or keys enter the webview. */
export function registerWalletReputation(api: ProfileApi): void {
  if (typeof api.registerAgentProfileSection !== "function") {
    const message = "Wallet stake display needs an updated Fez desktop. Wallet settings remain available.";
    if (typeof api.toast === "function") api.toast(message, "warn");
    else console.warn(message);
    return;
  }
  const h = api.React.createElement;
  const { useState, useEffect } = api.React;
  function Stake({ persona }: { persona?: string }): JSX.Element {
    const [result, setResult] = useState<{ status: PersonaChainStatus; at: string } | { error: string } | undefined>(undefined);
    const [refresh, setRefresh] = useState(0);
    const run = api.processes?.run;
    useEffect(() => {
      let cancelled = false;
      setResult(undefined);
      if (persona && run) {
        void run("fez-wallet", ["status", persona, "--json"]).then((out) => {
          if (out.code !== 0) throw new Error(out.stderr.trim() || `Wallet status exited ${out.code}`);
          const status: PersonaChainStatus = JSON.parse(out.stdout);
          if (!status || status.persona !== persona || typeof status.address !== "string" || !status.address
            || !["test", "finney"].includes(status.network) || !Number.isInteger(status.netuid)
            || status.netuid < 0 || (status.uid !== undefined && (!Number.isInteger(status.uid) || status.uid < 0))
            || (status.staked !== undefined && (typeof status.staked !== "string" || !/^\d+(?:\.\d+)?$/.test(status.staked)))) {
            throw new Error("Wallet returned an invalid stake status. Update the wallet extension and retry.");
          }
          if (!cancelled) setResult({ status, at: new Date().toISOString() });
        }).catch((err) => {
          if (!cancelled) setResult({ error: err instanceof Error ? err.message : String(err) });
        });
      }
      return () => { cancelled = true; };
    }, [persona, run, refresh]);

    if (!persona) return <p className="settings-hint">Stake unavailable. No local wallet account is linked to this agent.</p>;
    if (!run) return <p className="settings-hint">Stake unavailable. Enable the wallet extension's processes permission.</p>;
    return <div>
      {!result ? <p className="settings-hint" role="status">Checking wallet stake…</p>
        : "error" in result ? <p className="settings-hint" role="status">Stake unavailable: {result.error.slice(-300)}</p>
          : <div>
            <p style={{ margin: "4px 0", fontVariantNumeric: "tabular-nums" }}>
              <b>{result.status.staked === undefined ? "Self stake unknown" : `${result.status.staked} ${result.status.network === "test" ? "tα" : "α"} self stake`}</b>
            </p>
            <p className="settings-hint">{result.status.network === "test" ? "Testnet · test funds" : "Finney mainnet"} · subnet {result.status.netuid}
              {result.status.uid === undefined ? " · not registered" : ` · uid ${result.status.uid}`}</p>
            <p className="settings-hint" title={result.status.address}>Local wallet · {result.status.address.slice(0, 8)}…{result.status.address.slice(-6)}</p>
            <p className="settings-hint">Checked <time dateTime={result.at}>{new Date(result.at).toLocaleString()}</time>. Other accounts' stake is not included.</p>
          </div>}
      <button className="mini" disabled={!result} onClick={() => setRefresh((n) => n + 1)}>Refresh stake</button>
    </div>;
  }
  api.registerAgentProfileSection("Stake", ({ pubkey, persona }) => <Stake key={`${pubkey}:${persona ?? ""}`} persona={persona} />);
}
