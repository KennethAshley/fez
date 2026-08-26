import { invoke } from "@tauri-apps/api/core";
import { SummonEngine, type SummonHost, type SummonEvent } from "../../../src/agent/summon.js";
import type { Wire } from "@fezchat/client";
// NIP-59 wraps carry FUZZED timestamps — subscribing from "now" misses
// live wraps back-dated by the fuzz. Leaf module only (wire.ts's nip11
// import is the precedent) — never the root src/index.js, which would
// drag the node-flavored CLI graph into the webview bundle.
import { DM_FUZZ_WINDOW_S } from "../../../src/protocol/dm.js";

/**
 * The desktop's half of workstream 1 (de-sentinel spec): summon agents
 * from the app's own live subscription while it is open. Policy lives
 * in the shared SummonEngine; this file is the host — Tauri spawn
 * mechanics, wire queries, and the one-summoner-per-machine gate.
 *
 * Gate: if a sentinel is alive (~/.fez/sentinel.pid), the desktop
 * defers ENTIRELY — the sentinel is the machine's summoner. Checked
 * per event with a 10s cache (the sentinel may start/stop while the
 * app is open).
 */

const KIND_MESSAGE = 47103;
const KIND_DOC_COMMENT = 40101;
const KIND_METADATA = 47000;
const KIND_GIFT_WRAP = 1059;

export function startSummoner(opts: {
  wire: Wire;
  ownerPubkey: string;
  relays: string[];
  toast: (msg: string) => void;
}): () => void {
  const { wire, ownerPubkey, relays, toast } = opts;

  let sentinelCheck: { verdict: boolean; at: number } = { verdict: false, at: 0 };
  async function sentinelAlive(): Promise<boolean> {
    if (Date.now() - sentinelCheck.at < 10_000) return sentinelCheck.verdict;
    const verdict = await invoke<boolean>("runner_status").catch(() => false);
    sentinelCheck = { verdict, at: Date.now() };
    return verdict;
  }

  const host: SummonHost = {
    ownerPubkey,
    personaExists: async (name) => {
      // Mirror the sentinel's rule (fez-sentinel/src/index.ts:160-168):
      // the persona file must exist AND its harness must not be "router".
      if (!(await invoke<string[]>("list_personas").catch(() => [] as string[])).includes(name)) return false;
      const raw = await invoke<string>("read_persona", { name }).catch(() => "");
      const harness = raw.match(/^harness:\s*(.+)$/m)?.[1]?.trim();
      return harness !== undefined && harness !== "router";
    },
    personaPubkey: async (name) => {
      // Agent keys are minted CLI/sentinel-side; the desktop can't read
      // the keychain for them, so pre-invite resolves via the announced
      // roster instead. An unannounced brand-new persona summons fine —
      // its announce-time invite (engine.handleAnnouncement) covers it.
      const events = await wire.query([{ kinds: [KIND_METADATA], limit: 200 }]);
      for (const ev of events) {
        try {
          if (JSON.parse(ev.content).name?.toLowerCase() === name) return ev.pubkey;
        } catch { /* ignore */ }
      }
      return undefined;
    },
    agentAlive: (name) => invoke<boolean>("agent_alive", { persona: name }).catch(() => false),
    registryEntry: async (name) => {
      const rows = await invoke<{ persona: string; channels: string[]; repo?: string; line?: string }[]>("spawned_agents").catch(() => []);
      const row = rows.find((r) => r.persona === name);
      return row ? { channels: row.channels, work: row.repo ? { repo: row.repo, line: row.line } : undefined } : undefined;
    },
    spawn: async (persona, channels, work) => {
      try {
        await invoke("spawn_agent", {
          persona,
          channels,
          owner: ownerPubkey,
          relays: relays.join(","),
          repo: work?.repo ?? null,
          baseBranch: work?.line ?? null,
        });
      } catch (err) {
        // The invoke rejection (e.g. "fez-agent isn't bundled in this
        // build") otherwise vanished into the engine's own log() call,
        // which had no host.log wired up to print it anywhere the user
        // could see — a summon just silently did nothing. Toast it, then
        // re-throw so the engine's own catch/log/cooldown still runs.
        const message = err instanceof Error ? err.message : String(err);
        toast(`@${persona} couldn't start: ${message}`);
        throw err;
      }
    },
    restart: async (persona, channels, work) => {
      await invoke("kill_agent", { persona }).catch(() => {});
      try {
        await invoke("spawn_agent", {
          persona,
          channels,
          owner: ownerPubkey,
          relays: relays.join(","),
          repo: work?.repo ?? null,
          baseBranch: work?.line ?? null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast(`@${persona} couldn't start: ${message}`);
        throw err;
      }
    },
    query: (filters) => wire.query(filters as never) as Promise<SummonEvent[]>,
    publish: async (template) => {
      await wire.publish(template as never);
    },
    announceTimeout: (persona) => {
      toast(`@${persona} failed to start — its process died before announcing (see ~/.fez/logs/${persona}.log)`);
    },
    log: (line) => console.log(line),
  };

  const engine = new SummonEngine(host);
  void engine.seedRosters();

  const sessionStartS = Math.floor(Date.now() / 1000);
  let dmWatchLive = false;
  const dmTimer = setTimeout(() => { dmWatchLive = true; }, 5000);

  const unsub = wire.subscribe(
    [
      { kinds: [KIND_MESSAGE], since: sessionStartS },
      { kinds: [KIND_DOC_COMMENT], since: sessionStartS },
      { kinds: [KIND_METADATA], since: sessionStartS },
      // NIP-59 wraps carry FUZZED timestamps — subscribing from "now"
      // misses live wraps back-dated by the fuzz. Same widening the
      // sentinel applies.
      { kinds: [KIND_GIFT_WRAP], since: sessionStartS - DM_FUZZ_WINDOW_S },
    ],
    (event) => {
      void (async () => {
        if (await sentinelAlive()) return; // the sentinel is the summoner
        if (event.kind === KIND_GIFT_WRAP) {
          if (!dmWatchLive) return;
          const recipient = event.tags.find((t: string[]) => t[0] === "p")?.[1];
          if (recipient && recipient !== ownerPubkey) await engine.handleGiftWrapRecipient(recipient);
          return;
        }
        await engine.handleEvent(event as SummonEvent);
      })();
    }
  );

  return () => {
    clearTimeout(dmTimer);
    unsub();
  };
}
