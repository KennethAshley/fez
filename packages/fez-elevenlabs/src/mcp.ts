#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { RelayConnection, getKey, resolveRelays, loadSettings } from "@fezchat/protocol";
import { uploadToBlossom } from "@fezchat/media/dist/blossom.js";
import { PINNED, voiceFor } from "./voices.js";
import { checkText, imetaFor, matchChannel, readVoicePrefs } from "./speak.js";

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

/**
 * Same resolution fez-memory uses: channel by id, else by name. Does NOT
 * swallow a relay-query failure into "no channel found" — those are
 * different facts and the agent needs to hear which one happened.
 */
async function resolveChannel(raw: string): Promise<string | undefined> {
  const channels = await relay.query([{ kinds: [KIND_CHANNEL], limit: 500 }]);
  return matchChannel(channels, raw);
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
    let channelId: string | undefined;
    try {
      channelId = await resolveChannel(channel);
    } catch (err) {
      return text(
        `could not reach the relay to look up channels: ${err instanceof Error ? err.message : String(err)}`
      );
    }
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
