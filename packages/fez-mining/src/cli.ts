#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MinerEntry } from "./state.js";
import { fezHome, readState, writeState, upsertMiner } from "./state.js";
import { loadDescriptors } from "./descriptors.js";
import { teardownPod } from "./machine-lium.js";
import { alive, kill, spawnDetached } from "./procs.js";
import { lium, parseJson, priceOf } from "@fezchat/lium/cli";
import { deleteSecret, getSecret, setSecret } from "./secrets.js";
import type { ConfigField } from "@fezchat/extension-api";

type ConfigVal = string | number | boolean;

// Resolve a sibling bin (fez-wallet, fez-mine-run) by ABSOLUTE path under
// ~/.fez/bin when it exists there, not by bare name — the desktop spawns
// this CLI without ~/.fez/bin on PATH, so a bare "fez-wallet" would ENOENT
// the moment the GUI's Mine flow shells out. Falls back to the bare name
// (dev/test, running straight from dist before an install); env override
// wins for both.
const resolveBin = (envVar: string, name: string): string => {
  const override = process.env[envVar];
  if (override) return override;
  const installed = path.join(os.homedir(), ".fez", "bin", name);
  return existsSync(installed) ? installed : name;
};
const WALLET_BIN = resolveBin("FEZ_WALLET_BIN", "fez-wallet");
const MINE_RUN_BIN = resolveBin("FEZ_MINE_RUN_BIN", "fez-mine-run");

interface RegisterResult {
  persona: string;
  netuid: number;
  uid: number;
  hotkey: string;
  txHash?: string;
  burned?: string;
  adopted?: boolean;
}

/** Pure — the part the test pins. */
export function statusRows(miners: MinerEntry[], isAlive: (pid?: number) => boolean) {
  return miners.map((m) => ({ ...m, alive: isAlive(m.pid) }));
}

async function cmdSubnets(json: boolean, refresh: boolean): Promise<void> {
  const home = fezHome();
  let s = await readState(home);
  if (refresh) {
    const { allSubnets } = await import("@fezchat/bittensor/subnets");
    const subnets = await allSubnets();
    const descriptors = await loadDescriptors(home);
    const covered = descriptors.map((d) => d.netuid);
    const requirementsByNetuid: Record<number, { gpu?: string; publicEndpoint?: boolean }> = {};
    for (const d of descriptors) {
      if (d.requirements?.gpu || d.requirements?.publicEndpoint) {
        requirementsByNetuid[d.netuid] = {
          ...(d.requirements.gpu ? { gpu: d.requirements.gpu } : {}),
          ...(d.requirements.publicEndpoint ? { publicEndpoint: true } : {}),
        };
      }
    }
    // The chain fetch above takes multiple seconds; re-read + merge rather
    // than writing the whole (possibly stale) state we read before it, so
    // a stop/runner-exit/sentinel write racing the fetch isn't clobbered
    // (worst case: resurrecting a stopped miner).
    const fresh = await readState(home);
    s = { ...fresh, subnets, covered, requirementsByNetuid };
    await writeState(home, s);
  }
  if (json) console.log(JSON.stringify({ subnets: s.subnets, covered: s.covered, requirementsByNetuid: s.requirementsByNetuid ?? {} }));
  else for (const sn of s.subnets) console.log(`${sn.netuid}\t${sn.name}${s.covered.includes(sn.netuid) ? "\t[covered]" : ""}`);
}

function cmdCost(netuid: number): void {
  // Straight passthrough — fez-wallet already shapes {netuid, rao, tao}.
  process.stdout.write(execFileSync(WALLET_BIN, ["cost", "--netuid", String(netuid), "--json"], { encoding: "utf8" }));
}

