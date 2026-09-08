import type { GuiExtensionApi } from "@fezchat/extension-api/gui";
import type { ConfigField } from "@fezchat/extension-api";
import type { MinerEntry, Subnet } from "./state.js";
import { subnetRows, machineChoices, initialFormValues, stackFor, HARDWARE_GATED, type MachineChoice, type ConfigFormValues } from "./gui-rows.js";
import { validateConfig } from "./config.js";
import { MINING_SOURCE, MINING_CHANNEL_NAME, minerRootLine, parseMinerRoot } from "./thread.js";
import { ensureMiningSkill, removeMiningSkill } from "./persona-skill.js";
import { SUBNET_LOGOS } from "./subnet-logos.js";

/**
 * fez-mining, GUI part — the "Mining" nav view: active miners up top (each
 * row opens its chat thread in #mining), a "New miner" button below that
 * runs the picker (subnet → machine → config form → persona → confirm).
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
 *
 * The #mining channel is the one exception to "CLI verb only": `client`
 * (read:channels + publish) is what ensures the channel, posts a miner's
 * root line, and opens its thread. Guarded throughout — an older host or
 * an ungranted permission degrades to "no thread" rather than a crash.
 */
export default function activate(api: GuiExtensionApi): void {
  const h = api.React.createElement;
  const { useState, useEffect, useCallback, useRef } = api.React;
  const { client } = api;
  const hasChannels = !!client && typeof client.ensureChannel === "function";

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
        background: alive ? "var(--green, #b8bb26)" : "var(--fg-dim, #999)",
      }}
    />
  );

  // One config-form field, bound to `values[f.key]`. No hooks — a plain
  // element factory, same as Label/dot above.
  const ConfigFieldRow = (f: ConfigField, values: ConfigFormValues, onChange: (key: string, val: string | number | boolean) => void): JSX.Element => {
    const val = values[f.key];
    let control: JSX.Element;
    if (f.type === "boolean") {
      control = (
        <input type="checkbox" checked={Boolean(val)} onChange={(e: { target: { checked: boolean } }) => onChange(f.key, e.target.checked)} />
      );
    } else if (f.type === "select") {
      control = (
        <select className="manage-input" value={String(val ?? "")} onChange={(e: { target: { value: string } }) => onChange(f.key, e.target.value)}>
          {(f.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    } else if (f.type === "number") {
      control = (
        <input
          className="manage-input"
          type="number"
          value={val !== undefined ? String(val) : ""}
          onChange={(e: { target: { value: string } }) => onChange(f.key, Number(e.target.value))}
        />
      );
    } else if (f.type === "secret") {
      control = (
        <input
          className="manage-input"
          type="password"
          placeholder={f.required ? "required" : "optional — leave blank to skip"}
          value={val !== undefined ? String(val) : ""}
          onChange={(e: { target: { value: string } }) => onChange(f.key, e.target.value)}
        />
      );
    } else {
      control = (
        <input
          className="manage-input"
          type="text"
          value={val !== undefined ? String(val) : ""}
          onChange={(e: { target: { value: string } }) => onChange(f.key, e.target.value)}
        />
      );
    }
    return (
      <div key={f.key} className="settings-field" style={{ marginTop: 8 }}>
        <label className="set-label">
          {f.label}
          {f.required ? " *" : ""}
        </label>
        <div style={{ marginTop: 2 }}>{control}</div>
        {f.help ? <div style={dim}>{f.help}</div> : null}
      </div>
    );
  };

  type MinerRow = MinerEntry & { alive: boolean };
  type CostResult = { netuid: number; rao: string; tao: string };
  type StatusRow = MinerEntry & { alive: boolean };

  // Mirrors fez-wallet's chains/subtensor.ts MetagraphInfo — this GUI
  // reaches it only through `fez-mine metagraph`'s JSON passthrough, so
  // the shape is copied rather than imported across the package boundary.
  // `{}` (no `uid`) is what a failed/unregistered read prints — never
  // rendered.
  type MetagraphInfo = {
    uid?: number;
    incentive: number;
    trust: number;
    rank: number;
    consensus: number;
    dividends: number;
    emission: string;
    active: boolean;
    stake?: string;
    immunityLeftBlocks: number;
  };

  // The characteristic mining glance: the on-chain metrics as labelled
  // monospace stats, with incentive lit phosphor-green the moment the miner
  // is actually earning. This is the hero of a miner row — "is it working?"
  // answered without reading a sentence. `{}` (no uid) renders nothing.
  const metricStrip = (m?: MetagraphInfo): JSX.Element | null => {
    if (!m || m.uid === undefined) return null;
    const earning = m.incentive > 0;
    const stat = (label: string, value: string, lit = false): JSX.Element => (
      <span key={label} style={{ display: "inline-flex", gap: 4, alignItems: "baseline" }}>
        <span style={{ color: "var(--fg-dim, #999)", fontSize: 10.5 }}>{label}</span>
        <span style={{ color: lit ? "var(--green, #b8bb26)" : "var(--fg, #ddd)" }}>{value}</span>
      </span>
    );
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontFamily: "var(--font-mono, monospace)", fontSize: 12, marginTop: 5 }}>
        {stat("incentive", m.incentive.toFixed(2), earning)}
        {stat("emission", m.emission)}
        {stat("trust", m.trust.toFixed(2))}
        {stat("rank", m.rank.toFixed(2))}
        {m.stake !== undefined ? stat("stake", `${m.stake}α`) : null}
        {m.immunityLeftBlocks > 0 ? stat("immunity", `${m.immunityLeftBlocks}b`) : null}
      </div>
    );
  };

  // Launch area: a grid of tiles for the few subnets you can start now, and
  // a dense hairline table for the full Bittensor list. Two densities on
  // purpose — the tiles are for acting, the table is for browsing.
  const tileGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8, marginTop: 8 };
  const tile = {
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
    padding: 10,
    border: "1px solid var(--hairline, #333)",
    borderRadius: 8,
    background: "var(--bg1, transparent)",
  };
  const mono = { fontFamily: "var(--font-mono, monospace)" };
  // A subnet's badge: the team's real logo (bundled netuid→URL map pointing
  // at each team's own public asset — see subnet-logos.ts) painted over a
  // gruvbox-tinted monogram. The monogram is the base layer, so the 39
  // subnets with no logo — or any URL that has since died — degrade to a
  // colored initial rather than a broken image.
  const AVATAR_HUES = ["#83a598", "#b8bb26", "#fabd2f", "#fe8019", "#d3869b", "#8ec07c"];
  const logoUrls: Record<number, string> = SUBNET_LOGOS;
  const subnetAvatar = (netuid: number, name: string): JSX.Element => {
    const hue = AVATAR_HUES[netuid % AVATAR_HUES.length];
    const letter = (name.trim()[0] ?? "?").toUpperCase();
    const logo = logoUrls[netuid];
    return (
      <span
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          borderRadius: "50%",
          flex: "none",
          overflow: "hidden",
          background: `color-mix(in srgb, ${hue} 20%, var(--bg1, #282828))`,
          color: hue,
          fontWeight: 700,
          fontSize: 12.5,
          fontFamily: "var(--font-mono, monospace)",
        }}
      >
        {letter}
        {logo ? (
          <img
            src={logo}
            alt=""
            loading="lazy"
            onError={(e: { currentTarget: { style: { display: string } } }) => {
              e.currentTarget.style.display = "none";
            }}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", background: "var(--bg1, #282828)" }}
          />
        ) : null}
      </span>
    );
  };
  const subnetRowStyle = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "9px 6px",
    borderBottom: "1px solid color-mix(in srgb, var(--hairline, #333) 55%, transparent)",
  };

  // The New-miner picker's state machine — one step at a time, each
  // carrying forward what earlier steps decided. `undefined` = picker
  // closed (the normal "active miners" view).
  type PickerStep =
    | { kind: "machine"; netuid: number }
    | { kind: "config"; netuid: number; machine?: MachineChoice; schema: ConfigField[]; values: ConfigFormValues }
    | { kind: "persona"; netuid: number; machine?: MachineChoice; schema: ConfigField[]; values: ConfigFormValues; persona: string }
    | { kind: "confirm"; netuid: number; machine?: MachineChoice; schema: ConfigField[]; values: ConfigFormValues; persona: string; message: string };

  function MiningPage(): JSX.Element {
    const run = api.processes?.run;
    const personasApi = api.personas;

    const [subnets, setSubnets] = useState<Subnet[]>([]);
    const [covered, setCovered] = useState<number[]>([]);
    const [requirementsByNetuid, setRequirementsByNetuid] = useState<
      Record<number, { gpu?: string; publicEndpoint?: boolean }>
    >({});
    const [miners, setMiners] = useState<MinerRow[]>([]);
    const [personas, setPersonas] = useState<string[]>([]);
    const [refreshing, setRefreshing] = useState(false);
    const [busy, setBusy] = useState<string | undefined>(undefined);
    const [error, setErrorState] = useState<string | undefined>(undefined);
    // A failure renders inline where the user is looking AND fires the
    // host's red toast — visible from any pane, the way core surfaces its
    // own failures. Hosts without api.toast just keep the inline copy.
    const setError = useCallback((msg: string | undefined): void => {
      setErrorState(msg);
      if (msg) api.toast?.(msg, "error");
    }, []);
    // The picker, and the machine-step's in-progress radio choice (kept
    // separate since it's mutated per-keystroke, unlike the step object).
    const [picker, setPicker] = useState<PickerStep | undefined>(undefined);
    const [machineChoice, setMachineChoice] = useState<MachineChoice>("local");
    const [subnetFilter, setSubnetFilter] = useState("");
    const [showAllSubnets, setShowAllSubnets] = useState(false);

    const loadCatalog = useCallback(async () => {
      const [s, c, req] = await Promise.all([
        api.storage.get<Subnet[]>("subnets"),
        api.storage.get<number[]>("covered"),
        api.storage.get<Record<number, { gpu?: string; publicEndpoint?: boolean }>>("requirementsByNetuid"),
      ]);
      setSubnets(s ?? []);
      setCovered(c ?? []);
      setRequirementsByNetuid(req ?? {});
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

    // Metagraph enrichment: best-effort, ~30s, one `fez-mine metagraph`
    // call per active miner. Reads `miners` through a ref rather than as
    // an effect dependency — the poll interval shouldn't reset every time
    // the 10s status poll above replaces the `miners` array.
    const [metagraphByKey, setMetagraphByKey] = useState<Record<string, MetagraphInfo>>({});
    const minersRef = useRef<MinerRow[]>(miners);
    useEffect(() => {
      minersRef.current = miners;
    }, [miners]);
    const loadMetagraph = useCallback(async () => {
      if (!run) return;
      const active = minersRef.current.filter((m) => m.alive || m.desired === "running");
      const results = await Promise.all(
        active.map(async (m): Promise<[string, MetagraphInfo] | undefined> => {
          try {
            const out = await run("fez-mine", ["metagraph", "--netuid", String(m.netuid), "--persona", m.persona, "--json"]);
            if (out.code !== 0) return undefined;
            const parsed = JSON.parse(out.stdout) as MetagraphInfo;
            return parsed.uid !== undefined ? [minerKey(m.netuid, m.persona), parsed] : undefined;
          } catch {
            return undefined; // best-effort — the row just shows no enrichment line
          }
        })
      );
      setMetagraphByKey(Object.fromEntries(results.filter((r): r is [string, MetagraphInfo] => r !== undefined)));
    }, [run]);
    useEffect(() => {
      void loadMetagraph();
      const id = setInterval(() => void loadMetagraph(), 30_000);
      return () => clearInterval(id);
    }, [loadMetagraph]);

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

    // Refresh from chain on mount so `covered` and the machine
    // requirements are current the first time the page opens — a
    // freshly-linked descriptor (a new curated subnet) won't badge as
    // curated until a refresh recomputes it. loadCatalog above already
    // painted the cached catalog instantly; this brings it up to date.
    useEffect(() => {
      void refresh();
    }, [refresh]);

    const stop = useCallback(
      async (netuid: number, persona: string) => {
        if (!run) return;
        const k = minerKey(netuid, persona);
        setBusy(k);
        setError(undefined);
        try {
          const out = await run("fez-mine", ["stop", "--netuid", String(netuid), "--persona", persona, "--json"]);
          if (out.code !== 0) throw new Error(out.stderr.trim() || `stop exited ${out.code}`);

          // Revert the mining-skill opt-in once this was P's last miner.
          // Re-reads status rather than trusting the (not-yet-reloaded)
          // `miners` state, so a persona with another still-running miner
          // keeps the skill. Best-effort — the stop itself already
          // succeeded either way.
          if (personasApi) {
            try {
              const statusOut = await run("fez-mine", ["status", "--json"]);
              const rows = statusOut.code === 0 ? (JSON.parse(statusOut.stdout) as StatusRow[]) : [];
              const stillMining = rows.some((r) => r.persona === persona && (r.alive || r.desired === "running"));
              if (!stillMining) {
                const md = await personasApi.read(persona);
                const next = removeMiningSkill(md);
                if (next !== md) await personasApi.update(persona, next);
              }
            } catch (err) {
              api.toast?.(
                `${persona} stopped mining but chat-skill revert failed: ${err instanceof Error ? err.message : String(err)}`,
                "error"
              );
            }
          }

          await loadMiners();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(undefined);
        }
      },
      [run, loadMiners, personasApi]
    );

    // Restart a crashed miner — re-issue start on the same machine kind it
    // was on (so a lium miner re-provisions a pod rather than falling back
    // to local). No teardown: a dead runner has nothing to stop first.
    const restart = useCallback(
      async (m: MinerRow) => {
        if (!run) return;
        const k = minerKey(m.netuid, m.persona);
        setBusy(k);
        setError(undefined);
        try {
          const args = ["start", "--netuid", String(m.netuid), "--persona", m.persona, "--json"];
          if (m.machine?.kind === "lium") args.push("--machine", "lium");
          const out = await run("fez-mine", args);
          if (out.code !== 0) throw new Error(out.stderr.trim() || `start exited ${out.code}`);
          await loadMiners();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(undefined);
        }
      },
      [run, loadMiners]
    );

    // Find a miner's chat-thread root: `threadRootId` when it's already
    // recorded (the fast path — set by whichever side, GUI or headless,
    // posted first), else scan the channel's messages for the matching
    // root line. `attempts` > 1 is only used right after THIS gui posts a
    // fresh root — the client may not have absorbed its own publish yet.
    const findRoot = useCallback(
      async (channelId: string, netuid: number, persona: string, attempts = 1): Promise<{ id: string } | undefined> => {
        if (!client) return undefined;
        for (let i = 0; i < attempts; i++) {
          const found = client.messages(channelId).find((m) => {
            const p = parseMinerRoot(m.content);
            return p !== null && p.netuid === netuid && p.persona === persona;
          });
          if (found) return found;
          if (i < attempts - 1) await new Promise((r) => setTimeout(r, 250));
        }
        return undefined;
      },
      [client]
    );

    // Active-miner row click → open its thread. `threadRootId` is the
    // fast path; otherwise scan #mining for the matching root (a miner
    // that has never posted one — e.g. started from a bare CLI, never
    // through this picker — has no thread to open).
    const openMinerThread = useCallback(
      async (m: MinerRow) => {
        if (!hasChannels || !client) {
          setError("Mining chat needs the `read:channels` permission — reinstall the extension to grant it.");
          return;
        }
        setError(undefined);
        const channelId = await client.ensureChannel({ name: MINING_CHANNEL_NAME, source: MINING_SOURCE });
        if (!channelId) {
          setError("could not open the #mining channel");
          return;
        }
        if (m.threadRootId) {
          api.openThread(channelId, m.threadRootId);
          return;
        }
        const root = await findRoot(channelId, m.netuid, m.persona);
        if (root) {
          api.openThread(channelId, root.id);
          return;
        }
        setError(`no chat thread yet for ${m.persona} · netuid ${m.netuid} — it may have started outside the GUI`);
      },
      [client, findRoot]
    );

    // netuid → its config schema, via the new `fez-mine describe` verb.
    // Best-effort: a descriptor with no config (or a describe failure)
    // just skips the config step.
    const describeSubnet = useCallback(
      async (netuid: number): Promise<ConfigField[]> => {
        if (!run) return [];
        try {
          const out = await run("fez-mine", ["describe", "--netuid", String(netuid), "--json"]);
          if (out.code !== 0) return [];
          const parsed = JSON.parse(out.stdout) as { config?: ConfigField[] };
          return parsed.config ?? [];
        } catch {
          return [];
        }
      },
      [run]
    );

    // Machine step (when required) lands here next; a subnet with no
    // machine requirement lands here straight from the subnet step.
    // Empty schema skips the config step entirely — straight to persona.
    const enterConfigStep = useCallback(
      async (netuid: number, machine: MachineChoice | undefined) => {
        const schema = await describeSubnet(netuid);
        const values = initialFormValues(schema);
        if (schema.length === 0) {
          setPicker({ kind: "persona", netuid, machine, schema, values, persona: personas[0] ?? "" });
          return;
        }
        setPicker({ kind: "config", netuid, machine, schema, values });
      },
      [describeSubnet, personas]
    );

    // Subnet step's Select: personas/permission guard (same posture as
    // the old always-on Mine button), then machine step or straight to
    // the config step.
    const selectSubnet = useCallback(
      (netuid: number) => {
        if (!personasApi) {
          setError("Mining needs the `personas` permission — reinstall the extension to grant it.");
          return;
        }
        if (personas.length === 0) {
          setError("no personas yet — create one before mining");
          return;
        }
        setError(undefined);
        const req = requirementsByNetuid[netuid];
        if (req) {
          const choices = machineChoices(req);
          setMachineChoice(choices.find((c) => c.enabled)?.choice ?? "local");
          setPicker({ kind: "machine", netuid });
          return;
        }
        void enterConfigStep(netuid, undefined);
      },
      [personasApi, personas, requirementsByNetuid, enterConfigStep]
    );

    const confirmMachine = useCallback(
      (netuid: number, machine: MachineChoice) => {
        void enterConfigStep(netuid, machine);
      },
      [enterConfigStep]
    );

    const confirmConfig = useCallback(() => {
      if (!picker || picker.kind !== "config") return;
      const missing = validateConfig(picker.schema, picker.values);
      if (missing) {
        setError(`${missing} is required`);
        return;
      }
      setError(undefined);
      setPicker({ kind: "persona", netuid: picker.netuid, machine: picker.machine, schema: picker.schema, values: picker.values, persona: personas[0] ?? "" });
    }, [picker, personas]);

    // cost → confirm the exact burn → apply any config → start (once) →
    // ensure #mining + post the root + open the thread. `machine` set means the
    // requirement step chose "lium" — the confirm line then adds the
    // cheapest available $/hr and the account balance next to the burn,
    // and start gets `--machine lium`.
    const startFlow = useCallback(
      async (netuid: number, persona: string, machine: MachineChoice | undefined, schema: ConfigField[], values: ConfigFormValues) => {
        if (!run) return;
        setBusy(`mine:${netuid}`);
        setError(undefined);
        try {
          const costOut = await run("fez-mine", ["cost", "--netuid", String(netuid), "--json"]);
          if (costOut.code !== 0) throw new Error(costOut.stderr.trim() || `cost exited ${costOut.code}`);
          const cost = JSON.parse(costOut.stdout) as CostResult;

          let liumLine = "";
          if (machine === "lium") {
            const parts: string[] = [];
            let cheapestRate: number | null = null;
            try {
              const out = await run("fez-mine", ["machines", "--json"]);
              if (out.code === 0) {
                const nodes = JSON.parse(out.stdout) as { node: string; usdHour: number | null }[];
                const prices = nodes.map((n) => n.usdHour).filter((p): p is number => p !== null);
                if (prices.length) {
                  cheapestRate = Math.min(...prices);
                  parts.push(`from $${cheapestRate.toFixed(2)}/hr`);
                }
              }
            } catch { /* best-effort — the confirm still shows the burn */ }
            let balanceUsd: number | null = null;
            try {
              const out = await run("fez-mine", ["balance", "--json"]);
              if (out.code === 0) {
                const bal = JSON.parse(out.stdout) as { balanceUsd: number | null };
                balanceUsd = bal.balanceUsd;
                if (balanceUsd !== null) parts.push(`balance $${balanceUsd.toFixed(2)}`);
              }
            } catch { /* best-effort */ }
            if (parts.length) liumLine = `\n\nLium: ${parts.join(" · ")}`;
            // M2: a balance that can't cover even 1h at the shown rate blocks
            // outright rather than proceeding into a rental that fails (or
            // worse, half-succeeds) on insufficient funds.
            if (balanceUsd !== null && cheapestRate !== null && balanceUsd < cheapestRate) {
              setError(
                `Lium balance ($${balanceUsd.toFixed(2)}) won't cover 1h at the shown rate ($${cheapestRate.toFixed(2)}/hr) — top up at lium.io / lium_topup before mining.`
              );
              return;
            }
          }

          // Native confirm()/alert()/prompt() are dead in the Tauri/wry
          // webview (they return falsy without ever showing — proven live
          // for prompt(), and confirm() is the same family), which would
          // silently abort every start. So the burn confirmation is an
          // in-view step, same as the persona picker replaced prompt().
          setPicker({
            kind: "confirm", netuid, persona, machine, schema, values,
            message: `Register ${persona} on netuid ${netuid}? Burns ~${cost.tao} tTAO — skipped (free) if ${persona} is already registered there.${liumLine}`,
          });
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(undefined);
        }
      },
      [run]
    );

    // The post-confirm half of startFlow — run only after the in-view
    // confirm step's Confirm. config set (per field) → single start → open
    // the thread. Split from the prepare half so the native-dialog-free
    // confirm can sit between them.
    const doStart = useCallback(
      async (netuid: number, persona: string, machine: MachineChoice | undefined, schema: ConfigField[], values: ConfigFormValues) => {
        if (!run) return;
        setBusy(`mine:${netuid}`);
        setError(undefined);
        try {
          // Write the form's values BEFORE start — `config set` (state
          // branch) now creates a stopped stub entry when none exists yet,
          // so this no longer needs `start` to have run first. One
          // `start` after means one provision (a Lium pod isn't rented,
          // torn down, and re-rented just to pick up config it could have
          // had from the first spawn).
          for (const f of schema) {
            const raw = values[f.key];
            if (raw === undefined || raw === "") continue;
            const setArgs = ["config", "set", "--netuid", String(netuid), "--persona", persona, "--key", f.key, "--value", String(raw)];
            if (f.type === "secret") setArgs.push("--secret");
            const setOut = await run("fez-mine", setArgs);
            if (setOut.code !== 0) throw new Error(setOut.stderr.trim() || `config set ${f.key} exited ${setOut.code}`);
          }

          const startArgs = ["start", "--netuid", String(netuid), "--persona", persona, "--json"];
          if (machine === "lium") startArgs.push("--machine", "lium");
          const startOut = await run("fez-mine", startArgs);
          if (startOut.code !== 0) throw new Error(startOut.stderr.trim() || `start exited ${startOut.code}`);

          // Roster P into #mining and grant it the mining skill so it can
          // answer mining questions there. Best-effort — mining itself
          // already succeeded above; a missing `personas` permission or a
          // hiccup here shouldn't fail the whole start.
          if (personasApi) {
            try {
              await personasApi.invite?.(persona, "bot");
              const md = await personasApi.read(persona);
              const next = ensureMiningSkill(md);
              if (next !== md) await personasApi.update(persona, next);
            } catch (err) {
              api.toast?.(
                `${persona} started mining but chat wiring failed: ${err instanceof Error ? err.message : String(err)}`,
                "error"
              );
            }
          }

          // Ensure #mining, then ensure a root — idempotently. This is the
          // GUI's only restart path for a previously-stopped miner (stopped
          // miners drop off the active list, so re-running the picker is
          // how they come back); posting unconditionally here would give a
          // second root line, and `findRoot`/`thread set-root` would then
          // have two matches to pick between. Recorded state
          // (`threadRootId`, the fast path) wins; failing that, scan
          // #mining for an already-posted root (e.g. one that got posted
          // but never made it into state); only when neither turns one up
          // is a fresh root posted. Best-effort throughout: a missing
          // `read:channels` grant, or the client not yet absorbing its own
          // publish, leaves the miner running with no thread rather than
          // failing the whole flow.
          if (hasChannels && client) {
            const channelId = await client.ensureChannel({ name: MINING_CHANNEL_NAME, source: MINING_SOURCE });
            if (channelId) {
              const statusOut = await run("fez-mine", ["status", "--json"]);
              const rows = statusOut.code === 0 ? (JSON.parse(statusOut.stdout) as StatusRow[]) : [];
              const recordedRootId = rows.find((r) => r.netuid === netuid && r.persona === persona)?.threadRootId;
              if (recordedRootId) {
                api.openThread(channelId, recordedRootId);
              } else {
                let root = await findRoot(channelId, netuid, persona);
                if (!root) {
                  await client.sendChannelMessage(minerRootLine(netuid, persona), { channelId });
                  root = await findRoot(channelId, netuid, persona, 6);
                }
                if (root) {
                  await run("fez-mine", ["thread", "set-root", "--netuid", String(netuid), "--persona", persona, "--root", root.id]);
                  api.openThread(channelId, root.id);
                }
              }
            }
          }

          setPicker(undefined);
          await loadMiners();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(undefined);
        }
      },
      [run, loadMiners, findRoot, personasApi]
    );

    if (!run) {
      return (
        <p className="settings-hint">
          Mining needs the `processes` permission — reinstall the extension to grant it.
        </p>
      );
    }

    const subnetName = (netuid: number) => subnets.find((s) => s.netuid === netuid)?.name ?? `netuid ${netuid}`;
    // "Active" means running-or-meant-to-be: a crashed miner the sentinel
    // will respawn still belongs here (dead dot). A miner the user stopped
    // (desired:"stopped", dead) is not active — it drops off, so a stale
    // stopped entry never clutters the top of the page.
    const activeMiners = miners.filter((m) => m.alive || m.desired === "running");

    // Renders whichever picker step is open, or nothing when it's closed.
    const renderPicker = (): JSX.Element | null => {
      if (!picker) return null;
      const cancel = (): void => setPicker(undefined);

      if (picker.kind === "machine") {
        const req = requirementsByNetuid[picker.netuid];
        return (
          <div style={card}>
            {Label(`machine — ${subnetName(picker.netuid)}`)}
            {machineChoices(req).map((c) => (
              <label
                key={c.choice}
                title={c.reason}
                style={{ display: "flex", alignItems: "center", gap: 4, opacity: c.enabled ? 1 : 0.55, marginTop: 4 }}
              >
                <input
                  type="radio"
                  name="machine"
                  value={c.choice}
                  disabled={!c.enabled}
                  checked={machineChoice === c.choice}
                  onChange={() => setMachineChoice(c.choice)}
                />
                {c.choice}
                {c.reason ? ` — ${c.reason}` : ""}
              </label>
            ))}
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button className="agent-action" onClick={() => confirmMachine(picker.netuid, machineChoice)}>
                Continue
              </button>
              <button className="skill-link" onClick={cancel}>
                Cancel
              </button>
            </div>
          </div>
        );
      }

      if (picker.kind === "config") {
        const setValue = (key: string, val: string | number | boolean): void =>
          setPicker((prev: PickerStep | undefined) => (prev && prev.kind === "config" ? { ...prev, values: { ...prev.values, [key]: val } } : prev));
        return (
          <div style={card}>
            {Label(`configure — ${subnetName(picker.netuid)}`)}
            {picker.schema.map((f) => ConfigFieldRow(f, picker.values, setValue))}
            <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
              <button className="agent-action" onClick={confirmConfig}>
                Continue
              </button>
              <button className="skill-link" onClick={cancel}>
                Cancel
              </button>
            </div>
          </div>
        );
      }

      if (picker.kind === "confirm") {
        const busyKey = `mine:${picker.netuid}`;
        // Cancel steps BACK to the persona picker, not out of the whole
        // flow — a wrong persona (e.g. one with no wallet) should let you
        // pick another without restarting subnet → config from scratch.
        const backToPersona = (): void =>
          setPicker({ kind: "persona", netuid: picker.netuid, machine: picker.machine, schema: picker.schema, values: picker.values, persona: picker.persona });
        return (
          <div style={card}>
            {Label(`confirm — ${subnetName(picker.netuid)}`)}
            <p style={{ whiteSpace: "pre-wrap" }}>{picker.message}</p>
            {error ? <p className="ob-error" style={{ marginTop: 8 }}>{error}</p> : null}
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button
                className="agent-action"
                disabled={busy === busyKey}
                onClick={() => void doStart(picker.netuid, picker.persona, picker.machine, picker.schema, picker.values)}
              >
                {busy === busyKey ? "working…" : "Confirm & start"}
              </button>
              <button className="skill-link" onClick={backToPersona}>
                Back
              </button>
              <button className="skill-link" onClick={cancel}>
                Cancel
              </button>
            </div>
          </div>
        );
      }

      // persona
      const busyKey = `mine:${picker.netuid}`;
      const setPersona = (persona: string): void =>
        setPicker((prev: PickerStep | undefined) => (prev && prev.kind === "persona" ? { ...prev, persona } : prev));
      return (
        <div style={card}>
          {Label(`persona — ${subnetName(picker.netuid)}`)}
          {personas.length > 1 ? (
            <select className="manage-input" value={picker.persona} onChange={(e: { target: { value: string } }) => setPersona(e.target.value)}>
              {personas.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          ) : (
            <p style={dim}>{picker.persona}</p>
          )}
          {/* Surface a start failure (e.g. "no wallet for steph — run:
              fez-wallet derive steph") right here at the picker, not only in
              the page-top banner the user isn't looking at while choosing a
              persona — a non-wallet persona would otherwise just snap back to
              "Continue" with no visible reason. */}
          {error ? <p className="ob-error" style={{ marginTop: 8 }}>{error}</p> : null}
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button
              className="agent-action"
              disabled={busy === busyKey || !picker.persona}
              onClick={() => void startFlow(picker.netuid, picker.persona, picker.machine, picker.schema, picker.values)}
            >
              {busy === busyKey ? "working…" : "Continue"}
            </button>
            <button className="skill-link" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      );
    };

    // Launch-area data. The tiles are the few subnets you can start now; the
    // table is the full catalog, sorted so the actionable rows sit up top
    // (mineable → needs-hardware → not-yet-supported) and the long tail of
    // agent-run subnets stays collapsed until you ask for it or search —
    // otherwise 100+ dim rows bury everything above them.
    const catalogRows = subnetRows(subnets, covered, HARDWARE_GATED);
    const readyRows = catalogRows.filter((r) => r.curated && !r.gated);
    const statusRank = (r: (typeof catalogRows)[number]): number => (r.curated && !r.gated ? 0 : r.gated ? 1 : 2);
    const sortedRows = [...catalogRows].sort((a, b) => statusRank(a) - statusRank(b) || a.netuid - b.netuid);
    const q = subnetFilter.trim().toLowerCase();
    const searching = q.length > 0;
    const DEFAULT_SUBNET_COUNT = 20;
    const tableRows = searching
      ? sortedRows.filter((r) => r.name.toLowerCase().includes(q) || String(r.netuid).includes(q))
      : showAllSubnets
        ? sortedRows
        : sortedRows.slice(0, DEFAULT_SUBNET_COUNT); // actionable sorted first, then a page of the rest
    const hiddenCount = sortedRows.length - tableRows.length;
    const machineHint = (netuid: number): string => {
      const req = requirementsByNetuid[netuid];
      if (req?.gpu) return "needs a GPU";
      if (req?.publicEndpoint) return "public endpoint";
      return "runs locally";
    };

    // The stacking story on a tile: this subnet's badge with its component
    // subnets' badges overlapped behind it (Gradients ⟵ Lium; Bazaar ⟵
    // Chutes), plus a plain line naming what each component contributes.
    const stackCluster = (netuid: number, name: string): JSX.Element => {
      const comps = stackFor(netuid, requirementsByNetuid[netuid]);
      return (
        <span style={{ display: "inline-flex", alignItems: "center", flex: "none" }}>
          {subnetAvatar(netuid, name)}
          {comps.map((c) => (
            <span key={c} style={{ marginLeft: -9, display: "inline-flex", borderRadius: "50%", boxShadow: "0 0 0 2px var(--bg1, #282828)" }}>
              {subnetAvatar(c, subnetName(c))}
            </span>
          ))}
        </span>
      );
    };
    const stackLine = (netuid: number): string => {
      const comps = stackFor(netuid, requirementsByNetuid[netuid]);
      if (comps.length === 0) return machineHint(netuid);
      const what = (c: number): string => {
        const nm = subnetName(c).replace(/\.io$/, "");
        const req = requirementsByNetuid[netuid];
        if (c === 51) return req?.gpu ? `${nm} GPU pod` : `${nm} pod for the endpoint`;
        if (c === 64) return `${nm} inference key`;
        return nm;
      };
      return `mined with ${comps.map(what).join(" + ")}`;
    };

    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, padding: "4px 24px 0" }}>
        {error ? <p className="ob-error">{error}</p> : null}

        <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", paddingTop: 8, paddingBottom: 28 }}>
          {Label("your miners")}
          {activeMiners.length === 0 ? (
            <p style={dim}>No miners running. Launch one below.</p>
          ) : (
            activeMiners.map((m) => {
              const k = minerKey(m.netuid, m.persona);
              return (
                <div
                  key={k}
                  className="skill-row"
                  style={{ cursor: hasChannels ? "pointer" : undefined }}
                  onClick={() => void openMinerThread(m)}
                >
                  <div className="skill-main">
                    <span className="skill-name">
                      {dot(m.alive)} {m.persona} · {subnetName(m.netuid)}
                    </span>
                    <div className="skill-desc" style={{ ...dim, ...mono }}>
                      {m.uid !== undefined ? `uid ${m.uid}` : "unregistered"}
                      {m.machine?.kind === "lium" && m.machine.podId
                        ? ` · pod ${m.machine.podId}${m.machine.hourlyRate ? ` · $${m.machine.hourlyRate}/hr` : ""}`
                        : " · local"}
                      {m.machine?.kind === "lium" && m.machine.externalIp && m.machine.externalPort
                        ? ` · ${m.machine.externalIp}:${m.machine.externalPort}`
                        : ""}
                      {m.alive && m.startedAt ? ` · up since ${new Date(m.startedAt).toLocaleString()}` : ""}
                    </div>
                    {m.attention ? (
                      <div className="skill-desc" style={{ color: "var(--yellow, #fabd2f)" }}>
                        ⚠ {m.attention}
                      </div>
                    ) : null}
                    {m.alive ? (
                      metricStrip(metagraphByKey[k])
                    ) : (
                      <div className="skill-desc" style={{ color: "var(--red, #fb4934)", marginTop: 4 }}>
                        {requirementsByNetuid[m.netuid]?.publicEndpoint && m.machine?.kind !== "lium"
                          ? `Not running — ${subnetName(m.netuid)} needs a reachable endpoint a local Mac can't provide. Restart on a Lium pod, or open the thread for logs.`
                          : `Not running${m.lastExit ? ` — ${m.lastExit}` : ""}. Restart, or open the thread for logs.`}
                      </div>
                    )}
                  </div>
                  <div className="skill-actions">
                    {!m.alive ? (
                      <button
                        className="agent-action"
                        disabled={busy === k}
                        onClick={(e: { stopPropagation: () => void }) => {
                          e.stopPropagation();
                          void restart(m);
                        }}
                      >
                        {busy === k ? "working…" : "Restart"}
                      </button>
                    ) : null}
                    <button
                      className="agent-action"
                      disabled={busy === k}
                      onClick={(e: { stopPropagation: () => void }) => {
                        e.stopPropagation();
                        void stop(m.netuid, m.persona);
                      }}
                    >
                      {busy === k ? "working…" : "Stop"}
                    </button>
                  </div>
                </div>
              );
            })
          )}

          {picker ? (
            renderPicker()
          ) : (
            <div>
              <div style={{ ...sectionLabel, justifyContent: "space-between" }}>
                ready to mine
                <span style={labelRule} />
                <button className="skill-link" disabled={refreshing} onClick={() => void refresh()}>
                  {refreshing ? "refreshing…" : "Refresh"}
                </button>
              </div>
              {readyRows.length === 0 ? (
                <p style={dim}>No mineable subnets yet — Refresh to load the catalog.</p>
              ) : (
                <div style={tileGrid}>
                  {readyRows.map((r) => (
                    <div key={r.netuid} style={tile}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        {stackCluster(r.netuid, r.name)}
                        <div style={{ minWidth: 0 }}>
                          <div className="skill-name">{r.name}</div>
                          <div style={{ ...dim, ...mono, fontSize: 11.5 }}>SN{r.netuid}</div>
                        </div>
                      </div>
                      <div style={{ ...dim, flex: 1 }}>{stackLine(r.netuid)}</div>
                      <button className="agent-action" onClick={() => selectSubnet(r.netuid)}>
                        Launch
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {Label("all subnets")}
              <input
                className="manage-input"
                type="text"
                placeholder="Search subnets…"
                value={subnetFilter}
                onChange={(e: { target: { value: string } }) => setSubnetFilter(e.target.value)}
                style={{ marginTop: 6, marginBottom: 4, width: "100%", boxSizing: "border-box" }}
              />
              {tableRows.length === 0 ? (
                <p style={dim}>{searching ? `No subnets match “${subnetFilter}”.` : "No subnets yet — Refresh to load the catalog."}</p>
              ) : (
                tableRows.map((r) => {
                  const mineable = r.curated && !r.gated;
                  return (
                    <div
                      key={r.netuid}
                      style={{ ...subnetRowStyle, cursor: mineable ? "pointer" : undefined }}
                      title={mineable ? `Launch a miner on ${r.name}` : r.description}
                      onClick={mineable ? () => selectSubnet(r.netuid) : undefined}
                    >
                      {subnetAvatar(r.netuid, r.name)}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="skill-name" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.name}
                        </div>
                        <div style={{ ...dim, ...mono, fontSize: 11.5 }}>SN{r.netuid}</div>
                      </div>
                      {mineable ? (
                        <span style={{ color: "var(--green, #b8bb26)", flex: "none" }}>● Mineable</span>
                      ) : r.gated ? (
                        <span style={{ color: "var(--yellow, #fabd2f)", flex: "none" }}>◐ Needs hardware</span>
                      ) : (
                        <span style={{ ...dim, flex: "none" }}>— Agent-run soon</span>
                      )}
                    </div>
                  );
                })
              )}
              {!searching && (hiddenCount > 0 || showAllSubnets) ? (
                <button className="skill-link" style={{ marginTop: 8 }} onClick={() => setShowAllSubnets((v) => !v)}>
                  {showAllSubnets ? "Show fewer" : `Show all ${sortedRows.length} subnets`}
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>
    );
  }

  api.registerNavView("mining", { glyph: "⛏", label: "Mining" }, () => <MiningPage />);

  // The thread-view card: one root per (netuid, persona), rendered above
  // its replies in #mining. Status + a log tail poll every 10s; config is
  // read-only with an Edit toggle that reuses ConfigFieldRow — on save this
  // is a restart-to-apply on an ALREADY-RUNNING miner: `cmdStop` tears the
  // pod down and clears `podId`, so the following `start` PROVISIONS A
  // FRESH POD at current market rate (it does not reattach). That's an
  // acceptable, once-confirmed-by-alive-Save cost for a running miner; a
  // STOPPED miner has no pod to tear down, so Save there only writes
  // config and skips the restart entirely (see saveConfig below) rather
  // than silently starting a pod from $0. Unlike the New-miner picker's
  // write-before-first-start above.
  type ConfigView = Record<string, string | number | boolean>;

  function MinerCard(props: { channelId: string; rootId: string; rootContent: string }): JSX.Element | null {
    const run = api.processes?.run;
    const parsed = parseMinerRoot(props.rootContent);
    const netuid = parsed?.netuid ?? 0;
    const persona = parsed?.persona ?? "";

    const [status, setStatus] = useState<StatusRow | undefined>(undefined);
    const [logs, setLogs] = useState("");
    const [schema, setSchema] = useState<ConfigField[]>([]);
    const [config, setConfig] = useState<ConfigView>({});
    const [editing, setEditing] = useState(false);
    const [values, setValues] = useState<ConfigFormValues>({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);

    const loadStatus = useCallback(async () => {
      if (!run || !parsed) return;
      try {
        const out = await run("fez-mine", ["status", "--json"]);
        if (out.code === 0) {
          const rows = JSON.parse(out.stdout) as StatusRow[];
          setStatus(rows.find((r) => r.netuid === netuid && r.persona === persona));
        }
      } catch {
        // best-effort — last-known status stays on screen
      }
    }, [run, netuid, persona]);

    const loadLogs = useCallback(async () => {
      if (!run || !parsed) return;
      try {
        const out = await run("fez-mine", ["logs", "--netuid", String(netuid), "--persona", persona, "--lines", "12"]);
        if (out.code === 0) setLogs(out.stdout);
      } catch {
        // best-effort
      }
    }, [run, netuid, persona]);

    const loadConfig = useCallback(async () => {
      if (!run || !parsed) return;
      try {
        const [schemaOut, configOut] = await Promise.all([
          run("fez-mine", ["describe", "--netuid", String(netuid), "--json"]),
          run("fez-mine", ["config", "get", "--netuid", String(netuid), "--persona", persona, "--json"]),
        ]);
        if (schemaOut.code === 0) {
          const d = JSON.parse(schemaOut.stdout) as { config?: ConfigField[] };
          setSchema(d.config ?? []);
        }
        if (configOut.code === 0) setConfig(JSON.parse(configOut.stdout) as ConfigView);
      } catch {
        // best-effort
      }
    }, [run, netuid, persona]);

    const [metagraph, setMetagraph] = useState<MetagraphInfo | undefined>(undefined);
    const loadMetagraph = useCallback(async () => {
      if (!run || !parsed) return;
      try {
        const out = await run("fez-mine", ["metagraph", "--netuid", String(netuid), "--persona", persona, "--json"]);
        if (out.code === 0) {
          const m = JSON.parse(out.stdout) as MetagraphInfo;
          setMetagraph(m.uid !== undefined ? m : undefined);
        }
      } catch {
        // best-effort — last-known reading stays on screen
      }
    }, [run, netuid, persona]);

    useEffect(() => {
      void loadStatus();
      void loadLogs();
      void loadConfig();
      void loadMetagraph();
    }, [loadStatus, loadLogs, loadConfig, loadMetagraph]);

    // Poll status + logs while the thread is open; config only reloads on
    // mount and after a save (it doesn't drift on its own). Metagraph gets
    // its own slower ~30s cadence — a chain read, not a local status check.
    useEffect(() => {
      const id = setInterval(() => {
        void loadStatus();
        void loadLogs();
      }, 10_000);
      return () => clearInterval(id);
    }, [loadStatus, loadLogs]);
    useEffect(() => {
      const id = setInterval(() => void loadMetagraph(), 30_000);
      return () => clearInterval(id);
    }, [loadMetagraph]);

    if (!parsed) return null;
    if (!run) {
      return (
        <p className="settings-hint">Mining needs the `processes` permission — reinstall the extension to grant it.</p>
      );
    }

    const doStop = async (): Promise<void> => {
      setBusy(true);
      setError(undefined);
      try {
        const out = await run("fez-mine", ["stop", "--netuid", String(netuid), "--persona", persona, "--json"]);
        if (out.code !== 0) throw new Error(out.stderr.trim() || `stop exited ${out.code}`);
        await loadStatus();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    };

    // Seed the edit form from the CURRENT resolved value (config get's
    // masked view — "set"/"unset" for a secret, the live value otherwise),
    // not the schema default: editing means changing what's already there.
    // A secret still always starts blank (never re-displayed) — leaving it
    // blank on save means "keep the stored one", same as the New-miner form.
    const startEdit = (): void => {
      const seeded: ConfigFormValues = {};
      for (const f of schema) {
        if (f.type === "secret") {
          seeded[f.key] = "";
          continue;
        }
        const v = config[f.key];
        seeded[f.key] = v !== undefined ? v : (f.default ?? "");
      }
      setValues(seeded);
      setError(undefined);
      setEditing(true);
    };

    // config set per changed field; then, only for an already-running
    // miner, stop+start to apply. That stop+start is a genuine tear-down
    // and re-provision, not a reattach — see the block comment above — so
    // a STOPPED miner skips it: config alone is written and picked up on
    // the next manual start, rather than a Save click silently spinning up
    // a fresh pod. Carries `--machine lium` forward when this miner is
    // already on one, so the restart re-provisions on the same machine
    // kind instead of the orphan-teardown path in cmdStart tearing it down
    // (a plain `start` with no `--machine lium` reads as "go local" there).
    const saveConfig = async (): Promise<void> => {
      const missing = validateConfig(schema, values);
      if (missing) {
        setError(`${missing} is required`);
        return;
      }
      setBusy(true);
      setError(undefined);
      try {
        for (const f of schema) {
          const raw = values[f.key];
          if (raw === undefined || raw === "") continue;
          const setArgs = ["config", "set", "--netuid", String(netuid), "--persona", persona, "--key", f.key, "--value", String(raw)];
          if (f.type === "secret") setArgs.push("--secret");
          const out = await run("fez-mine", setArgs);
          if (out.code !== 0) throw new Error(out.stderr.trim() || `config set ${f.key} exited ${out.code}`);
        }
        if (status?.alive) {
          const stopOut = await run("fez-mine", ["stop", "--netuid", String(netuid), "--persona", persona, "--json"]);
          if (stopOut.code !== 0) throw new Error(stopOut.stderr.trim() || `stop exited ${stopOut.code}`);
          const startArgs = ["start", "--netuid", String(netuid), "--persona", persona, "--json"];
          if (status?.machine?.kind === "lium") startArgs.push("--machine", "lium");
          const startOut = await run("fez-mine", startArgs);
          if (startOut.code !== 0) throw new Error(startOut.stderr.trim() || `start exited ${startOut.code}`);
        }
        setEditing(false);
        await Promise.all([loadStatus(), loadConfig()]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    };

    return (
      <div style={card}>
        {error ? <p className="ob-error">{error}</p> : null}

        <div className="skill-desc">
          {dot(!!status?.alive)} {persona} · netuid {netuid}
          {status?.uid !== undefined ? ` · uid ${status.uid}` : " · unregistered"}
          {status?.machine?.kind === "lium" && status.machine.podId
            ? ` · pod ${status.machine.podId}${status.machine.hourlyRate ? ` · $${status.machine.hourlyRate}/hr` : ""}`
            : ""}
          {status?.machine?.kind === "lium" && status.machine.externalIp && status.machine.externalPort
            ? ` · ${status.machine.externalIp}:${status.machine.externalPort}`
            : ""}
          {status?.startedAt ? ` · started ${new Date(status.startedAt).toLocaleString()}` : ""}
          {status?.lastExit ? ` · ${status.lastExit}` : ""}
        </div>
        {status?.attention ? (
          <div className="skill-desc" style={{ color: "var(--yellow, #fabd2f)" }}>
            ⚠ {status.attention}
          </div>
        ) : null}
        {metricStrip(metagraph)}
        <div style={{ marginTop: 8 }}>
          <button className="agent-action" disabled={busy} onClick={() => void doStop()}>
            {busy ? "working…" : "Stop"}
          </button>
        </div>

        {Label("logs")}
        <pre
          style={{
            ...dim,
            whiteSpace: "pre-wrap",
            fontFamily: "var(--font-mono, monospace)",
            maxHeight: 220,
            overflowY: "auto",
            margin: 0,
          }}
        >
          {logs || "no logs yet"}
        </pre>

        {Label("config")}
        {editing ? (
          <div>
            {schema.map((f) => ConfigFieldRow(f, values, (key, val) => setValues((prev) => ({ ...prev, [key]: val }))))}
            <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
              <button className="agent-action" disabled={busy} onClick={() => void saveConfig()}>
                {status?.alive ? (busy ? "restarting…" : "Save (restarts miner)") : busy ? "saving…" : "Save"}
              </button>
              <button className="skill-link" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div>
            {schema.length === 0 ? (
              <p style={dim}>no config for this subnet</p>
            ) : (
              schema.map((f) => (
                <div key={f.key} className="skill-desc" style={dim}>
                  {f.label}: {String(config[f.key] ?? "—")}
                </div>
              ))
            )}
            <button className="skill-link" onClick={startEdit}>
              Edit
            </button>
          </div>
        )}
      </div>
    );
  }

  if (typeof api.registerThreadView === "function") {
    api.registerThreadView(
      "mining-miner",
      (rootContent) => parseMinerRoot(rootContent) !== null,
      (props) => <MinerCard {...props} />
    );
  }
}
