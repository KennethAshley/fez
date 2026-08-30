# @fezchat/elevenlabs — agents speak

**Date**: 2026-08-30 · **Status**: approved · **Branch**: `elevenlabs-extension` (worktree `~/Projects/fez-elevenlabs`)

## The moment

An agent drops a spoken audio note into a channel: "@quill read me the standup" and a
playable voice message appears from @quill. Text-to-speech only — transcription, voice
cloning, sound effects, and ElevenLabs' hosted/OAuth agent platform are all explicitly
out of scope.

## Positioning: a provider extension, not the voice extension

The package is **`@fezchat/elevenlabs`** (`packages/fez-elevenlabs`), named for its
provider like `@fezchat/hippius` and `@fezchat/bittensor` — because other voice
providers will exist. Everything ElevenLabs-specific (API call, key, stock-voice
list) lives here. The two things a second provider would share — the `fez_speak`
verb and per-agent voice mapping — deliberately stay inside this package until a
second provider actually arrives; extracting a shared voice seam then is mechanical,
inventing it now is speculation. The tool name stays provider-neutral (`fez_speak`)
so personas don't rewrite when providers change. Granting one persona two voice
skills is unsupported user error.

## Parts

Two parts plus a catalog entry:

- **skill** (`dist/mcp.js`) — a stdio MCP server signed with the calling agent's key,
  the fez-memory skeleton (`FEZ_AGENT_PERSONA` / `FEZ_RELAY` env, relay client,
  channel resolution). Declared per persona via `mcpServers: [elevenlabs]`.
- **gui** — a small settings panel (mount model, App.css classes): each known agent as
  a face with a voice picker and a ▶ preview button; writes overrides via the
  extension prefs seam.
- **catalog** — an entry in `extensions-catalog.ts` (title "ElevenLabs", blurb, where,
  permissions) so browse/installed dress it with its relic.

No persona ships. Any agent granted the skill can speak.

## The one tool

`fez_speak(channel, text)`:

1. Resolve the calling agent from `FEZ_AGENT_PERSONA`; resolve `channel` by name or id
   (fez-memory's `resolveChannel` pattern).
2. Pick the voice: prefs override for this agent, else the deterministic default
   (below).
3. POST ElevenLabs TTS (mp3 output). `ELEVENLABS_API_KEY` comes from the skill's env
   via fez's normal env-key handling — value stays on the machine, never rides the
   wire or a listing.
4. Upload the mp3 through the existing Blossom media path (Blossom stays the default
   backend; the hippius media seam remains deferred, consistent with prior decisions).
5. Publish a channel message **as the agent** carrying a NIP-92 `imeta` tag
   (url + `audio/mpeg` mime) — the same shape the composer's file attach produces, so
   the shipped audio playback renders it with zero new GUI code.
6. Return a one-line confirmation (voice used, duration).

Guardrails: `text` capped at 2,500 chars with a loud error telling the agent to
shorten — never silent truncation; it is a paid API. Every failure (bad key, quota,
upload failure) returns the real error to the agent so it can say so instead of
claiming success.

## Voice identity

The sprite trick, for sound: hash the agent's pk into a curated list of ~10
ElevenLabs stock voice ids — quill sounds like quill on every machine with no
configuration. Overrides live in this extension's prefs
(`{ [personaName]: voiceId }`), edited in the gui panel. The curated list is pinned
voice ids in `src/voices.ts`, not a live API listing — deterministic defaults must
not drift when ElevenLabs reshuffles their catalog.

## Files

```
packages/fez-elevenlabs/
  package.json        # fez manifest: parts skill+gui, permissions, minFezVersion
  src/mcp.ts          # the skill: fez_speak
  src/voices.ts       # pinned stock-voice ids + pk-hash pick
  src/gui.tsx         # settings panel: agent faces → voice picker + preview
packages/fez-desktop/src/extensions-catalog.ts   # + catalog entry
```

## Testing

- **Unit**: voice pick is deterministic per pk and total over the pinned list;
  request shaping (cap enforced, error paths return errors).
- **Manual e2e (the gate)**: install, grant to quill, "@quill say hi in #general",
  hear it play in the shipped audio player. The seam that matters is step 5 — the
  published message must be byte-shaped like a human upload. Implementation reads the
  composer's attach path before writing it.

## Not building (revisit as their own asks)

Transcription (voice capture), cloning, sound effects, the hosted OAuth MCP, a
dedicated @voice persona, hippius storage backend, a shared multi-provider voice
seam.