async function cmdStart(netuid: number, persona: string, json: boolean, machine?: "lium"): Promise<void> {
  const home = fezHome();
  // Idempotent adopt — this call IS the burn on a real registration; the
  // GUI confirms with the human before ever invoking `fez-mine start`.
  // The bare CLI has no such confirmation step, so disclose the live cost
  // here — to stderr, so --json's stdout stays a clean single object.
  // Typing the command is consent; this line is disclosure, not a prompt.
  try {
    const cost = JSON.parse(
      execFileSync(WALLET_BIN, ["cost", "--netuid", String(netuid), "--json"], { encoding: "utf8" })
    ) as { tao: string };
    console.error(`registration may burn ${cost.tao} tTAO from the treasury (free if already registered)`);
  } catch {
    /* cost-fetch failure never blocks start */
  }
  // For a lium miner, the signing key lives on the pod, not this
  // keychain — export the standalone remote hotkey first and register
  // ITS address (the Task 5 override), not a locally-derived pair's.
  const registerArgs = ["register", persona, "--netuid", String(netuid), "--json"];
  if (machine === "lium") {
    const exported = JSON.parse(
      execFileSync(WALLET_BIN, ["export-hotkey", persona, "--json"], { encoding: "utf8" })
    ) as { ss58Address: string };
    registerArgs.push("--hotkey", exported.ss58Address);
  }
  const r = JSON.parse(execFileSync(WALLET_BIN, registerArgs, { encoding: "utf8" })) as RegisterResult;
  let s = await readState(home);
  // upsertMiner fully replaces the entry, so a restart of an already-lium
  // miner must carry its recorded `machine` (podId included) forward
  // itself — otherwise a live pod goes unreferenced and the runner's
  // reattach path never finds it, provisioning (and paying for) a second
  // one. No podId yet on a genuinely first start — the runner provisions
  // the pod on first spawn and records it back onto this entry.
  const existing = s.miners.find((m) => m.netuid === netuid && m.persona === persona);
  // I3: a plain start (no --machine) on a previously-lium entry clears the
  // `machine` field below with no teardown — the pod it names would
  // otherwise go unreferenced and keep billing. Best-effort tear it down
  // first; never block the start over a `lium` hiccup.
  if (machine !== "lium" && existing?.machine?.kind === "lium" && existing.machine.podId) {
    const orphanPodId = existing.machine.podId;
    try {
      await teardownPod(orphanPodId);
      console.error(`tore down orphaned pod ${orphanPodId} from a prior remote run`);
    } catch {
      console.error(`pod ${orphanPodId} may still be running — \`lium rm\` it`);
    }
  }
  s = upsertMiner(s, {
    netuid, persona, hotkey: r.hotkey, uid: r.uid, desired: "running",
    // The preserve is scoped to a lium→lium restart ONLY — carrying
    // `existing.machine` forward unconditionally (any kind, whenever
    // present) meant a later PLAIN `start` (no --machine) on a
    // previously-remote miner reused the stale lium entry and tried the
    // pod path with no key. A local start intentionally writes NO machine
    // field, clearing any stale lium entry back to local. The sentinel/
    // runner reattach path is unaffected — it reads `machine` straight
    // from state, never through cmdStart.
    ...(machine === "lium"
      ? { machine: existing?.machine?.kind === "lium" ? existing.machine : { kind: "lium" as const } }
      : {}),
  });
  await writeState(home, s);
  const pid = spawnDetached(MINE_RUN_BIN, [String(netuid), persona]);
  s = await readState(home);
  const cur = s.miners.find((m) => m.netuid === netuid && m.persona === persona)!;
  await writeState(home, upsertMiner(s, { ...cur, pid, startedAt: Date.now(), attention: undefined }));
  if (json) console.log(JSON.stringify({ ...r, pid }));
  else console.log(`started ${persona} on netuid ${netuid} (uid ${r.uid}, pid ${pid})`);
}

