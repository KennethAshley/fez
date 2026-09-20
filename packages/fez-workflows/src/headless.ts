import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FezExtensionAPI, ScheduledTaskContext } from "../../fez-extension-api/src/headless.js";
import { KIND_CHANNEL, KIND_OBSERVER_CONTROL } from "../../../src/protocol/kinds.js";
import { loadDefs, usesJudge } from "./defs.js";
import { judgeConfigFromEnv, type Ask } from "./judge.js";
import { askJudge, TYPESAFE_DIRECT_URL } from "../../fez-orchestrator/src/typesafe.js";
import { keychainSecret } from "../../../src/extensions/mcp-servers.js";
import { startWorkflowEngine, type EngineHandle } from "./engine.js";

/**
 * fez-workflows as a background extension — the desktop's always-on
 * worker hosts the engine (engine.ts) AS THE OWNER: no service key to
 * invite or attest, agents already answer the owner's mentions, and it
 * works for every user the moment the app installs the bundled
 * extension and the user enables it. The engine treats its own posts
 * by id, so the owner's other messages still trigger and still approve.
 *
 * The scheduled-task hook is the host's only lifecycle: the first tick
 * (at activation) starts the engine; later ticks are no-ops while it is
 * running and retries if the start failed. Definitions live in
 * ~/.fez/workflows; the judge comes from settings.json `judgeUrl` /
 * `judgeKey` (or FEZ_JUDGE_URL / FEZ_JUDGE_KEY in the worker's env).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function judgeFromSettings(): { url: string; key: string } | undefined {
  const fromEnv = judgeConfigFromEnv(process.env);
  if (fromEnv) return fromEnv;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".fez", "settings.json"), "utf8")) as { judgeUrl?: unknown; judgeKey?: unknown };
    const fromSettings = judgeConfigFromEnv({ FEZ_JUDGE_URL: typeof settings.judgeUrl === "string" ? settings.judgeUrl : undefined,
      FEZ_JUDGE_KEY: typeof settings.judgeKey === "string" ? settings.judgeKey : undefined });
    if (fromSettings) return fromSettings;
  } catch { /* no settings file */ }
  // Bring your own key: the TypeSafe key saved in Settings (keychain) — the same fallback the agent runtime uses.
  const own = keychainSecret("typesafe", "TYPESAFE_API_KEY");
  return own ? { url: TYPESAFE_DIRECT_URL, key: own } : undefined;
}

async function start(ctx: ScheduledTaskContext): Promise<EngineHandle | undefined> {
  const dir = process.env.FEZ_WORKFLOWS_DIR || path.join(os.homedir(), ".fez", "workflows");
  let defs = loadDefs(dir);
  if (defs.length === 0) return undefined;
  const judge = judgeFromSettings();
  const ask: Ask | undefined = judge ? (state, questions) => askJudge(judge.url, judge.key, state, questions, { timeoutMs: 5000 }) : undefined;
  const judged = defs.filter(usesJudge);
  if (judged.length > 0 && !ask) {
    console.warn(`⚠️  workflows ${judged.map((d) => d.name).join(", ")} use judged conditions but no judge is configured (settings.json judgeUrl/judgeKey) — skipping them`);
    defs = defs.filter((d) => !usesJudge(d));
    if (defs.length === 0) return undefined;
  }
  const { nostr } = ctx;
  // The background host's access object carries sendDm beyond the declared
  // interface; a DM carries no depth tag there, and a DM cannot re-trigger a
  // channel workflow anyway.
  const dm = (nostr as { sendDm?: (peer: string, text: string) => Promise<unknown> }).sendDm;
  return startWorkflowEngine({
    nostr: {
      pubkey: nostr.pubkey,
      publish: (tmpl) => nostr.publish(tmpl),
      subscribe: (filters, handler) => nostr.subscribe(filters, handler),
      query: (filters) => nostr.query(filters),
      sendDm: async (to, text) => {
        if (!dm) throw new Error("this host cannot send DMs");
        await dm(to, text);
      },
      // This host IS the owner, so its control frames are the ones agents
      // accept — the standalone service (its own key) offers no `control`.
      control: async (to, frame) => {
        await nostr.publish({ kind: KIND_OBSERVER_CONTROL, tags: [["p", to]], content: nostr.encrypt(to, JSON.stringify(frame)) });
      },
    },
    owner: ctx.ownerPubkey,
    defs,
    ask,
    stateFile: path.join(os.homedir(), ".fez", "workflows-state.json"),
    channelIds: async (spec) => {
      if (UUID_RE.test(spec)) return [spec];
      const wanted = spec.replace(/^#/, "").toLowerCase();
      const ids = (await nostr.query([{ kinds: [KIND_CHANNEL] }]))
        .filter((e) => { try { return String(JSON.parse(e.content).name ?? "").toLowerCase() === wanted; } catch { return false; } })
        .map((e) => e.tags.find((t) => t[0] === "d")?.[1])
        .filter((id): id is string => !!id);
      if (ids.length === 0) console.warn(`⚠️  workflows: no channel named "${spec}"`);
      return ids;
    },
  });
}

export default function activate(api: FezExtensionAPI): void {
  let engine: Promise<EngineHandle | undefined> | undefined;
  let idleLogged = false;
  api.registerScheduledTask("workflows", 60_000, async (ctx) => {
    engine ??= start(ctx).catch((error) => {
      console.warn(`⚠️  workflows failed to start (will retry): ${error instanceof Error ? error.message : error}`);
      engine = undefined;
      return undefined;
    });
    const handle = await engine;
    if (!handle && !idleLogged) {
      idleLogged = true;
      console.log(`   ⏱  workflows: no definitions in ~/.fez/workflows — idle`);
    }
    // No definitions yet: look again next tick so a file dropped in later starts without a restart.
    if (!handle) engine = undefined;
  });
}
