import { invoke } from "@tauri-apps/api/core";
import { SummonEngine, type SummonHost, type SummonEvent } from "../../../src/agent/summon.js";
import type { Wire } from "@fezchat/client";
// NIP-59 wraps carry FUZZED timestamps — subscribing from "now" misses
// live wraps back-dated by the fuzz. Leaf module only (wire.ts's nip11
// import is the precedent) — never the root src/index.js, which would
// drag the node-flavored CLI graph into the webview bundle.
import { DM_FUZZ_WINDOW_S } from "../../../src/protocol/dm.js";

/** Desktop-owned summons share policy with the optional headless sentinel.
 * Native startup claims local ownership before this host subscribes. */

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
  let disposed = false;
  let stop: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastError: string | undefined;
  // Reconcile extension changes and worker exits without overlapping starts.
  // Hiding the native window leaves this subscription mounted.
  const reconcile = async () => {
    try {
      await invoke<{ background: boolean; restored: number }>("start_desktop_runtime", {
        owner: opts.ownerPubkey, relays: opts.relays.join(","),
      });
      if (disposed) return;
      stop ??= subscribeSummoner(opts);
      lastError = undefined;
    } catch (err) {
      if (disposed) return;
      const message = err instanceof Error ? err.message : String(err);
      if (message !== lastError) opts.toast(`Local agents and integrations couldn't start: ${message}. Retrying in 30 seconds.`);
      lastError = message;
    } finally {
      if (!disposed) timer = setTimeout(() => void reconcile(), 30_000);
    }
  };
  void reconcile();
  return () => {
    disposed = true;
    clearTimeout(timer);
    stop?.();
  };
}

function subscribeSummoner({ wire, ownerPubkey, relays, toast }: Parameters<typeof startSummoner>[0]): () => void {
  // Courtesy half of single ownership (the agent's boot-time yield is
  // the guard): a persona whose key beat presence within the TTL is
  // alive SOMEWHERE — don't spawn a duplicate for it. Advisory only;
  // racing spawners are settled by the agents themselves.
  const KIND_PRESENCE = 20001;
  const PRESENCE_TTL_MS = 90_000;
  const lastBeat = new Map<string, number>();
  const offPresence = wire.subscribe([{ kinds: [KIND_PRESENCE] }], (ev) => {
    lastBeat.set(ev.pubkey, Date.now());
  });

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
    // Only the public key crosses the bridge. A first spawn mints its
    // key CLI-side; the announcement retries resolution once it exists.
    personaPubkey: (name) => invoke<string>("get_pubkey", { account: `agent:${name}` }).catch(() => undefined),
    agentAlive: async (name) => {
      if (await invoke<boolean>("agent_alive", { persona: name, bin: "fez-agent" }).catch(() => false)) return true;
      const pk = await host.personaPubkey(name).catch(() => undefined);
      return !!pk && Date.now() - (lastBeat.get(pk) ?? 0) < PRESENCE_TTL_MS;
    },
    registryEntry: async (name) => {
      const rows = await invoke<{ persona: string; bin?: string; channels: string[]; repo?: string; line?: string }[]>("spawned_agents").catch(() => []);
      const row = rows.find((r) => r.persona === name && (r.bin ?? "fez-agent") === "fez-agent");
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
      try {
        await invoke("spawn_agent", {
          persona,
          channels,
          owner: ownerPubkey,
          relays: relays.join(","),
          repo: work?.repo ?? null,
          baseBranch: work?.line ?? null,
          manual: true,
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
    offPresence();
  };
}