async function cmdStop(netuid: number, persona: string, json: boolean): Promise<void> {
  const home = fezHome();
  const s = await readState(home);
  const m = s.miners.find((e) => e.netuid === netuid && e.persona === persona);
  if (m?.pid && alive(m.pid)) kill(m.pid);
  if (m) {
    const podId = m.machine?.kind === "lium" ? m.machine.podId : undefined;
    if (podId) {
      try {
        await teardownPod(podId);
      } catch (e) {
        // Best-effort — a pod that's already gone (or a `lium` hiccup)
        // must not block `stop` from recording the desired state.
        console.error(`fez-mine: teardown of pod ${podId} failed: ${(e as Error).message}`);
      }
    }
    // The teardown call above can take a while — re-read rather than write
    // the snapshot taken before it, so a runner write that landed in the
    // meantime (e.g. it just finished recording a fresh provision) isn't
    // clobbered by this stop.
    const fresh = await readState(home);
    const freshEntry = fresh.miners.find((e) => e.netuid === netuid && e.persona === persona);
    if (freshEntry) {
      const machine =
        freshEntry.machine?.kind === "lium" ? { ...freshEntry.machine, podId: undefined } : freshEntry.machine;
      await writeState(home, upsertMiner(fresh, { ...freshEntry, desired: "stopped", pid: undefined, machine }));
    }
  }
  if (json) console.log(JSON.stringify({ netuid, persona, stopped: true }));
  else console.log(`stopped ${persona} on netuid ${netuid}`);
}

async function cmdStatus(json: boolean): Promise<void> {
  const rows = statusRows((await readState(fezHome())).miners, alive);
  if (json) console.log(JSON.stringify(rows));
  else for (const row of rows) console.log(`${row.netuid}:${row.persona}\t${row.desired}\t${row.alive ? "alive" : "dead"}`);
}

/** Pure — the part the test pins. Row shape per lium-cli ls/display.py compact_executor(). */
export function machineNodeRows(rows: Record<string, unknown>[]): { node: string; usdHour: number | null }[] {
  return rows.map((r) => ({ node: String(r.huid ?? r.id ?? r.index ?? ""), usdHour: priceOf(r) }));
}

// Rentable Lium nodes + prices, for the GUI's machine picker. Tolerates a
// missing/unauthed `lium` CLI — a rented-machine flow one flag away from
// "just use local" must never crash the picker over it.
async function cmdMachines(json: boolean): Promise<void> {
  const r = await lium(["ls", "--format", "json"]);
  if (!r.ok) {
    if (json) console.log(JSON.stringify({ error: r.err }));
    else console.error(r.err);
    return;
  }
  const nodes = machineNodeRows(parseJson<Record<string, unknown>[]>(r.out) ?? []);
  if (json) console.log(JSON.stringify(nodes));
  else for (const n of nodes) console.log(`${n.node}\t${n.usdHour !== null ? `$${n.usdHour}/hr` : "?"}`);
}

// The Lium account balance, for the confirm line next to the burn.
// `lium balance --json` (not `--format json`) is the real flag, pinned
// already in fez-lium's mcp.ts (lium_balance) against the installed CLI.
async function cmdBalance(json: boolean): Promise<void> {
  const r = await lium(["balance", "--json"]);
  if (!r.ok) {
    if (json) console.log(JSON.stringify({ error: r.err }));
    else console.error(r.err);
    return;
  }
  const n = Number(parseJson<{ balance_usd?: unknown }>(r.out)?.balance_usd);
  const balanceUsd = Number.isFinite(n) ? n : null;
  if (json) console.log(JSON.stringify({ balanceUsd }));
  else console.log(balanceUsd !== null ? `$${balanceUsd}` : "unknown");
}

