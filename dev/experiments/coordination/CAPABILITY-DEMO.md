# Fez capability demo: writing agent → speech agent

## Repeatable local validator

The [local validator command](./README.md#validate-a-saved-speech-handoff) now checks
the saved signed chain and independently processes the recording. Its actual-file
control run accepted the original submission and rejected shortened speech,
silent audio, corrupt audio, a result signed by an unassigned agent, and an
acceptance linked to the wrong result. Missing result evidence remained
unassessed. The negative audio files were generated locally from the saved public
sample; their synthetic submissions were re-signed with test keys and their own
artifact hashes, so they exercise content checks rather than merely failing an
old signature/hash. No live Fez events, API charges, or rewards were generated.

All five focused tests passed, including the native control run (about 53 seconds).
The full eval run passed 1,674 tests with five skipped before the opt-in native
test was added; that new test then passed separately. Root and explicit strict
validator/test typechecks passed. The validator's acceptance is limited to the
saved handoff and frozen script: current URL availability, claimed coordinator
tool actions, general writing quality, and reward eligibility remain outside it.

[Control results](/var/folders/xw/b0sklf9s1xq8_63v0t0xk2gh0000gn/T/fez-speech-validator-controls-90lSvz/summary.json) ·
[Accepted original](/var/folders/xw/b0sklf9s1xq8_63v0t0xk2gh0000gn/T/fez-speech-validator-controls-90lSvz/original/output/assessment.json)

## Independent audio-content check

The saved completion run now passes an independent waveform transcription check.
Apple's on-device `SpeechTranscriber` received only the saved WAV, with no expected
script or contextual hints. Its top transcription matches all **39 normalized
words in order**, with no additions or omissions. Comparison ignores case,
punctuation, hyphens and whitespace; alternate recognition hypotheses were not
substituted. The WAV's SHA-256 still matches the originally delivered artifact.

This closes the previously unassessed spoken-content check. It is an automated
content assessment, not a human voice-quality verdict or a miner reward decision.
The recognition step made no paid API call. Both the synthesis and recognition
implementations are supplied by Apple, but the recognition reads the waveform
independently of the synthesis transcript. The exact recognition-model asset
version was not exposed; the report records macOS 26.6.1, build 25G76. Original
workflow model cost remains unknown. Its reported 74-second elapsed time comes
from signed event timestamps, not a validator's monotonic observation clock.

[Audio-content assessment](/private/tmp/fez-completion-app.UWOsB5/audio-content-verification.json) ·
[Raw recognition output](/private/tmp/fez-completion-app.UWOsB5/independent-transcription.json) ·
[Audio-only transcription script](/private/tmp/fez-completion-app.UWOsB5/independent-transcribe.swift)

The original signed acceptance and historical verification below are preserved:
they describe what the coordinator checked during that run, before this later
independent assessment.

## Completion and acceptance records

The app's standing runtime now marks assignments to known, owner-attested
specialists with `task` pubkey tags on the existing signed channel message.
The worker calls `fez_complete_work` with that request's id, success/error,
capability, summary, and artifact URLs or event ids. This publishes a signed
result in the original thread. Its correlated signer/request/channel/root
allow the coordinator to wake without relying on a correctly spelled mention.
Ordinary p-tagged replies still do not wake peer agents.

The requester checks the deliverable and calls `fez_accept_work`. That publishes
the existing kind-47007 chit, signed by the requester and linked to the worker,
result, request and capability. Submission does not create acceptance. A worker
cannot accept its own result through this tool, and an error result cannot be
accepted. The acceptance note states what the requester actually checked;
it is a claim by that signer, not independent verification or user approval.
Existing Salt household exclusions still apply: an internal demo does not
manufacture public reputation for its owner's agents.

The worker's normal tool acknowledgment is suppressed once its signed result
has been published. Duplicate callbacks are suppressed, queued results receive
separate review turns, and restart recovery checks signed responses before
replaying the latest 200 terminal results. That bounded recovery is not an
unlimited durable job queue. Unknown/unattested agents and old chat-only
callbacks retain their existing behavior; this does not implement marketplace
coordination, miner scoring, staking, or emission rewards.

Validation: root, ACP, MCP and client typechecks pass. ACP/MCP bundles and local
signed executables build. Full eval gate: **1,667 passed, five skipped**.
Tests exercise assigned-signer validation, wrong-channel/nonterminal rejection,
duplicate result and chit suppression, self/error acceptance rejection, relay
publish errors, separate queued reviews, original-thread preservation, and
startup recovery without replaying answered completions.

The installed app completed one fresh request with **no operator retry**:
`@fez` wrote the script, speaker returned a signed completion, and `@fez`
downloaded/checked the WAV, signed an acceptance chit, and delivered the link
in the original thread. **74 seconds** from user request to final delivery;
**22 seconds** from assignment to specialist result. Both agents were cold
started by the normal app summoner with their existing identities.

Independent verification confirms six event signatures, assignment/result/chit
links, a **12.09-second**, 537,170-byte WAV, matching content hash, successful
decoding, nonzero audio signal, and exact preservation of the supplied speech
transcript. The coordinator's chit explicitly says it checked the tool-reported
transcript, not an independent transcription of the waveform. This is
coordinator acceptance; the user has not supplied a listening-quality verdict.

Three completed model turns have duration records (18.094 s, 14.659 s, 25.162 s)
but no reported token/dollar usage. Model cost is unknown. The local speech
backend made no synthesis API call, and no Chutes run was launched.

[Play the result](/private/tmp/fez-completion-app.UWOsB5/fez-introduction.wav) ·
[Verification](/private/tmp/fez-completion-app.UWOsB5/verification.json) ·
[Signed records](/private/tmp/fez-completion-app.UWOsB5/events.json)

Evidence: `/private/tmp/fez-completion-app.UWOsB5`; full test log:
`/private/tmp/fez-completion-full-evals.log`. The installed binaries and updated
speaker persona have backups in that evidence directory. The earlier
demonstrations below remain historical results.

## Startup recovery fix

The first-request loss is reproduced and fixed in the standing agent runtime.
On the membership-gated relay, an uninvited agent's history query returns no
channel messages. The old runtime performed that query only once; enrollment
arriving later did not trigger recovery. The runtime now waits for roster access
before recovering startup work and replays the current roster to close the gap
between its initial membership query and live subscription. Existing answered
request tracking and event deduplication remain in use.

Regression tests run the real runtime against a real NIP-42/membership relay with
a controlled model and temporary identities. They cover enrollment before boot,
during boot, and after announcement. The original late-enrollment case fails;
the fixed cases pass. The complete gate now passes **1,658 tests, five skipped**;
root/ACP typechecks and runtime builds pass. The earlier watcher failure did not
recur in this full run; no watcher code was changed.

The tested runtime is installed locally with the previous binary backed up.
The live app check **completed without a resend**: speaker was stopped, its prior
presence expired, and one new request to the existing `@fez` woke it through the
normal desktop summoner. The log records startup backfill, one model turn and
one response. The workspace roster and agent identity were preserved; enrollment
races themselves were tested with temporary identities on the real local relay.

[Play the 19.99-second WAV](/private/tmp/fez-coldstart-app.A6UOan/fez-introduction.wav) · [Verification](/private/tmp/fez-coldstart-app.A6UOan/verification.json) · [Diagnosis](/private/tmp/fez-coldstart-app.A6UOan/diagnosis.md)

One request, one coordinator handoff, one audio post, one specialist reply,
**36 seconds to delivery**, zero operator retries. Four event signatures, exact
script preservation, 885,846-byte size, content hash, decoding and nonzero audio
signal verify. The speaker returned the URL directly to the user in the original
thread; `@fez` did not produce another wrap-up. This verifies startup recovery
and user-visible delivery, not guaranteed callback routing to the coordinator.
Two completed agent turns have duration records but no reported token/dollar
usage. Local speech made no synthesis API call; model cost remains unknown.

Evidence: `/private/tmp/fez-coldstart-app.A6UOan`. The initial first-installation
retry described below remains historical evidence, not part of this new run.

## Previous result: ordinary app conversation

The installed `@fez` wrote a short public introduction, delegated narration by
mentioning the new `@speaker`, received its audio URL, and delivered that URL
back to the owner in the original thread. The speaker used an actual speech
synthesizer (macOS Samantha), not a second text-only role prompt.

[Play the 12.88-second WAV](/private/tmp/fez-speech-app.aHF4Tp/fez-introduction.wav) · [Transcript](/private/tmp/fez-speech-app.aHF4Tp/transcript.txt) · [Verification](/private/tmp/fez-speech-app.aHF4Tp/verification.json)

- **Transport:** existing signed kind-47103 channel messages on the user's
  `ws://127.0.0.1:7777` workspace, with roster membership and owner attestation.
  The desktop summoned speaker automatically and keeps it in its agent registry.
- **Artifact:** 572,272-byte PCM WAV, fetched successfully from the configured
  Blossom server. URL hash, byte count, seven event signatures, exact script
  preservation, decoding, and nonzero audio signal verified. This is pipeline
  acceptance; subjective voice quality has not been graded.
- **Timing:** 115 seconds from the initial request to final delivery, including
  one operator retry. After that retry: 34 seconds to delivery; 28 seconds from
  the coordinator's renewed specialist handoff to final delivery.
- **Cost:** zero speech-synthesis API calls. Four completed Claude Code agent
  turns reported durations but no token or dollar usage; their cost is unknown,
  not zero. No new Chutes calls were made for this app run.
- **Limitation:** the first summon started the agent and added it to the roster,
  but did not pick up the initial handoff. The log shows it was initially absent
  from the roster and had no backfilled turn. An owner prompt asked `@fez` to
  retry once after enrollment; the rest completed normally. The startup race
  was uncorrected in this earlier run; the fix and fresh check are above. This is an assisted app demonstration, not an autonomous
  benchmark score.

The speech extension now has an explicit `FEZ_SPEECH_ENGINE=macos` option;
ElevenLabs remains its default. `fez_speak` returns the generated URL and declares
WAV MIME metadata correctly. It publishes a channel voice note, and the specialist
returns its link in the requesting thread. The audio post itself is not threaded.
No new event kind, core orchestration mechanism, GUI, or dependency was added.

Local installation: `~/.fez/personas/speaker.md` uses Claude Code and attaches the
`speech` MCP alias. That alias points to this checkout's built
`packages/fez-elevenlabs/dist/mcp.js`; retain that build for the local installation.
The existing ElevenLabs tool configuration was preserved. Only the generated
public demo narration was uploaded; channel history was not sent to media storage.
The speaker persona, tool registration, keychain identity, roster entry, and app
process remain available for subsequent requests.

Validation: root and extension typechecks passed, extension tests passed 19/19,
and the new speech handoff eval passed 3/3. Two complete Fez suite runs each had
1,654 passing tests, five skipped, and the same one failure in the unrelated
`relay-watch.test.ts` debounced callback check. Its isolated run outside the
sandbox passed 3/3; the sandboxed retry reported `EMFILE`. The full gate is **not
clean**; no fix or success claim is made for that separate watcher failure.

Evidence: `/private/tmp/fez-speech-app.aHF4Tp/{request,events,retry,metrics,verification}.json`.
The runner and verifier live alongside those records. Setup documentation is in
[the speech extension README](../../../packages/fez-elevenlabs/README.md).

Try in Fez's general channel: `@fez Write a short welcome and ask @speaker to narrate it.`

## Earlier SDK demonstration

**Delivered:** a 25.23-second spoken introduction to Fez and its transcript.

[Play/download the MP3](/private/tmp/fez-capabilities.wy3wplx6/resume/delivered/fez-introduction.mp3) · [Read the transcript](/private/tmp/fez-capabilities.wy3wplx6/resume/delivered/transcript.txt)

The useful job: turn a short factual Fez brief into an accessible spoken introduction. The writer composes language; the speaker synthesizes audio. These are different capabilities, not two prompts assigning different roles to the same chat model.

## Actual flow

1. Buyer sends a signed Fez task to a fixed coordinator.
2. Coordinator asks the writer agent to compose the narration. The writer uses Chutes `moonshotai/Kimi-K2.6-TEE` with thinking disabled.
3. Coordinator forwards the writer’s signed result inside a new task addressed to the speech agent. The speaker verifies the original signature and text hash, then uses macOS `say`, voice Samantha, at 165 words per minute.
4. Speaker returns an MP3 URL, MIME type, byte count and SHA-256. The coordinator and buyer each download the audio over HTTP and verify it; the buyer saves the final MP3 and transcript.

The coordinator uses a fixed sequence. The agents have distinct Fez identities and relay connections while sharing this demo host. The existing `withLocalTeam` and Fez Agent/CapabilityClient implementation handle the signed task/result transport; no new protocol was introduced. The speech process receives a clean environment without the provider key.

## Evidence

- Nine valid signed events: three agent metadata events, three tasks, three results. Both specialist tasks belong to the original buyer task.
- Writer output exactly matches the speech input. A modified writer result fails signature verification.
- Both audio downloads match the returned hash and byte count. The final MP3 decodes as mono 22,050 Hz audio, lasts 25.23 seconds, and has nonzero measured signal. This verifies the data and audio pipeline, not a human listening assessment.
- One real writing-model call cost **$0.000502 estimated tokens** under a $0.10 cap. Speech made zero external API calls; local compute cost is unmeasured. No additional paid generation was needed.

The initial wrapper rejected the otherwise usable 86-word narration because it enforced its own 85-word style target. That was an unnecessary host restriction, not a failed writing capability. The failed episode is retained. After removing the word-count gate, the writer reissued the exact saved model response through a fresh signed Fez task and the speech/delivery chain completed. This is an assisted demo, not an uninterrupted autonomous run or benchmark score. Input size, signatures, schema, artifact origin/hash/size and audio checks remain enforced. Summed active original/resumed run time was 4.159 seconds; this excludes setup and operator work. The resumed run’s 0.771 seconds alone must not be presented as full generation latency.

[Verified episode](/private/tmp/fez-capabilities.wy3wplx6/resume/episode.json) · [Verification](/private/tmp/fez-capabilities.wy3wplx6/resume/verification.json) · [Disposable runner](/private/tmp/fez-capabilities.wy3wplx6/demo.mjs) · [Original request/limits](/private/tmp/fez-capabilities.wy3wplx6/manifest.json)

## What this establishes

A text-generating agent and a speech-synthesis agent can compose a useful artifact through real Fez signed task/result exchanges. No single-agent comparison is necessary to demonstrate this capability composition.

This ran on a private local relay through the SDK task API, not through the installed desktop `@fez`. Local media URLs were temporary and closed after delivery; the saved files above remain available. It did not test automatic discovery, independently deployed remote workers, transcription, image generation, public media uploads or miner rewards. No production application code, installed persona or credential configuration changed.

Repository inspection found an existing ElevenLabs speech extension, but its API key was not available in this session. The generic attachment prompt currently treats incoming audio/video as unavailable; a transcription agent must therefore be wired explicitly rather than assumed to exist.

**The SDK demo’s next step is now completed above:** expose a speech specialist to the app’s `@fez` and complete the same job through an ordinary conversation. Keep image/transcription additions capability-specific. The old R01 documentation dispute remains a historical unresolved benchmark result and does not gate this alpha direction.
