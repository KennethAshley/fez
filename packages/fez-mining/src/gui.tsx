import type { GuiExtensionApi } from "@fezchat/extension-api/gui";
import type { ConfigField } from "@fezchat/extension-api";
import type { MinerEntry, Subnet } from "./state.js";
import { subnetRows, machineChoices, initialFormValues, stackFor, HARDWARE_GATED, RELEASE_FROZEN, type MachineChoice, type ConfigFormValues } from "./gui-rows.js";
import { validateConfig } from "./config.js";
import { MINING_SOURCE, MINING_CHANNEL_NAME, minerRootLine, parseMinerRoot } from "./thread.js";
import { ensureMiningSkill } from "./persona-skill.js";
import { SUBNET_LOGOS } from "./subnet-logos.js";
import { createSubmissionGui } from "./submission-gui.js";
import { createDevelopmentGui } from "./development-gui.js";
import { miningChannel, MINING_WORKSPACE_META, MINING_WORKSPACE_ID, type MiningChannel } from "./workspace.js";

/**
 * The Mining rail entry opens its linked native channel. The host owns
 * Activity; this extension supplies fleet/catalog tabs and one management pane.
 * Older hosts retain the standalone page and inline thread card.
 *
 * Shared host React (`--jsx-factory=h`) keeps the bundle self-contained.
 * Mining actions run through fez-mine; only explicit workspace setup edits
 * channel metadata. Thread creation stays in Node, signed as the persona.
 */