/** Pure — the part the test pins. Non-secrets from stored-or-default; secrets never leave the keychain, only whether one is set. */
export function maskConfigView(
  schema: ConfigField[] | undefined,
  stored: Record<string, ConfigVal> | undefined,
  hasSecretFn: (key: string) => boolean
): Record<string, ConfigVal | "set" | "unset"> {
  const out: Record<string, ConfigVal | "set" | "unset"> = {};
  for (const f of schema ?? []) {
    if (f.type === "secret") {
      out[f.key] = hasSecretFn(f.key) ? "set" : "unset";
      continue;
    }
    if (stored && f.key in stored) out[f.key] = stored[f.key];
    else if (f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}

async function findMiner(home: string, netuid: number, persona: string): Promise<MinerEntry | undefined> {
  return (await readState(home)).miners.find((m) => m.netuid === netuid && m.persona === persona);
}

async function cmdConfigGet(netuid: number, persona: string, json: boolean): Promise<void> {
  const home = fezHome();
  const [descriptors, entry] = await Promise.all([loadDescriptors(home), findMiner(home, netuid, persona)]);
  const schema = descriptors.find((d) => d.netuid === netuid)?.config;
  const view = maskConfigView(schema, entry?.config, (k) => getSecret(netuid, persona, k) !== undefined);
  if (json) console.log(JSON.stringify(view));
  else for (const [k, v] of Object.entries(view)) console.log(`${k}\t${v}`);
}

async function cmdConfigSet(netuid: number, persona: string, key: string, value: string, secret: boolean): Promise<void> {
  if (secret) { setSecret(netuid, persona, key, value); return; }
  const home = fezHome();
  const s = await readState(home);
  const entry = s.miners.find((m) => m.netuid === netuid && m.persona === persona);
  if (!entry) throw new Error(`no recorded miner ${netuid}:${persona} — start it once with: fez-mine start`);
  await writeState(home, upsertMiner(s, { ...entry, config: { ...entry.config, [key]: value } }));
}

// No --secret flag here — a caller may not know where a key landed, so this
// clears BOTH possible locations (keychain + state config); whichever one
// actually held it goes away, the other is a no-op.
async function cmdConfigUnset(netuid: number, persona: string, key: string): Promise<void> {
  deleteSecret(netuid, persona, key);
  const home = fezHome();
  const s = await readState(home);
  const entry = s.miners.find((m) => m.netuid === netuid && m.persona === persona);
  if (entry?.config && key in entry.config) {
    const { [key]: _omit, ...rest } = entry.config;
    await writeState(home, upsertMiner(s, { ...entry, config: rest }));
  }
}

// The GUI's New-miner picker needs a subnet's config schema before it can
// render the form — this is that schema, straight off the loaded
// descriptor. `--json` is the only shape (nothing to eyeball here).
async function cmdDescribe(netuid: number): Promise<void> {
  const d = (await loadDescriptors(fezHome())).find((x) => x.netuid === netuid);
  if (!d) throw new Error(`no descriptor for netuid ${netuid}`);
  console.log(JSON.stringify({ netuid: d.netuid, name: d.name, requirements: d.requirements, config: d.config }));
}

// GUI calls this right after posting the #mining root message; the headless
// side reads it back to know where to reply. One-liner upsert.
async function cmdThreadSetRoot(netuid: number, persona: string, root: string): Promise<void> {
  const home = fezHome();
  const s = await readState(home);
  const entry = s.miners.find((m) => m.netuid === netuid && m.persona === persona);
  if (!entry) throw new Error(`no recorded miner ${netuid}:${persona} — start it once with: fez-mine start`);
  await writeState(home, upsertMiner(s, { ...entry, threadRootId: root }));
}

function usage(): never {
  console.error(
    "fez-mine subnets [--refresh] | cost --netuid N | start --netuid N --persona P [--machine lium] | stop --netuid N --persona P | status [--json] | machines [--json] | balance [--json] | " +
      "config get --netuid N --persona P [--json] | config set --netuid N --persona P --key K --value V [--secret] | config unset --netuid N --persona P --key K | " +
      "thread set-root --netuid N --persona P --root <eventId> | describe --netuid N --json"
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const refresh = argv.includes("--refresh");
  const netuidFlag = argv.indexOf("--netuid");
  const netuidValue = netuidFlag >= 0 ? Number(argv[netuidFlag + 1]) : undefined;
  const personaFlag = argv.indexOf("--persona");
  const personaValue = personaFlag >= 0 ? argv[personaFlag + 1] : undefined;
  const machineFlag = argv.indexOf("--machine");
  const machineValue = machineFlag >= 0 ? argv[machineFlag + 1] : undefined;
  if (machineValue !== undefined && machineValue !== "lium") usage();
  const secret = argv.includes("--secret");
  const keyFlag = argv.indexOf("--key");
  const keyValue = keyFlag >= 0 ? argv[keyFlag + 1] : undefined;
  const valueFlag = argv.indexOf("--value");
  const valueValue = valueFlag >= 0 ? argv[valueFlag + 1] : undefined;
  const rootFlag = argv.indexOf("--root");
  const rootValue = rootFlag >= 0 ? argv[rootFlag + 1] : undefined;
  const [cmd, sub] = argv.filter(
    (a, i) =>
      a !== "--json" &&
      a !== "--refresh" &&
      a !== "--secret" &&
      a !== "--netuid" &&
      !(netuidFlag >= 0 && i === netuidFlag + 1) &&
      a !== "--persona" &&
      !(personaFlag >= 0 && i === personaFlag + 1) &&
      a !== "--machine" &&
      !(machineFlag >= 0 && i === machineFlag + 1) &&
      a !== "--key" &&
      !(keyFlag >= 0 && i === keyFlag + 1) &&
      a !== "--value" &&
      !(valueFlag >= 0 && i === valueFlag + 1) &&
      a !== "--root" &&
      !(rootFlag >= 0 && i === rootFlag + 1)
  );

  switch (cmd) {
    case "subnets":
      await cmdSubnets(json, refresh);
      break;
    case "cost":
      if (netuidValue === undefined) usage();
      cmdCost(netuidValue);
      break;
    case "start":
      if (netuidValue === undefined || !personaValue) usage();
      await cmdStart(netuidValue, personaValue, json, machineValue as "lium" | undefined);
      break;
    case "stop":
      if (netuidValue === undefined || !personaValue) usage();
      await cmdStop(netuidValue, personaValue, json);
      break;
    case "status":
      await cmdStatus(json);
      break;
    case "machines":
      await cmdMachines(json);
      break;
    case "balance":
      await cmdBalance(json);
      break;
    case "config":
      if (netuidValue === undefined || !personaValue) usage();
      switch (sub) {
        case "get":
          await cmdConfigGet(netuidValue, personaValue, json);
          break;
        case "set":
          if (!keyValue || !valueValue) usage();
          await cmdConfigSet(netuidValue, personaValue, keyValue, valueValue, secret);
          break;
        case "unset":
          if (!keyValue) usage();
          await cmdConfigUnset(netuidValue, personaValue, keyValue);
          break;
        default:
          usage();
      }
      break;
    case "thread":
      if (sub !== "set-root" || netuidValue === undefined || !personaValue || !rootValue) usage();
      await cmdThreadSetRoot(netuidValue, personaValue, rootValue);
      break;
    case "describe":
      if (netuidValue === undefined) usage();
      await cmdDescribe(netuidValue);
      break;
    default:
      usage();
  }
}

// bin entry — run only when INVOKED, not when imported (tests import
// statusRows from this module). Same realpath-both-sides guard as
// src/run.ts: under the ~/.fez/bin symlink, import.meta.url is the real
// file while argv[1] is the link.
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
const invoked = (() => {
  try {
    return process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : undefined;
  } catch {
    return process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
  }
})();
if (invoked && import.meta.url === invoked) {
  main().then(
    () => process.exit(0), // @polkadot/api's websocket (via allSubnets) keeps the event
    // loop alive otherwise — same fix as fez-wallet/src/cli.ts.
    (e) => {
      console.error(`fez-mine: ${(e as Error).message}`);
      process.exit(1);
    }
  );
}
