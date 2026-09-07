import type { GuiExtensionApi } from "@fezchat/extension-api/gui";
import type { MinerEntry, Subnet } from "./state.js";
import { subnetRows } from "./gui-rows.js";

/**
 * fez-mining, GUI part — the "Mining" nav view: active miners up top, the
 * subnet catalog below with a Mine button on every curated row.
 *
 * Legacy element-returning mount form (`--jsx-factory=h`, shared host
 * React via `api.React` — same shape as fez-wallet's gui.tsx, not
 * fez-loom's bundled-react-dom `createRoot` form; this package's build
 * line matches wallet's exactly, so its pattern is the proven one here).
 *
 * Every act is a CLI verb over `api.processes!.run("fez-mine", …)` — the
 * GUI never touches state files or the chain directly. `fez-mine` itself
 * shells to fez-wallet for cost/register, which the seam does not
 * restrict (own-package bins only, and fez-wallet isn't this package's).
 */
export default function activate(api: GuiExtensionApi): void {
  const h = api.React.createElement;
  const { useState, useEffect, useCallback } = api.React;

  const minerKey = (netuid: number, persona: string) => `${netuid}:${persona}`;

  const card = {
    border: "1px solid var(--hairline, #333)",
    borderRadius: 8,
    padding: 10,
    marginTop: 6,
    background: "var(--bg1, transparent)",
  };
  const dim = { opacity: 0.75, fontSize: 12 };
  const sectionLabel = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontFamily: "var(--font-mono, monospace)",
    fontSize: 10.5,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: "var(--fg-dim, #999)",
    marginTop: 14,
  };
  const labelRule = { flex: 1, height: 1, background: "var(--hairline, #333)" };
  const Label = (text: string): JSX.Element => (
    <div style={sectionLabel}>
      {text}
      <span style={labelRule} />
    </div>
  );
  const dot = (alive: boolean): JSX.Element => (
    <span
      title={alive ? "alive" : "dead"}
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: alive ? "var(--success, #2a2)" : "var(--fg-dim, #999)",
      }}
    />
  );

  type MinerRow = MinerEntry & { alive: boolean };
  type CostResult = { netuid: number; rao: string; tao: string };
  type StatusRow = MinerEntry & { alive: boolean };

  function MiningPage(): JSX.Element {
    const run = api.processes?.run;
    const personasApi = api.personas;

    const [subnets, setSubnets] = useState<Subnet[]>([]);
    const [covered, setCovered] = useState<number[]>([]);
    const [miners, setMiners] = useState<MinerRow[]>([]);
    const [personas, setPersonas] = useState<string[]>([]);
    const [refreshing, setRefreshing] = useState(false);
    const [busy, setBusy] = useState<string | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    // Inline persona picker (point 3, multi-persona case): `window.prompt()`
    // has no precedent here and is a known dead end in the Tauri/wry
    // webview (returns null immediately) — a real in-view picker instead.
    const [pickFor, setPickFor] = useState<number | undefined>(undefined);
    const [pickChoice, setPickChoice] = useState<string>("");

    const loadCatalog = useCallback(async () => {
      const [s, c] = await Promise.all([
        api.storage.get<Subnet[]>("subnets"),
        api.storage.get<number[]>("covered"),
      ]);
      setSubnets(s ?? []);
      setCovered(c ?? []);
    }, []);

    // Point 4: storage.get("miners") for the recorded fields (persona,
    // hotkey, uid, startedAt, lastExit) + `fez-mine status --json` for a
    // freshly-checked pid liveness — merged by (netuid, persona). A
    // status call that fails (no `processes` grant, or the bin errors)
    // degrades every row to "dead" rather than losing the row entirely.
    const loadMiners = useCallback(async () => {
      const stored = (await api.storage.get<MinerEntry[]>("miners")) ?? [];
      const aliveByKey = new Map<string, boolean>();
      if (run) {
        try {
          const out = await run("fez-mine", ["status", "--json"]);
          if (out.code === 0) {
            const rows = JSON.parse(out.stdout) as StatusRow[];
            for (const r of rows) aliveByKey.set(minerKey(r.netuid, r.persona), r.alive);
          }
        } catch {
          // best-effort — stored rows still render, just as "dead"
        }
      }
      setMiners(stored.map((m) => ({ ...m, alive: aliveByKey.get(minerKey(m.netuid, m.persona)) ?? false })));
    }, [run]);

    useEffect(() => {
      void loadCatalog();
      void loadMiners();
    }, [loadCatalog, loadMiners]);

    // Point 4: poll while mounted; the hook's cleanup (fires on unmount,
    // i.e. when the nav view is left) is the dispose — no manual
    // interval bookkeeping in the mount callback itself.
    useEffect(() => {
      const id = setInterval(() => void loadMiners(), 10_000);
      return () => clearInterval(id);
    }, [loadMiners]);

    useEffect(() => {
      if (!personasApi) return;
      personasApi.list().then(setPersonas).catch(() => setPersonas([]));
    }, [personasApi]);

    const refresh = useCallback(async () => {
      if (!run) return;
      setRefreshing(true);
      setError(undefined);
      try {
        const out = await run("fez-mine", ["subnets", "--refresh", "--json"]);
        if (out.code !== 0) throw new Error(out.stderr.trim() || `subnets --refresh exited ${out.code}`);
        await loadCatalog();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRefreshing(false);
      }
    }, [run, loadCatalog]);

    const stop = useCallback(
      async (netuid: number, persona: string) => {
        if (!run) return;
        const k = minerKey(netuid, persona);
        setBusy(k);
        setError(undefined);
        try {
          const out = await run("fez-mine", ["stop", "--netuid", String(netuid), "--persona", persona, "--json"]);
          if (out.code !== 0) throw new Error(out.stderr.trim() || `stop exited ${out.code}`);
          await loadMiners();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(undefined);
        }
      },
      [run, loadMiners]
    );

    // cost → confirm the exact burn → start → refresh, once a persona is
    // settled on (single-persona case or the inline picker's Continue).
    const doMine = useCallback(
      async (netuid: number, persona: string) => {
        if (!run) return;
        setBusy(`mine:${netuid}`);
        setError(undefined);
        try {
          const costOut = await run("fez-mine", ["cost", "--netuid", String(netuid), "--json"]);
          if (costOut.code !== 0) throw new Error(costOut.stderr.trim() || `cost exited ${costOut.code}`);
          const cost = JSON.parse(costOut.stdout) as CostResult;
          const ok = confirm(
            `Register ${persona} on netuid ${netuid}?\n\nBurns ~${cost.tao} tTAO — skipped (free) if ${persona} is already registered there.`
          );
          if (!ok) return;
          const startOut = await run("fez-mine", [
            "start",
            "--netuid",
            String(netuid),
            "--persona",
            persona,
            "--json",
          ]);
          if (startOut.code !== 0) throw new Error(startOut.stderr.trim() || `start exited ${startOut.code}`);
          await loadMiners();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(undefined);
        }
      },
      [run, loadMiners]
    );

    // Point 3: pick persona → doMine. `personasApi` absent gets a visible
    // error (same posture as the page-level `run`-absent guard below), not
    // a silent no-op.
    const mine = useCallback(
      (netuid: number) => {
        if (!run) return;
        if (!personasApi) {
          setError("Mining needs the `personas` permission — reinstall the extension to grant it.");
          return;
        }
        if (personas.length === 0) {
          setError("no personas yet — create one before mining");
          return;
        }
        setError(undefined);
        if (personas.length === 1) {
          void doMine(netuid, personas[0]);
          return;
        }
        setPickFor(netuid);
        setPickChoice(personas[0]);
      },
      [run, personasApi, personas, doMine]
    );

    if (!run) {
      return (
        <p className="settings-hint">
          Mining needs the `processes` permission — reinstall the extension to grant it.
        </p>
      );
    }

    const rows = subnetRows(subnets, covered);
    const subnetName = (netuid: number) => subnets.find((s) => s.netuid === netuid)?.name ?? `netuid ${netuid}`;

    return (
      <div>
        {error ? <p className="ob-error">{error}</p> : null}

        {Label("active miners")}
        {miners.length === 0 ? (
          <p style={dim}>no miners running yet</p>
        ) : (
          miners.map((m) => {
            const k = minerKey(m.netuid, m.persona);
            return (
              <div key={k} className="skill-row">
                <div className="skill-main">
                  <span className="skill-name">
                    {dot(m.alive)} {m.persona} · {subnetName(m.netuid)}
                  </span>
                  <div className="skill-desc" style={dim}>
                    {m.uid !== undefined ? `uid ${m.uid}` : "unregistered"}
                    {m.startedAt ? ` · started ${new Date(m.startedAt).toLocaleString()}` : ""}
                    {m.lastExit ? ` · ${m.lastExit}` : ""}
                  </div>
                </div>
                <div className="skill-actions">
                  <button className="agent-action" disabled={busy === k} onClick={() => void stop(m.netuid, m.persona)}>
                    {busy === k ? "stopping…" : "Stop"}
                  </button>
                </div>
              </div>
            );
          })
        )}

        <div style={{ ...sectionLabel, justifyContent: "space-between" }}>
          subnets
          <span style={labelRule} />
          <button className="skill-link" disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? "refreshing…" : "Refresh"}
          </button>
        </div>
        {rows.length === 0 ? (
          <p style={dim}>no subnets yet — Refresh to load the catalog</p>
        ) : (
          rows.map((r) => {
            const busyKey = `mine:${r.netuid}`;
            return (
              <div key={r.netuid} className="skill-row" style={card}>
                <div className="skill-main">
                  <span className="skill-name">
                    {r.netuid} · {r.name}
                    {r.description ? ` — ${r.description}` : ""}
                  </span>
                  <div className="skill-desc" style={dim}>
                    {r.curated ? (
                      <span className="badge">curated</span>
                    ) : (
                      <span className="badge" title="not yet supported — coming in a future release" style={{ opacity: 0.6 }}>
                        agent-run (v2)
                      </span>
                    )}
                  </div>
                </div>
                {r.curated ? (
                  <div className="skill-actions" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {pickFor === r.netuid ? (
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <select
                          value={pickChoice}
                          onChange={(e: { target: { value: string } }) => setPickChoice(e.target.value)}
                        >
                          {personas.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                        <button
                          className="agent-action"
                          disabled={busy === busyKey}
                          onClick={() => {
                            const persona = pickChoice;
                            setPickFor(undefined);
                            void doMine(r.netuid, persona);
                          }}
                        >
                          {busy === busyKey ? "working…" : "Continue"}
                        </button>
                        <button className="skill-link" onClick={() => setPickFor(undefined)}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button className="agent-action" disabled={busy === busyKey} onClick={() => mine(r.netuid)}>
                        {busy === busyKey ? "working…" : "Mine"}
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    );
  }

  api.registerNavView("mining", { glyph: "⛏", label: "Mining" }, () => <MiningPage />);
}