export default function activate(api: GuiExtensionApi): void {
  const h = api.React.createElement;
  const { useState, useEffect, useCallback, useRef } = api.React;
  const { client } = api;
  const hasChannels = !!client && typeof client.ensureChannel === "function";
  const hasWorkspace = hasChannels && typeof client.channelsFrom === "function" && typeof api.openChannel === "function";
  const boundChannel = () => hasWorkspace ? miningChannel(client.channelsFrom()) : undefined;
  const openManagedMiner = (netuid: number, persona: string) => {
    api.openPanel?.(`${persona} · SN${netuid}`, () => <MinerCard channelId={boundChannel()?.id ?? ""} rootId={minerKey(netuid,persona)} rootContent={minerRootLine(netuid,persona)} />);
  };
  async function openThreadFor(netuid: number, persona: string): Promise<void> {
    const channelId = boundChannel()?.id;
    if (!client || !channelId || !api.processes) throw Error("Link a channel from Mining before opening miner history.");
    const relay = client.workspaces().find(w=>w.active)?.relay;
    if (!relay) throw Error("The active workspace relay is unavailable. Reconnect before opening history.");
    const result = await api.processes.run("fez-mine",["thread","ensure","--netuid",String(netuid),"--persona",persona,"--channel",channelId,"--relay",relay,"--json"]);
    if (result.code !== 0) throw Error(result.stderr.trim() || "Could not open miner history");
    const rootId = (JSON.parse(result.stdout) as {rootId?:string}).rootId;
    if (!rootId) throw Error("No miner thread was returned");
    api.openThread(channelId,rootId);
  }
  async function enablePersona(persona: string): Promise<void> {
    if (!api.personas) throw Error("Grant the personas permission to enable mining.");
    const md = await api.personas.read(persona);
    const next = ensureMiningSkill(md);
    if (next === md && !/mcpServers:.*mining/.test(md)) throw Error("This agent needs valid frontmatter before mining can be enabled.");
    if (next !== md) await api.personas.update(persona,next);
    const result = await api.personas.invite?.(persona,"bot");
    if (result === "no-key") api.toast?.(`Mining enabled. Mention @${persona} in the channel to bring the agent online.`,"info");
    else if (result && result !== "invited") throw Error(`Could not invite ${persona}: ${result}`);
  }

  const minerKey = (netuid: number, persona: string) => `${netuid}:${persona}`;

  const card = {
    border: "1px solid var(--hairline, #333)",
    borderRadius: 8,
    padding: 10,
    marginTop: 6,
    background: "var(--bg1, transparent)",
  };
  const dim = { opacity: 0.75, fontSize: 12 };
  const { SubmissionPanel, SubmissionSummary } = createSubmissionGui(api, { card, dim });
  const { DevelopmentPanel } = createDevelopmentGui(api, { card, dim });
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
  const subnetAvatar = (netuid: number, name: string, size = 28): JSX.Element => {
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
          width: size,
          height: size,
          borderRadius: "50%",
          flex: "none",
          overflow: "hidden",
          background: `color-mix(in srgb, ${hue} 20%, var(--bg1, #282828))`,
          color: hue,
          fontWeight: 700,
          fontSize: size * 0.45,
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

  function WorkspaceSetup(): JSX.Element {
    if (!client) throw Error("Mining needs read:channels permission");
    const [channels,setChannels] = useState<MiningChannel[]>(()=>client.channelsFrom());
    const [name,setName] = useState(MINING_CHANNEL_NAME);
    const [busy,setBusy] = useState(false);
    const [error,setError] = useState("");
    useEffect(()=>client.on("channelsChanged",()=>setChannels(client.channelsFrom())),[]);
    const linked = miningChannel(channels);
    const existing = channels.find(c=>c.name.trim().toLowerCase() === name.trim().toLowerCase());
    const bind = async () => {
      if (!name.trim()) return;
      setBusy(true); setError("");
      try {
        const current = client.channelsFrom();
        const already = miningChannel(current);
        if (already) { api.openChannel?.(already.id); return; }
        const match = current.find(c=>c.name.trim().toLowerCase() === name.trim().toLowerCase());
        if (match?.archived) throw Error("This channel is archived. Restore it in channel management or choose another name.");
        if (match?.source && match.source !== MINING_SOURCE) throw Error("This channel belongs to another extension. Choose an ordinary channel.");
        // Retire the old binding before creating a replacement. Restoring an
        // archived channel must not silently move the workspace back to it.
        for (const previous of current.filter(c=>c.meta?.[MINING_WORKSPACE_META]==="true")) {
          await client.ensureChannel({id:previous.id,name:previous.name,source:previous.source,
            visibility:previous.visibility,meta:{...previous.meta,[MINING_WORKSPACE_META]:"false"}});
          if (client.channelsFrom().find(c=>c.id===previous.id)?.meta?.[MINING_WORKSPACE_META]==="true") {
            throw Error("Could not unlink the previous mining channel. Only the workspace owner can change this binding.");
          }
        }
        const id = await client.ensureChannel({
          id:match?.id ?? (current.some(c=>c.id===MINING_WORKSPACE_ID) ? undefined : MINING_WORKSPACE_ID),name:match?.name ?? name.trim(),source:MINING_SOURCE,
          visibility:match?.visibility ?? "open",meta:{...match?.meta,[MINING_WORKSPACE_META]:"true"},
        });
        if (!id || miningChannel(client.channelsFrom())?.id !== id) throw Error("Only the workspace owner can link a mining channel.");
        setChannels(client.channelsFrom());
        api.openChannel?.(id);
      } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
      finally { setBusy(false); }
    };
    return <div style={{padding:24,maxWidth:620,boxSizing:"border-box"}}>
      <h2 style={{margin:"0 0 8px"}}>Mining</h2>
      {linked ? <div><p>Activity, miners and subnets live in #{linked.name}.</p><button className="agent-action" onClick={()=>api.openChannel?.(linked.id)}>Open #{linked.name}</button></div> : <div>
        <p style={{color:"var(--fg-dim)",marginBottom:24}}>Give your mining agents a shared channel. Their updates, conversations and miner history stay together.</p>
        <label style={{display:"block",marginBottom:6}} htmlFor="mining-channel-name">Channel name</label>
        <input id="mining-channel-name" className="manage-input" value={name} onChange={(e:{target:{value:string}})=>setName(e.target.value)} list="mining-channel-options" />
        <datalist id="mining-channel-options">{channels.filter(c=>!c.archived && (!c.source || c.source===MINING_SOURCE)).map(c=><option key={c.id} value={c.name}/>)}</datalist>
        <p className="settings-hint">{existing ? `#${existing.name} already exists. Linking keeps its members and history.` : "Creates one channel. You can rename it later."}</p>
        <button className="agent-action" disabled={busy || !name.trim()} onClick={()=>void bind()}>{busy ? "Linking…" : existing ? "Use this channel" : "Create mining channel"}</button>
      </div>}
      {error ? <p className="ob-error" role="alert">{error}</p> : null}
    </div>;
  }

  function FleetSummary({openTab}:{openTab:(id:string)=>void}): JSX.Element {
    const [rows,setRows] = useState<StatusRow[]>([]);
    useEffect(()=>{
      let cancelled=false;
      const refresh=async()=>{ try {
        const out=await api.processes?.run("fez-mine",["status","--json"]);
        if (!cancelled && out?.code===0) setRows(JSON.parse(out.stdout));
      } catch { /* the fleet tab surfaces detailed failures */ } };
      void refresh(); const timer=setInterval(()=>void refresh(),10000);
      return ()=>{cancelled=true;clearInterval(timer);};
    },[]);
    const active=rows.filter(m=>m.mode==="submission" || m.alive || m.desired==="running").length;
    const attention=rows.filter(m=>m.attention || m.submissionError || (m.desired==="running" && !m.alive && m.mode!=="submission")).length;
    return <div style={{display:"flex",alignItems:"center",flexWrap:"wrap",gap:12}}>
      <button className="skill-link" onClick={()=>openTab("miners")}>{active} active · {rows.length} total miners{attention ? ` · ${attention} need attention` : ""}</button>
      <span style={{flex:1}}/>
      <button className="agent-action" onClick={()=>openTab("subnets")}>New miner</button>
    </div>;
  }

  function MiningPage({section="all"}:{section?:"all"|"miners"|"subnets"}): JSX.Element {
    const run = api.processes?.run;
    const personasApi = api.personas;

    const [subnets, setSubnets] = useState<Subnet[]>([]);
    const [covered, setCovered] = useState<number[]>([]);
    const [submissionNetuids, setSubmissionNetuids] = useState<number[]>([]);
    const [submissionPick, setSubmissionPick] = useState<{ netuid: number; persona: string } | undefined>(undefined);
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
    const [agentPick,setAgentPick] = useState<{netuid:number;submission:boolean;create:boolean;name:string;enabled?:boolean} | undefined>(undefined);
    const launchPersona = useRef("");
    const [machineChoice, setMachineChoice] = useState<MachineChoice>("local");
    // The ssh machine's identity — typed once at the machine step, carried
    // to `start --machine ssh` as flags. Target is user@host[:port].
    const [sshTarget, setSshTarget] = useState("");
    const [sshKeyPath, setSshKeyPath] = useState("");
    const [sshServePort, setSshServePort] = useState("");
    // Whether DO_API_TOKEN is set on the host — the extension can't read
    // process.env itself, so it asks the CLI once on mount (same posture
    // as the machines/balance calls above it).
    const [hasDoToken, setHasDoToken] = useState(false);
    const [subnetFilter, setSubnetFilter] = useState("");
    const [showAllSubnets, setShowAllSubnets] = useState(false);

    const loadCatalog = useCallback(async () => {
      const [s, c, req, submissions] = await Promise.all([
        api.storage.get<Subnet[]>("subnets"),
        api.storage.get<number[]>("covered"),
        api.storage.get<Record<number, { gpu?: string; publicEndpoint?: boolean }>>("requirementsByNetuid"),
        api.storage.get<number[]>("submissionNetuids"),
      ]);
      setSubnets(s ?? []);
      setCovered(c ?? []);
      setRequirementsByNetuid(req ?? {});
      setSubmissionNetuids(submissions ?? []);
    }, []);

    // Merge fresh CLI fields too: submission phase/errors can change in chat.
    const loadMiners = useCallback(async () => {
      const stored = (await api.storage.get<MinerEntry[]>("miners")) ?? [];
      const rows = new Map(stored.map(m => [minerKey(m.netuid, m.persona), { ...m, alive: false }]));
      if (run) {
        try {
          const out = await run("fez-mine", ["status", "--json"]);
          if (out.code !== 0) throw Error(out.stderr.trim() || `status exited ${out.code}`);
          for (const row of JSON.parse(out.stdout) as StatusRow[]) rows.set(minerKey(row.netuid, row.persona), row);
        } catch (err) {
          for (const row of rows.values()) if (row.mode === "submission") row.submissionError = err instanceof Error ? err.message : String(err);
        }
      }
      setMiners([...rows.values()]);
    }, [run]);

    useEffect(() => {
      void loadCatalog();
      void loadMiners();
      if (run) {
        run("fez-mine", ["do-token-status", "--json"])
          .then((out) => {
            if (out.code !== 0) return;
            setHasDoToken((JSON.parse(out.stdout) as { present: boolean }).present);
          })
          .catch(() => {
            // best-effort — DO just stays off the picker
          });
      }
    }, [loadCatalog, loadMiners, run]);

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
      const active = minersRef.current.filter((m) => m.mode !== "submission" && (m.alive || m.desired === "running"));
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
        const catalog = JSON.parse(out.stdout) as { subnets: Subnet[]; covered: number[]; submissionNetuids?: number[]; requirementsByNetuid?: Record<number, { gpu?: string; publicEndpoint?: boolean }> };
        setSubnets(catalog.subnets);
        setCovered(catalog.covered);
        setSubmissionNetuids(catalog.submissionNetuids ?? []);
        setRequirementsByNetuid(catalog.requirementsByNetuid ?? {});
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

          // Capability remains attached so the agent can discuss history and restart later.
          await loadMiners();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(undefined);
        }
      },
      [run, loadMiners, personasApi]
    );

    // Reuse the launch confirmation before any stopped operation can rent again.
    const restart = async (m: MinerRow) => {
      if (m.mode === "submission") return;
      if (m.machine?.kind === "ssh") {
        setSshTarget(`${m.machine.user}@${m.machine.host}${m.machine.port ? `:${m.machine.port}` : ""}`);
        setSshKeyPath(m.machine.keyPath ?? "");
        setSshServePort(m.machine.servePort ? String(m.machine.servePort) : "");
      }
      await startFlow(m.netuid,m.persona,m.machine?.kind ?? "local",[],{});
    };

    const openMinerThread = useCallback(async (m: MinerRow) => {
      setError(undefined);
      try { await openThreadFor(m.netuid,m.persona); }
      catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    },[]);

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
          setPicker({ kind: "persona", netuid, machine, schema, values, persona: launchPersona.current || personas[0] || "" });
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
      async (netuid: number) => {
        if (!personasApi) {
          setError("Mining needs the `personas` permission — reinstall the extension to grant it.");
          return;
        }
        if (personas.length === 0 && !personasApi.create) {
          setError("no personas yet — create one before mining");
          return;
        }
        setError(undefined);
        let submission = submissionNetuids.includes(netuid);
        if (!submission) {
          try {
            if (!run) return;
            const out = await run("fez-mine", ["describe", "--netuid", String(netuid), "--json"]);
            if (out.code !== 0) throw Error(out.stderr.trim() || `describe exited ${out.code}`);
            submission = (JSON.parse(out.stdout) as { mode?: string }).mode === "submission";
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            return;
          }
        }
        if (hasWorkspace) {
          const base = (subnets.find(s=>s.netuid===netuid)?.name ?? `sn${netuid}`).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
          setAgentPick({netuid,submission,create:true,name:`${base || "mining"}-miner`});
          return;
        }
        if (submission) {
          setPicker(undefined);
          setSubmissionPick({ netuid, persona: personas[0] });
          return;
        }
        setSubmissionPick(undefined);
        const req = requirementsByNetuid[netuid];
        if (req) {
          const choices = machineChoices(req, hasDoToken);
          setMachineChoice(choices.find((c) => c.enabled)?.choice ?? "local");
          setPicker({ kind: "machine", netuid });
          return;
        }
        void enterConfigStep(netuid, undefined);
      },
      [personasApi, personas, requirementsByNetuid, enterConfigStep, hasDoToken, submissionNetuids, run]
    );

    const chooseAgent = async () => {
      if (!agentPick || !personasApi) return;
      const persona=agentPick.name.trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(persona)) {setError("Use letters, numbers, hyphens or underscores for the agent name.");return;}
      setBusy("agent");setError(undefined);
      try {
        if (agentPick.create) {
          if ((await personasApi.list()).some(p=>p.toLowerCase()===persona.toLowerCase())) throw Error("That agent already exists. Select Use an existing agent.");
          await personasApi.create(persona,ensureMiningSkill(`---\nharness: pi\nrespondTo: owner\n---\nYou are ${persona}, a specialist managing mining on subnet ${agentPick.netuid}. Use the mining tools to inspect status and explain results. Keep all mining actions on testnet. Ask before spending, registering, uploading or restarting. Never request or print private keys or API secrets. Keep operational updates in the miner thread and respond to mentions or DMs.\n`));
          setPersonas(await personasApi.list());
        }
        if (!agentPick.enabled) {
          await enablePersona(persona);
          if (!agentPick.create) {
            setAgentPick({...agentPick,enabled:true});
            return;
          }
        }
        launchPersona.current=persona;
        const {netuid,submission}=agentPick;
        setAgentPick(undefined);
        if (submission) {setPicker(undefined);setSubmissionPick({netuid,persona});return;}
        setSubmissionPick(undefined);
        const req=requirementsByNetuid[netuid];
        if (req) {
          setMachineChoice(machineChoices(req,hasDoToken).find(c=>c.enabled)?.choice ?? "local");
          setPicker({kind:"machine",netuid});
        } else await enterConfigStep(netuid,undefined);
      } catch (err) {setError(err instanceof Error ? err.message : String(err));}
      finally {setBusy(undefined);}
    };

    const confirmMachine = useCallback(
      (netuid: number, machine: MachineChoice) => {
        if (machine === "ssh" && !sshTarget.trim()) {
          setError("ssh needs a host — user@host or user@host:port");
          return;
        }
        setError(undefined);
        void enterConfigStep(netuid, machine);
      },
      [enterConfigStep, sshTarget]
    );

    const confirmConfig = useCallback(() => {
      if (!picker || picker.kind !== "config") return;
      const missing = validateConfig(picker.schema, picker.values);
      if (missing) {
        setError(`${missing} is missing or invalid`);
        return;
      }
      setError(undefined);
      setPicker({ kind: "persona", netuid: picker.netuid, machine: picker.machine, schema: picker.schema, values: picker.values, persona: launchPersona.current || personas[0] || "" });
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
          const doLine =
            machine === "do"
              ? "\n\nDigitalOcean: fez will create a ~$0.018/hr droplet on your account; stopping the miner destroys it."
              : "";
          setPicker({
            kind: "confirm", netuid, persona, machine, schema, values,
            message: `Register ${persona} on netuid ${netuid}? Burns ~${cost.tao} tTAO — skipped (free) if ${persona} is already registered there.${liumLine}${doLine}`,
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
          if (machine === "ssh") {
            startArgs.push("--machine", "ssh", "--host", sshTarget.trim());
            if (sshKeyPath.trim()) startArgs.push("--ssh-key", sshKeyPath.trim());
            if (sshServePort.trim()) startArgs.push("--serve-port", sshServePort.trim());
          }
          if (machine === "do") {
            startArgs.push("--machine", "do");
            if (sshServePort.trim()) startArgs.push("--serve-port", sshServePort.trim());
          }
          const startOut = await run("fez-mine", startArgs);
          if (startOut.code !== 0) throw new Error(startOut.stderr.trim() || `start exited ${startOut.code}`);

          // Agent setup is explicit and precedes launch on current hosts.
          // Older hosts still attach here after their legacy picker completes.
          if (!hasWorkspace && personasApi) await enablePersona(persona);
          if (hasWorkspace) {
            try { await openThreadFor(netuid,persona); }
            catch (err) { api.toast?.(`Miner started; history could not open: ${err instanceof Error ? err.message : String(err)}`,"error"); }
          }

          setPicker(undefined);
          await loadMiners();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(undefined);
        }
      },
      [run, loadMiners, personasApi, sshTarget, sshKeyPath, sshServePort]
    );

    if (!run) {
      return (
        <p className="settings-hint">
          Mining needs the `processes` permission — reinstall the extension to grant it.
        </p>
      );
    }

    const subnetName = (netuid: number) => subnets.find((s) => s.netuid === netuid)?.name ?? `netuid ${netuid}`;
    // Submissions belong in the fleet without a process or running intent.
    const activeMiners = miners; // Stopped operations retain their management and history.

    // Renders whichever picker step is open, or nothing when it's closed.
    const renderPicker = (): JSX.Element | null => {
      if (!picker) return null;
      const cancel = (): void => setPicker(undefined);

      if (picker.kind === "machine") {
        const req = requirementsByNetuid[picker.netuid];
        return (
          <div style={card}>
            {Label(`machine — ${subnetName(picker.netuid)}`)}
            {machineChoices(req, hasDoToken).map((c) => (
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
            {(machineChoice === "ssh" || machineChoice === "do") && (
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                {machineChoice === "ssh" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <input
                      className="manage-input"
                      value={sshTarget}
                      spellCheck={false}
                      placeholder="root@165.1.2.3 or user@host:2222"
                      onChange={(e) => setSshTarget(e.target.value)}
                    />
                    <input
                      className="manage-input"
                      value={sshKeyPath}
                      spellCheck={false}
                      placeholder="identity file (optional — ssh-agent otherwise)"
                      onChange={(e) => setSshKeyPath(e.target.value)}
                    />
                  </div>
                )}
                <input
                  className="manage-input"
                  value={sshServePort}
                  spellCheck={false}
                  inputMode="numeric"
                  placeholder="serving port (optional — for axon miners; open it in the host's firewall)"
                  onChange={(e) => setSshServePort(e.target.value)}
                />
              </div>
            )}
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
          {!hasWorkspace && personas.length > 1 ? (
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
    const catalogRows = subnetRows(subnets, covered, HARDWARE_GATED, RELEASE_FROZEN);
    const readyRows = catalogRows.filter((r) => r.curated && !r.gated && !r.frozen);
    const statusRank = (r: (typeof catalogRows)[number]): number => (r.curated && !r.gated && !r.frozen ? 0 : r.gated || r.frozen ? 1 : 2);
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
      if (submissionNetuids.includes(netuid)) return "validator-hosted submission";
      const req = requirementsByNetuid[netuid];
      if (req?.gpu) return "needs a GPU";
      if (req?.publicEndpoint) return "public endpoint";
      return "runs locally";
    };

    // The stacking story on a tile: this subnet's badge with its component
    // subnets' badges overlapped behind it (Gradients ⟵ Lium; Bazaar ⟵
    // Chutes), plus a plain line naming what each component contributes.
    // The subnet's badge with its component subnets as SMALL satellites at
    // the bottom-right corner — the main subnet is the thing you mine, the
    // component is supporting infrastructure and reads subordinate.
    const stackCluster = (netuid: number, name: string): JSX.Element => {
      const comps = submissionNetuids.includes(netuid) ? [] : stackFor(netuid, requirementsByNetuid[netuid]);
      return (
        <span style={{ position: "relative", display: "inline-flex", flex: "none" }}>
          {subnetAvatar(netuid, name)}
          {comps.map((c, i) => (
            <span
              key={c}
              title={`mined with ${subnetName(c)}`}
              style={{
                position: "absolute",
                right: -4 - i * 12,
                bottom: -4,
                display: "inline-flex",
                borderRadius: "50%",
                boxShadow: "0 0 0 2px var(--bg0, #1d2021)",
              }}
            >
              {subnetAvatar(c, subnetName(c), 15)}
            </span>
          ))}
        </span>
      );
    };
    const stackLine = (netuid: number): string => {
      const comps = submissionNetuids.includes(netuid) ? [] : stackFor(netuid, requirementsByNetuid[netuid]);
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
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, padding: section === "all" ? "4px 24px 0" : 0 }}>
        {error ? <p className="ob-error">{error}</p> : null}

        <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", paddingTop: 8, paddingBottom: 28 }}>
          {section !== "subnets" ? <div>{Label("your miners")}
          {activeMiners.length === 0 ? (
            <p style={dim}>No miners yet. Open Subnets to launch your first miner.</p>
          ) : (
            activeMiners.map((m) => {
              const k = minerKey(m.netuid, m.persona);
              if (m.mode === "submission") return (
                <div key={k} className="skill-row" style={{ alignItems: "center" }}>
                  {subnetAvatar(m.netuid, subnetName(m.netuid))}
                  <div className="skill-main">
                    <span className="skill-name">{m.persona} · {subnetName(m.netuid)}</span>
                    <SubmissionSummary status={m.submission} error={m.submissionError} />
                  </div>
                  <div className="skill-actions">
                    {hasWorkspace ? <button className="skill-link" onClick={()=>void openMinerThread(m)}>History</button> : null}
                    <button className="agent-action" onClick={() => { if (api.openPanel) openManagedMiner(m.netuid,m.persona); else {setPicker(undefined);setSubmissionPick({netuid:m.netuid,persona:m.persona});} }}>Manage</button>
                  </div>
                </div>
              );
              return (
                <div
                  key={k}
                  className="skill-row"
                  style={{ cursor: hasChannels ? "pointer" : undefined, alignItems: "center" }}
                >
                  {stackCluster(m.netuid, subnetName(m.netuid))}
                  <div className="skill-main">
                    <span className="skill-name">
                      {dot(m.alive)} {m.persona} · {subnetName(m.netuid)}
                    </span>
                    <div className="skill-desc" style={{ ...dim, ...mono }}>
                      {m.uid !== undefined ? `uid ${m.uid}` : "unregistered"}
                      {m.machine?.kind === "lium" && m.machine.podId
                        ? ` · pod ${m.machine.podId}${m.machine.hourlyRate ? ` · $${m.machine.hourlyRate}/hr` : ""}`
                        : m.machine?.kind === "ssh"
                          ? ` · ssh ${m.machine.user}@${m.machine.host}${m.machine.port ? `:${m.machine.port}` : ""}`
                          : m.machine?.kind === "do"
                            ? ` · DO droplet${m.machine.dropletId ? ` ${m.machine.dropletId}` : ""} · ~$0.018/hr${m.machine.host ? ` · ${m.machine.host}` : ""}`
                            : " · local"}
                      {m.machine?.kind === "lium" && m.machine.externalIp && m.machine.externalPort
                        ? ` · ${m.machine.externalIp}:${m.machine.externalPort}`
                        : m.machine?.kind === "ssh" && m.machine.servePort
                          ? ` · serving :${m.machine.servePort}`
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
                      <div className="skill-desc" style={{ color: m.desired === "stopped" ? "var(--fg-dim)" : "var(--red, #fb4934)", marginTop: 4 }}>
                        {/* absent machine = local (v1 shape) — remote kinds all have a reachable endpoint */}
                        {m.desired === "stopped" ? `Stopped${m.lastExit ? ` — ${m.lastExit}` : ""}. History and settings are retained.` : requirementsByNetuid[m.netuid]?.publicEndpoint && !m.machine
                          ? `Not running — ${subnetName(m.netuid)} needs a reachable endpoint a local Mac can't provide. Restart on a Lium pod or your own server, or open the thread for logs.`
                          : `Not running${m.lastExit ? ` — ${m.lastExit}` : ""}. Restart, or open the thread for logs.`}
                      </div>
                    )}
                  </div>
                  <div className="skill-actions">
                    {hasWorkspace ? <button className="skill-link" onClick={()=>void openMinerThread(m)}>History</button> : null}
                    {api.openPanel ? <button className="agent-action" onClick={()=>openManagedMiner(m.netuid,m.persona)}>Manage</button> : null}
                    {!m.alive ? (
                      <button
                        className="agent-action"
                        disabled={busy === k}
                        onClick={(e: { stopPropagation: () => void }) => {
                          e.stopPropagation();
                          void restart(m);
                        }}
                      >
                        {busy === k ? "working…" : m.desired === "stopped" ? "Start" : "Restart"}
                      </button>
                    ) : null}
                    <button
                      className="agent-action"
                      disabled={busy === k || (!m.alive && m.desired === "stopped")}
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

          {section === "miners" && picker ? renderPicker() : null}
          </div> : null}

          {section !== "miners" ? <div>{agentPick ? <div style={{...card,padding:20}}>
            <h3 style={{marginTop:0}}>Choose an agent · SN{agentPick.netuid}</h3>
            {agentPick.enabled ? <div role="status">
              <p>Mining tools saved for @{agentPick.name}.</p>
              <p>If this agent is already running, open its profile and select <strong>restart</strong> to load the tools. Wait for its current conversation to finish first. Restarting the chat agent leaves its miners running.</p>
              <p style={dim}>An agent that is asleep will load the tools when you next mention it.</p>
            </div> : <div>
            <p style={dim}>A dedicated specialist keeps this operation, strategy and wallet identity separate. You can also use an existing agent.</p>
            <label style={{display:"block",marginBottom:8}}><input type="radio" name="mining-agent-kind" checked={agentPick.create} onChange={()=>setAgentPick({...agentPick,create:true,name:`sn${agentPick.netuid}-miner`})}/> Create a specialist</label>
            <label style={{display:"block",marginBottom:12}}><input type="radio" name="mining-agent-kind" checked={!agentPick.create} onChange={()=>setAgentPick({...agentPick,create:false,name:personas[0] ?? ""})}/> Use an existing agent</label>
            {agentPick.create ? <input aria-label="Specialist name" className="manage-input" value={agentPick.name} onChange={(e:{target:{value:string}})=>setAgentPick({...agentPick,name:e.target.value})}/> :
              <select aria-label="Mining agent" className="manage-input" value={agentPick.name} onChange={(e:{target:{value:string}})=>setAgentPick({...agentPick,name:e.target.value})}>{personas.map(p=><option key={p} value={p}>{p}</option>)}</select>}
            <p style={dim}>{agentPick.create ? "Uses Fez's default Pi brain. Configure its provider in the agent profile if needed." : "Enables mining tools so this agent can help with setup and retained history."}</p>
            </div>}
            <div style={{display:"flex",gap:12,marginTop:16}}><button className="agent-action" disabled={busy==="agent" || !agentPick.name} onClick={()=>void chooseAgent()}>{busy==="agent" ? "Enabling…" : agentPick.enabled ? "Continue to miner setup" : "Enable mining & continue"}</button><button className="skill-link" onClick={()=>setAgentPick(undefined)}>Cancel</button></div>
          </div> : submissionPick ? (
            <SubmissionPanel key={minerKey(submissionPick.netuid, submissionPick.persona)} {...submissionPick} personas={personas}
              entry={miners.find(m => m.netuid === submissionPick.netuid && m.persona === submissionPick.persona)}
              onPersonaChange={persona => setSubmissionPick({ netuid: submissionPick.netuid, persona })}
              onClose={() => setSubmissionPick(undefined)} onChange={loadMiners} />
          ) : picker ? (
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
                  const mineable = r.curated && !r.gated && !r.frozen;
                  return (
                    <div
                      key={r.netuid}
                      style={{ ...subnetRowStyle, cursor: mineable ? "pointer" : undefined }}
                      title={mineable ? `Launch a miner on ${r.name}` : r.description}
                      onClick={mineable ? () => selectSubnet(r.netuid) : undefined}
                    >
                      {stackCluster(r.netuid, r.name)}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="skill-name" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.name}
                        </div>
                        <div style={{ ...dim, ...mono, fontSize: 11.5 }}>SN{r.netuid}</div>
                      </div>
                      {mineable ? (
                        <span style={{ color: "var(--green, #b8bb26)", flex: "none" }}>● Mineable</span>
                      ) : r.frozen ? (
                        <span style={{ color: "var(--yellow, #fabd2f)", flex: "none" }}>◐ Coming soon</span>
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
          )}</div> : null}
        </div>
      </div>
    );
  }

  api.registerNavView("mining", { glyph: "⛏", label: "Mining", ...(hasWorkspace ? {channelWorkspace:{
    getChannelId:()=>boundChannel()?.id,
    tabs:[{id:"miners",label:"Miners",render:()=> <MiningPage section="miners"/>},{id:"subnets",label:"Subnets",render:()=> <MiningPage section="subnets"/>}],
    summary:({openTab}:{openTab:(id:string)=>void})=> <FleetSummary openTab={openTab}/>,
  }} : {}) }, () => hasWorkspace ? <WorkspaceSetup/> : <MiningPage />);

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
    const parsed = parseMinerRoot(props.rootContent);
    const netuid = parsed?.netuid;
    const persona = parsed?.persona;
    const [entry, setEntry] = useState<MinerEntry | undefined>(undefined);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const [retry, setRetry] = useState(0);
    useEffect(() => {
      let cancelled = false;
      setLoaded(false);
      setEntry(undefined);
      setError(undefined);
      if (netuid === undefined || !persona || !api.processes) return;
      void (async () => {
        try {
          const stored = (await api.storage.get<MinerEntry[]>("miners"))?.find(m => m.netuid === netuid && m.persona === persona);
          if (!cancelled && stored?.mode === "submission") setEntry(stored);
          const out = await api.processes!.run("fez-mine", ["status", "--json"]);
          if (out.code !== 0) throw Error(out.stderr.trim() || `status exited ${out.code}`);
          const current = (JSON.parse(out.stdout) as StatusRow[]).find(m => m.netuid === netuid && m.persona === persona);
          if (!cancelled) { setEntry(current ?? stored); setLoaded(true); }
        } catch (err) { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); }
      })();
      return () => { cancelled = true; };
    }, [netuid, persona, retry]);
    if (!parsed) return null;
    if (!api.processes) return <p className="settings-hint">Mining needs the processes permission.</p>;
    if (entry?.mode === "submission") return <SubmissionPanel key={minerKey(parsed.netuid, parsed.persona)} {...parsed} entry={entry} />;
    if (error) return <div style={card}><p className="ob-error" role="alert">{error}</p><button className="agent-action" onClick={() => setRetry(n => n + 1)}>Retry</button></div>;
    if (!loaded) return <p className="settings-hint">Loading miner status…</p>;
    return <ProcessMinerCard key={minerKey(parsed.netuid, parsed.persona)} {...props} />;
  }

  function ProcessMinerCard(props: { channelId: string; rootId: string; rootContent: string }): JSX.Element | null {
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
        setError(`${missing} is missing or invalid`);
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
          if (status?.machine?.kind === "ssh") startArgs.push("--machine", "ssh");
          if (status?.machine?.kind === "do") startArgs.push("--machine", "do");
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
            : status?.machine?.kind === "ssh"
              ? ` · ssh ${status.machine.user}@${status.machine.host}${status.machine.port ? `:${status.machine.port}` : ""}`
              : status?.machine?.kind === "do"
                ? ` · DO droplet${status.machine.dropletId ? ` ${status.machine.dropletId}` : ""} · ~$0.018/hr${status.machine.host ? ` · ${status.machine.host}` : ""}`
                : ""}
          {status?.machine?.kind === "lium" && status.machine.externalIp && status.machine.externalPort
            ? ` · ${status.machine.externalIp}:${status.machine.externalPort}`
            : status?.machine?.kind === "ssh" && status.machine.servePort
              ? ` · serving :${status.machine.servePort}`
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

        <DevelopmentPanel key={`${netuid}:${persona}`} netuid={netuid} persona={persona} />
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
      (props) => api.openPanel ? <div style={{...card,display:"flex",alignItems:"center",gap:12,padding:16}}>
        <span style={{flex:1}}>Miner settings, logs and status</span>
        <button className="agent-action" onClick={()=>{ const p=parseMinerRoot(props.rootContent);if(p) openManagedMiner(p.netuid,p.persona);}}>Manage miner</button>
      </div> : <MinerCard key={props.rootId} {...props} />
    );
  }
}
