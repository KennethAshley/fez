# @fezchat/elevenlabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An ElevenLabs TTS provider extension: any granted agent calls `fez_speak(channel, text)` and a playable voice message appears in the channel, spoken in that agent's stable voice.

**Architecture:** A two-part fez extension. The **skill** is a stdio MCP server (fez-memory skeleton: agent key from `FEZ_AGENT_PERSONA`, `RelayConnection`) whose one tool calls the ElevenLabs TTS API, uploads the mp3 via the existing Blossom path, and publishes a kind-47103 channel message with a NIP-92 `imeta` tag — byte-shaped like a composer upload so shipped playback renders it. The **gui** is a settings panel (wallet's element-returning pattern) mapping agents to voices via the prefs seam. Voice defaults are deterministic: agent pk hashed into a pinned stock-voice list.

**Tech Stack:** TypeScript, esbuild, vitest, `@modelcontextprotocol/sdk`, `@fezchat/protocol` (file:../..), `@fezchat/media` (Blossom), zod.

**Spec:** `docs/superpowers/specs/2026-08-30-elevenlabs-extension-design.md`

## Global Constraints

- Package name `@fezchat/elevenlabs`, directory `packages/fez-elevenlabs`, `"private": true` (publish-batch strips it later).
- Tool name is exactly `fez_speak` — provider-neutral, per spec.
- `text` cap: 2,500 chars. Over the cap → error told to the agent, never truncation.
- Every failure path returns the real error text to the agent (no claimed success).
- `ELEVENLABS_API_KEY` only ever read from the skill process env. The gui part must never see or need it.
- The published message must carry `["h", channelId]` and an `imeta` tag shaped `["imeta", "url <u>", "m audio/mpeg", "size <n>"]` on kind 47103 — identical to the composer's attach shape.
- Follow repo commit style: lowercase subject, no co-author trailers.
- All work happens in the worktree `~/Projects/fez-elevenlabs` on branch `elevenlabs-extension`.

---

### Task 1: Package scaffold + deterministic voice picking

**Files:**
- Create: `packages/fez-elevenlabs/package.json`
- Create: `packages/fez-elevenlabs/tsconfig.json`
- Create: `packages/fez-elevenlabs/src/voices.ts`
- Test: `packages/fez-elevenlabs/tests/voices.test.ts`

**Interfaces:**
- Produces: `PINNED: { id: string; name: string; previewUrl?: string }[]` and `voiceFor(pk: string, overrides?: Record<string, string>, personaName?: string): { id: string; name: string }` — Task 2 (mcp) and Task 3 (gui) both consume these exact names.

- [ ] **Step 1: Write package.json** (wallet's manifest shape, trimmed):

```json
{
  "name": "@fezchat/elevenlabs",
  "version": "0.1.0",
  "private": true,
  "description": "Agents speak — ElevenLabs TTS as a fez skill. fez_speak(channel, text) posts a voice note in the agent's own stable voice.",
  "type": "module",
  "fez": {
    "type": "extension",
    "parts": {
      "skill": { "command": "node", "args": ["dist/mcp.js"] },
      "gui": "dist/gui.js"
    },
    "permissions": ["network:api.elevenlabs.io", "network:relay", "publish", "read:channels", "ui"],
    "minFezVersion": "0.2.0"
  },
  "scripts": {
    "build": "esbuild src/mcp.ts --bundle --format=esm --platform=node --banner:js=\"import{createRequire as ___cr}from'module';const require=___cr(import.meta.url);\" --outdir=dist && esbuild src/gui.ts --bundle --format=iife --global-name=__fezExt --platform=browser --outfile=dist/gui.js",
    "check": "tsc --noEmit",
    "test": "vitest --run"
  },
  "dependencies": {
    "@fezchat/protocol": "file:../..",
    "@fezchat/media": "file:../fez-media",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "nostr-tools": "^2.10.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@fezchat/extension-api": "file:../fez-extension-api",
    "esbuild": "^0.21.5",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "files": ["dist"]
}
```

- [ ] **Step 2: Write tsconfig.json** (copy `packages/fez-memory/tsconfig.json` verbatim — same module/target settings as every sibling extension).

- [ ] **Step 3: Write the failing test** `tests/voices.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PINNED, voiceFor } from "../src/voices.js";

describe("voiceFor", () => {
  const pk = "b7f0b1f5dc205d8c5ab07db0c7e61c20957d845c52bf21ee377469747430792f";

  it("is deterministic for a pk", () => {
    expect(voiceFor(pk)).toEqual(voiceFor(pk));
  });

  it("always lands inside the pinned list", () => {
    for (let i = 0; i < 64; i++) {
      const fake = i.toString(16).padStart(2, "0").repeat(32);
      expect(PINNED.some((v) => v.id === voiceFor(fake).id)).toBe(true);
    }
  });

  it("different pks spread across voices", () => {
    const picks = new Set(
      Array.from({ length: 40 }, (_, i) => voiceFor(i.toString(16).padStart(2, "0").repeat(32)).id)
    );
    expect(picks.size).toBeGreaterThan(1);
  });

  it("a prefs override wins, keyed by persona name", () => {
    const override = PINNED[PINNED.length - 1];
    expect(voiceFor(pk, { quill: override.id }, "quill").id).toBe(override.id);
  });

  it("an override naming an unknown voice id falls back to the deterministic pick", () => {
    expect(voiceFor(pk, { quill: "not-a-voice" }, "quill")).toEqual(voiceFor(pk));
  });
});
```

- [ ] **Step 4: Run it to make sure it fails**

Run: `cd ~/Projects/fez-elevenlabs/packages/fez-elevenlabs && npm install && npx vitest --run`
Expected: FAIL — cannot resolve `../src/voices.js`.

- [ ] **Step 5: Implement `src/voices.ts`**

```ts
/**
 * The sprite trick, for sound: the agent's pk hashes into a pinned list
 * of ElevenLabs stock voices, so @quill sounds like @quill on every
 * machine with zero configuration. The list is PINNED ids, not a live
 * API listing — deterministic defaults must not drift when ElevenLabs
 * reshuffles their catalog. previewUrl is optional; the gui hides the
 * play button when it is absent.
 */
export interface PinnedVoice {
  id: string;
  name: string;
  previewUrl?: string;
}

// Premade ElevenLabs voices (ids are stable public catalog ids).
// Verified against GET /v1/voices at implementation time — if any id is
// gone, replace it here rather than filtering at runtime.
export const PINNED: PinnedVoice[] = [
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel" },
  { id: "29vD33N1CtxCmqQRPOHJ", name: "Drew" },
  { id: "2EiwWnXFnvU5JabPnv8n", name: "Clyde" },
  { id: "5Q0t7uMcjvnagumLfvZi", name: "Paul" },
  { id: "AZnzlk1XvdvUeBnXmlld", name: "Domi" },
  { id: "CYw3kZ02Hs0563khs1Fj", name: "Dave" },
  { id: "D38z5RcWu1voky8WS1ja", name: "Fin" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah" },
  { id: "ErXwobaYiN019PkySvjV", name: "Antoni" },
  { id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh" },
];

/** Stable small hash — no crypto needed, spread is all that matters. */
function hash(pk: string): number {
  let h = 0;
  for (let i = 0; i < pk.length; i++) h = (h * 31 + pk.charCodeAt(i)) >>> 0;
  return h;
}

export function voiceFor(
  pk: string,
  overrides?: Record<string, string>,
  personaName?: string
): PinnedVoice {
  const wanted = personaName ? overrides?.[personaName] : undefined;
  const pinned = wanted && PINNED.find((v) => v.id === wanted);
  if (pinned) return pinned;
  return PINNED[hash(pk) % PINNED.length];
}
```

- [ ] **Step 6: Run the tests and make sure they pass**

Run: `npx vitest --run` — Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck and commit**

```bash
npx tsc --noEmit
git add packages/fez-elevenlabs
git commit -m "elevenlabs: scaffold + deterministic per-agent voice pick"
```

---

### Task 2: The skill — `fez_speak`

**Files:**
- Create: `packages/fez-elevenlabs/src/mcp.ts`
- Create: `packages/fez-elevenlabs/src/speak.ts` (pure helpers, testable)
- Test: `packages/fez-elevenlabs/tests/speak.test.ts`

**Interfaces:**
- Consumes: `voiceFor`, `PINNED` from `src/voices.ts` (Task 1); `uploadToBlossom(server, bytes, mime, sign)` from `@fezchat/media/dist/blossom.js` (esbuild bundles it into dist/mcp.js — no runtime dep).
- Produces: `checkText(text: string): string | undefined` (error or undefined), `imetaFor(url: string, size: number): string[]`, `readVoicePrefs(): Record<string, string>` in `src/speak.ts`; the running tool `fez_speak(channel, text)`.

- [ ] **Step 1: Write the failing test** `tests/speak.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { checkText, imetaFor } from "../src/speak.js";

describe("checkText", () => {
  it("passes normal text", () => {
    expect(checkText("hello channel")).toBeUndefined();
  });
  it("rejects empty and whitespace", () => {
    expect(checkText("   ")).toMatch(/empty/i);
  });
  it("rejects over 2500 chars with a loud, actionable error", () => {
    const err = checkText("x".repeat(2501));
    expect(err).toMatch(/2500/);
    expect(err).toMatch(/shorten/i);
  });
  it("2500 exactly is allowed", () => {
    expect(checkText("x".repeat(2500))).toBeUndefined();
  });
});

describe("imetaFor", () => {
  it("matches the composer's NIP-92 shape", () => {
    expect(imetaFor("https://x/abc.mp3", 1234)).toEqual([
      "imeta",
      "url https://x/abc.mp3",
      "m audio/mpeg",
      "size 1234",
    ]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest --run` — Expected: FAIL — cannot resolve `../src/speak.js`.

- [ ] **Step 3: Implement `src/speak.ts`** (pure half):

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEXT_CAP = 2500;

/** Returns an error string, or undefined when the text is speakable. */
export function checkText(text: string): string | undefined {
  if (!text.trim()) return "nothing to speak — text is empty.";
  if (text.length > TEXT_CAP)
    return `text is ${text.length} chars; the cap is ${TEXT_CAP} (it is a paid API). Shorten it and call again — do not expect truncation.`;
  return undefined;
}

/** NIP-92 imeta tag, byte-shaped like the composer's (upload.ts imetaTag). */
export function imetaFor(url: string, size: number): string[] {
  return ["imeta", `url ${url}`, "m audio/mpeg", `size ${size}`];
}

/**
 * Voice overrides written by the gui panel via the prefs seam land in
 * this extension's state file. Headless side reads the same file.
 * Shape: { prefs: { voices: { [personaName]: voiceId } } }
 */
export function readVoicePrefs(
  file = path.join(os.homedir(), ".fez", "extension-data", "fez-elevenlabs.json")
): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      prefs?: { voices?: Record<string, string> };
    };
    return raw.prefs?.voices ?? {};
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest --run` — Expected: PASS.

- [ ] **Step 5: Implement `src/mcp.ts`** (the wired half — fez-memory's skeleton):

```ts
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { RelayConnection, getKey, resolveRelays, loadSettings } from "@fezchat/protocol";
import { uploadToBlossom } from "@fezchat/media/dist/blossom.js";
import { PINNED, voiceFor } from "./voices.js";
import { checkText, imetaFor, readVoicePrefs } from "./speak.js";

/**
 * fez-elevenlabs, skill part — agents speak.
 *
 * One tool. fez_speak turns text into an mp3 (ElevenLabs), uploads it
 * through the same Blossom path the composer uses, and publishes a
 * kind-47103 channel message AS THE AGENT with a NIP-92 imeta tag — so
 * the desktop's shipped audio playback renders it with zero new GUI
 * code, and the message content carries the spoken text (searchable,
 * readable in bare clients).
 *
 * Custody is the usual one: the agent's own key from FEZ_AGENT_PERSONA.
 * ELEVENLABS_API_KEY never leaves this process.
 */
const persona = process.env.FEZ_AGENT_PERSONA;
if (!persona) {
  console.error("fez-elevenlabs: FEZ_AGENT_PERSONA is required");
  process.exit(1);
}
const apiKey = process.env.ELEVENLABS_API_KEY;
const keyHex = getKey(`agent:${persona}`);
if (!keyHex) {
  console.error(`fez-elevenlabs: no local key for agent "${persona}"`);
  process.exit(1);
}
const secret = Uint8Array.from(Buffer.from(keyHex, "hex"));
const myPubkey = getPublicKey(secret);
const relay = new RelayConnection({
  urls: resolveRelays(),
  authSigner: async (tmpl) => finalizeEvent(tmpl as never, secret),
});

const KIND_MESSAGE = 47103;
const KIND_CHANNEL = 47101;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const sign = (tmpl: { kind: number; tags: string[][]; content: string }) =>
  finalizeEvent({ ...tmpl, created_at: Math.floor(Date.now() / 1000) } as never, secret);

/** Same resolution fez-memory uses: channel by id, else by name. */
async function resolveChannel(raw: string): Promise<string | undefined> {
  const channels = await relay.query([{ kinds: [KIND_CHANNEL], limit: 500 }]).catch(() => []);
  if (channels.find((e) => e.tags.find((t) => t[0] === "d")?.[1] === raw)) return raw;
  const nameOf = (e: { tags: string[][]; content: string }) => {
    const tag = e.tags.find((t) => t[0] === "name")?.[1];
    if (tag) return tag;
    try {
      return (JSON.parse(e.content) as { name?: string }).name;
    } catch {
      return undefined;
    }
  };
  return channels
    .find((e) => nameOf(e)?.toLowerCase() === raw.toLowerCase().replace(/^#/, ""))
    ?.tags.find((t) => t[0] === "d")?.[1];
}

function mediaServer(): string {
  if (process.env.FEZ_MEDIA_SERVER) return process.env.FEZ_MEDIA_SERVER;
  try {
    const s = loadSettings() as { mediaServer?: string };
    if (s.mediaServer) return s.mediaServer;
  } catch { /* settings unavailable */ }
  return "https://blossom.primal.net";
}

async function tts(voiceId: string, body: string): Promise<Uint8Array> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey!, "content-type": "application/json" },
      body: JSON.stringify({ text: body, model_id: "eleven_multilingual_v2" }),
    }
  );
  if (!res.ok) {
    const reason = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${reason || res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

const server = new McpServer({ name: "fez-elevenlabs", version: "0.1.0" });

server.registerTool(
  "fez_speak",
  {
    description:
      "Speak into a fez channel: turns text into a voice note in YOUR stable voice and posts it as an audio message. Use when the user asks you to say, read, or narrate something aloud. The text is also the message body, so keep it what you'd say — not markup.",
    inputSchema: {
      channel: z.string().describe("The channel (name like #general, or its id) to speak into."),
      text: z.string().min(1).describe("What to say, plain spoken language. Max 2500 chars."),
    },
  },
  async ({ channel, text: spoken }) => {
    if (!apiKey)
      return text(
        "can't speak: ELEVENLABS_API_KEY is not configured for this skill. Say so instead of pretending — the owner adds the key in Settings → skills."
      );
    const bad = checkText(spoken);
    if (bad) return text(bad);
    const channelId = await resolveChannel(channel);
    if (!channelId) return text(`no channel "${channel}" on this relay.`);
    try {
      const voice = voiceFor(myPubkey, readVoicePrefs(), persona);
      const bytes = await tts(voice.id, spoken.trim());
      const upload = await uploadToBlossom(mediaServer(), bytes, "audio/mpeg", sign);
      await relay.publish(
        sign({
          kind: KIND_MESSAGE,
          tags: [["h", channelId], imetaFor(upload.url, upload.size)],
          content: spoken.trim(),
        })
      );
      return text(`spoke in #${channel.replace(/^#/, "")} as ${voice.name} (${Math.round(upload.size / 1024)} KB mp3).`);
    } catch (err) {
      return text(`speak failed — ${err instanceof Error ? err.message : String(err)}. Tell the user; do not claim it posted.`);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 6: Build, typecheck, run all tests**

Run: `npm run build && npx tsc --noEmit && npx vitest --run`
Expected: dist/mcp.js and dist/gui.js may fail on missing `src/gui.ts` — if so, create a placeholder `src/gui.ts` containing only `export {};` and re-run. Tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/fez-elevenlabs
git commit -m "elevenlabs: fez_speak — tts, blossom upload, composer-shaped audio message"
```

---

### Task 3: The gui — voice mapping panel

**Files:**
- Modify: `packages/fez-elevenlabs/src/gui.ts` (replace placeholder)

**Interfaces:**
- Consumes: `PINNED`, `voiceFor` (Task 1); `GuiExtensionApi` (`api.React`, `api.client`, `api.prefs`, `api.registerSettingsPanel`) from `@fezchat/extension-api/gui`.
- Produces: a Settings panel named "ElevenLabs". Prefs written as one object: `prefs.set("voices", { [personaName]: voiceId })`.

- [ ] **Step 1: Implement `src/gui.ts`** (wallet's element-returning pattern — `api.React`, no bundled React):

```ts
import type { GuiExtensionApi } from "@fezchat/extension-api/gui";
import { PINNED, voiceFor } from "./voices.js";

/**
 * fez-elevenlabs, GUI part — the voice map.
 *
 * Each agent the workspace knows gets a row: name, its current voice
 * (deterministic default or override), a picker, and ▶ preview when the
 * pinned voice carries a public preview url. Writes go through the
 * prefs seam as one `voices` object; the skill reads the same file.
 * The API key is NOT here — it lives in the skill's env like every
 * other fez skill secret.
 */
export default function register(api: GuiExtensionApi) {
  const { createElement: h, useState, useEffect } = api.React;

  function Panel() {
    const [voices, setVoices] = useState<Record<string, string>>({});
    const [agents, setAgents] = useState<{ name: string; pk: string }[]>([]);

    useEffect(() => {
      void api.prefs.get<Record<string, string>>("voices").then((v) => setVoices(v ?? {}));
      const list = [...api.client.agents().entries()].map(([pk, name]) => ({ pk, name }));
      setAgents(list.sort((a, b) => a.name.localeCompare(b.name)));
    }, []);

    const set = (agent: string, id: string) => {
      const next = { ...voices };
      if (id) next[agent] = id;
      else delete next[agent];
      setVoices(next);
      void api.prefs.set("voices", next);
    };

    if (agents.length === 0) return h("div", { className: "settings-hint" }, "no agents yet — voices attach to agents.");

    return h(
      "div",
      null,
      h("div", { className: "settings-hint" }, "Each agent speaks with a stable voice — assigned from its identity, overridable here. The API key lives on the skill, in Settings → skills."),
      ...agents.map(({ name, pk }) => {
        const current = voiceFor(pk, voices, name);
        const overridden = !!voices[name];
        return h(
          "div",
          { key: name, className: "set-row" },
          h("span", { className: "set-label" }, `@${name}`),
          h(
            "select",
            {
              className: "manage-select",
              value: overridden ? current.id : "",
              onChange: (e: { target: { value: string } }) => set(name, e.target.value),
            },
            h("option", { value: "" }, `${current.name} (default)`),
            ...PINNED.map((v) => h("option", { key: v.id, value: v.id }, v.name))
          ),
          current.previewUrl &&
            h(
              "button",
              { className: "mini", onClick: () => void new Audio(current.previewUrl).play() },
              "▶"
            )
        );
      })
    );
  }

  api.registerSettingsPanel("ElevenLabs", () => h(Panel, null));
}
```

- [ ] **Step 2: Build and typecheck**

Run: `npm run build && npx tsc --noEmit`
Expected: clean. If `api.client.agents()` is not on the `GuiClient` slice, extend locally the way wallet does (`interface VoiceClient extends GuiClient { agents(): Map<string, string> }`) — fez-client has `agents()` (pk→name map); type against what is actually used.

- [ ] **Step 3: Commit**

```bash
git add packages/fez-elevenlabs/src/gui.ts
git commit -m "elevenlabs: gui voice map — per-agent picker over the prefs seam"
```

---

### Task 4: Catalog entry + link + the e2e gate

**Files:**
- Modify: `packages/fez-desktop/src/extensions-catalog.ts` (the `CATALOG` array, after the `@fezchat/themes` entry)

**Interfaces:**
- Consumes: `CatalogEntry` shape already in that file.

- [ ] **Step 1: Add the catalog entry**

```ts
  { name: "@fezchat/elevenlabs", title: "ElevenLabs", blurb: "Agents speak — ask any granted agent to say something and a voice note lands in the channel, in that agent's own stable voice.", where: "Adds the fez_speak skill; voice map in Settings → extensions.", permissions: ["network:api.elevenlabs.io", "network:relay", "publish", "read:channels", "ui"] },
```

- [ ] **Step 2: Typecheck the desktop**

Run: `cd ../fez-desktop && npm install && npx tsc --noEmit` (worktree desktop needs its deps once). Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/fez-desktop/src/extensions-catalog.ts
git commit -m "elevenlabs: catalog entry"
```

- [ ] **Step 4: Link into the live fez** (mechanical install for testing; run from `packages/fez-elevenlabs`)

```bash
npm run build
fez link            # registers this package's parts into ~/.fez (grant name @fezchat/elevenlabs)
```

Then add the skill + key to `~/.fez/settings.json` `mcpServers` (same shape as `memory`):

```jsonc
"elevenlabs": { "command": "node", "args": ["/Users/ken/Projects/fez-elevenlabs/packages/fez-elevenlabs/dist/mcp.js"], "env": { "ELEVENLABS_API_KEY": "<key>" } }
```

and grant it: add `elevenlabs` to `mcpServers:` in `~/.fez/personas/quill.md`, then kill quill's `fez-agent` process so the next mention respawns with it.

- [ ] **Step 5: Pin preview URLs (optional, needs the key)** — one curl, paste results into `PINNED`:

```bash
curl -s -H "xi-api-key: $ELEVENLABS_API_KEY" https://api.elevenlabs.io/v1/voices | \
  python3 -c "import json,sys; [print(v['voice_id'], v['name'], v.get('preview_url','')) for v in json.load(sys.stdin)['voices']]"
```

Also verify every pinned id appears in that output; replace any that don't, re-run Task 1's tests, commit as `elevenlabs: pin verified voice ids + previews`.

- [ ] **Step 6: THE GATE — manual e2e**

In the running app: `@quill say hi in #general`. Pass = a playable audio message from @quill appears in #general and plays in the shipped audio player; the memory pane stays untouched; `fez_speak`'s reply names the voice. Fail = read the error quill reports (it is told to relay real errors), fix, re-run. Do not merge to main before this passes.

- [ ] **Step 7: Merge** (after the gate, from the main checkout)

```bash
git -C ~/Projects/fez-tools-redesign merge --ff-only elevenlabs-extension  # or merge --no-ff if main moved
git -C ~/Projects/fez-tools-redesign push origin main
```

---

## Self-Review (done at write time)

- **Spec coverage**: package shape (T1), fez_speak pipeline incl. cap/errors/imeta (T2), voice identity + gui overrides (T1/T3), catalog (T4), e2e gate (T4). Out-of-scope list untouched — no task builds transcription/cloning/persona. ✓
- **Placeholders**: none; every step carries the code or the exact command. The one deliberately deferred datum (preview URLs) has its capture step (T4-S5) and the gui hides the button when absent. ✓
- **Type consistency**: `voiceFor(pk, overrides?, personaName?)` and `PINNED` used identically in T1/T2/T3; `imetaFor` produced and consumed in T2 only; prefs key `"voices"` written (T3) and read at `prefs.voices` (T2's `readVoicePrefs`). ✓
