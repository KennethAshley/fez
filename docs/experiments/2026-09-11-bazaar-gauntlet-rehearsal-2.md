# Second approved Bazaar coordination rehearsal

Outcome: **the coordinator delivered the spoken artifact; the validator recorded unassessed because its audio download refused a redirect**. The signed quality and total remain null. This is not an accepted gauntlet result and will not be relabeled.

Ken approved one fresh rehearsal after the first run's response-parser correction: USD 1 of reported coordinator usage across at most two invocations, USD 1 for one specialist invocation, zero service transfers, no retries, and no live reward changes. These are reported-usage stopping thresholds, not hard provider billing caps. The frozen job SHA-256 was `e85065d4a368067af09077d0c2ee829af4f4b27610fbbc5384d96e3b235aba2c`.

| Measurement | Observed result |
| --- | --- |
| Coordinator model usage | USD **0.9825715**, worker-reported |
| Speaker model usage | USD **0.398974**, runtime-reported |
| Combined reported model usage | USD **1.3815455**; not an invoice |
| Specialist service transfers | **0 tTAO**, sponsored |
| Quality / total | **null / null**, unassessed |
| Reward status | **not-submitted** |

Both agents ran their reviewed `claude-opus-5` configurations with their enabled tools. The coordinator prepared the exact script, sent a signed assignment to the existing speaker, reviewed the signed return, accepted that component, and delivered its artifact URL. The speaker used the existing macOS speech workflow once. The validator read back all four signed handoff events from the private Fez relay before attempting independent audio observation.

Execution began at 03:34:50 UTC on September 11, 2026. The speaker finished at 03:35:41. The validator published its unassessed result at 03:36:55, and all rehearsal processes stopped immediately afterward. The worker retired its private binding. Both single-run approval files were consumed, and port 17777 is no longer listening. The seven production service processes, start times, binaries, configuration hashes, and reward-path hashes match the pre-staging snapshot.

## Download failure

The validator's HTTPS GET to the signed `blossom.primal.net` content address returns HTTP 302 to `r2a.primal.net`. Its downloader deliberately refused redirects, so it never obtained bytes for the independent decoder or transcriber. A read-only reproduction using the same source and installed Node runtime confirmed the response and exact location. A HEAD request returned HTTP 200, so a HEAD-only readiness check would not have caught this behavior.

The failure is evaluator unavailability, not demonstrated bad audio. The specialist's capability acceptance therefore remains null. The coordinator's component acceptance and claimed file checks cannot replace independent validator evidence. No SALT, stake, payment, or chain reward is inferred from this run.

The returned content address is `370c65a7f76e1c6e442bf83e103f724644e24ed216926c3efdf50426f4222acf`. Its bytes match the prior demonstration recording because the approved script and local synthesis are deterministic; the new assignment, speech invocation, signed return, review, and delivery belong to this rehearsal.

## Correction and verification

The existing Bazaar downloader now follows at most three redirects. Every destination must independently pass the exact operator host allowlist, HTTPS, credential/port restrictions, and public DNS checks; the checked address stays pinned for the request. All hops share one 15-second deadline and the final body retains its 16 MiB cap. The operator guidance now distinguishes unavailable downloads from demonstrated invalid work. No scoring, signing, payment, or reward semantics changed.

The regression checks passed **342 Bazaar tests across 40 files**, plus typechecking and all builds. An independent code review found no lost redirect, DNS, timeout, or size boundary. Earlier Fez implementation gates remain 1,743 passed, 6 skipped, with typechecking and the full build passing; this follow-up changed no Fez runtime code. Existing uncommitted changes were preserved, and the corrected builds were not installed into live services.

A separate read-only verification explicitly allowed `blossom.primal.net` and `r2a.primal.net`, fetched the existing 537,170-byte WAV through the corrected downloader, and verified its SHA-256 against the signed artifact address. The existing decoder and Apple SpeechTranscriber independently observed non-silent audio and the exact approved words, without expected-text hints. The existing speech acceptance function returned accepted for that saved artifact and signed handoff. This check made **zero paid model calls, zero synthesis calls, and zero signed events**. It is a correction check, not a new gauntlet run or a replacement assessment.

The completed job's original one-host allowlist, consumed approval, and signed unassessed result remain unchanged. A future job must explicitly include both public storage hosts in its reviewed configuration. Another paid job still requires fresh authorization.

The playable verification copy is [download-fix-audio.wav](/private/tmp/fez-bazaar-rehearsal-20260911T033233Z/run/download-fix-audio.wav). Its observation and verification records are `run/download-fix-observation.json` and `run/download-fix-verification.json`.

## Approved free replay through the full validator

Ken subsequently authorized a free replay of this recorded job through the full validator. The replay **passed**, returning `accepted` with reason `verified-speech-delivery`. It called the existing `runCoordinationRound` with the default audio observer, so enrollment, branch collection, signed handoff read-back, corrected public audio download, decoding, transcription, resource/deadline checks, mandatory acceptance scoring, and assessment-template construction all ran together.

The replay verified all 19 saved event signatures and replayed the original progress/result events. It used enrollment state from before the job, excluding the later retirement, and reconstructed the historical clock from the signed task timestamp plus the original validator's recorded elapsed time. The task timestamp has second precision, so the timeliness score is a replay measurement rather than a replacement for the original arrival log. It explicitly allowed both public storage hosts without editing the original job.

The locally captured assessment has quality **1**, conduct **1**, timeliness **0.8635**, and total **0.9863**, with the specialist component accepted. These scores describe one recorded integration case, not general coordination performance. The recorded model costs and sponsored zero service fee are preserved; they are not new spending.

The signing hook returned the original task/request only after exact template comparisons. The final assessment was captured as an **unsigned local template** in memory. No new key access, signature, live event publication, model invocation, synthesis, service payment, or reward write occurred. Original outcome files and recording hashes match before and after the replay. The original signed assessment remains **unassessed**.

Replay evidence is under `/private/tmp/fez-bazaar-rehearsal-20260911T033233Z/free-replay`: [result.json](/private/tmp/fez-bazaar-rehearsal-20260911T033233Z/free-replay/result.json), `unsigned-assessment.json`, `input-hashes.json`, `execution.log`, and the runnable `replay.mjs`. This closes the full-validator integration check without another paid agent run.

## Evidence

Evidence is retained under `/private/tmp/fez-bazaar-rehearsal-20260911T033233Z/run`:

- Task: `0a39e193d82df3de693f090c7028c1acaf9aad333821f47ad3ebbcea53fb534b`.
- Speaker result: `addad1da4a373bddfcc32ba38c6cb31e8d827879372cd9afd7241398a9556111`.
- Coordinator delivery: `345df3326ee68866c30ccb2b48b90b8091203c6608fdc36c26d06481febc0d4e`.
- Validator assessment: `710ff44080dd5108d4b8ef9a538eec90b2adf305f0ad9c10b646ef86d03227ea`.
- `result.json`, `validator-47020.json`, `remote-signed-events.json`, `relay.jsonl`, `speaker-usage.json`, `closure-checks.json`, and `download-headers.json` retain the outcome, accounting, shutdown, and redirect evidence.

An independent audit verified all 19 unique relay-event signatures, exactly one task and branch, the complete approved participant/configuration chain, and the signed retirement. `signed-evidence-manifest.json` binds the original outcome files before the downloader correction.

The [first rehearsal](2026-09-11-bazaar-gauntlet-rehearsal.md) remains a separate rejected attempt. Another paid job requires fresh authorization.
