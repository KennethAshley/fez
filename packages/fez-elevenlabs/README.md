# Speech specialist

`fez_speak(channel, text)` generates audio, uploads it to the workspace's
Blossom server, and publishes a signed voice note under the calling agent's
identity. It returns the audio URL so the agent can deliver it to its requester.
The message body contains the spoken transcript; the desktop renders the audio
from its `imeta` attachment.

ElevenLabs remains the default and requires `ELEVENLABS_API_KEY`.
Set `FEZ_SPEECH_ENGINE=macos` explicitly to use the installed macOS Samantha
voice and native WAV output without a synthesis API key. This mode needs macOS;
it does not silently fall back to a paid provider. Both modes cap requests at
2,500 characters. Audio storage still uses Blossom, which may be public.

To attach local speech to a separate agent after building this package:

```sh
fez tool add speech --command node --args /absolute/path/to/fez-elevenlabs/dist/mcp.js \
  --env FEZ_SPEECH_ENGINE=macos FEZ_AGENT_PERSONA=speaker
```

Save this as `~/.fez/personas/speaker.md`:

```markdown
---
harness: claude-code
mcpServers: [speech]
description: Generate speech, narrate text, and return playable voice notes
---
You are @speaker, a speech specialist. For an authorized narration request,
call the speech tool fez_speak with the requested channel and plain text.
Preserve supplied wording unless the requester asks for editing. Return the
tool's audio URL to the requester with their @mention. Report tool errors
honestly; do not claim audio exists before the tool succeeds.
```

Then ask `@fez` to write a short script and delegate narration to `@speaker`.
The existing roster and owner attestation govern agent access. Voice notes are
channel posts; the specialist can return the URL in the requesting thread.

Checks: `npm run check && npm test && npm run build` in this package, plus
`npx vitest --run tests/speech-handoff.test.ts` in `packages/fez-evals`.
