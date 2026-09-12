# First coordination gauntlet: staging and run review

User authorization: continue staging preparation after the completed implementation. Preserve all uncommitted changes. No paid inference, specialist payment, new billable infrastructure, or live reward changes are authorized.

1. [x] Inspect the existing DigitalOcean deployment and the actual local `fez`/`speaker` runtime configuration without starting agents or changing services.
2. [x] Stage the built artifacts in a separate release directory. Verify hashes and executable loading; preserve live service binaries, configuration, process IDs and reward paths.
3. [x] Exercise the staged local preview and independent speech observation without inference. Prepare the exact job, identities, enabled capabilities and proposed separate spending allowances.
4. [x] Review the staged release and leave one concrete approval request for the live job, including unresolved readiness requirements.

## Decisions

- Existing deployment scripts restart live miners and validators, so they are not used for this staging release.
- The coordinator remains on this Mac with its existing owner-enabled tools and credentials. The speech observer also runs here because its installed transcription backend is macOS-native. No personal credentials are copied to DigitalOcean.
- An older installed agent may ignore the new evaluation environment flags. Only the inspected new build may execute staging preflight.
- Staging is not a measured job, paid outcome, or chain credit. Tests and previews must not publish new work for live agents.

## Evidence

- Final Fez gate: 1,743 passed, 6 skipped; root typecheck passed; core + 45 packages built.
- Final Bazaar gate: 337 tests passed across 40 files; typecheck and all builds passed.
- Final actual-agent previews: both ready, same reviewed model/tool configuration hashes. No inference.
- Existing saved speech: fresh independent decoding/transcription accepted; not a new job outcome.
- Final DigitalOcean artifact checksums passed. All seven live service processes/start times and all live file hashes match the pre-staging snapshot.
- Private staging signer: 7 fixture checks passed against the final bundle, including concurrent requests, tag confinement, and actual accepted/rejected attestation templates. Its remote check confirms the expected validator public key and no signed events or approval file.
- Detailed job, allowances, owner status, isolation requirements, and artifact locations: [staging review](../../experiments/2026-09-11-bazaar-gauntlet-staging.md).

## Approved rehearsal follow-up

Ken approved exactly one rehearsal. It ran once and was rejected before the speaker handoff, recording USD 0.500994 coordinator usage and zero speaker/service spending. The agent's correct fenced JSON was followed by commentary that the parser mishandled. The parser correction passes 340 Bazaar tests, typechecking, builds, and an offline replay of the saved response. The signed failed outcome remains unchanged; authorization is consumed, all rehearsal processes are stopped, and another paid attempt requires fresh approval. See the [rehearsal result](../../experiments/2026-09-11-bazaar-gauntlet-rehearsal.md).

Ken separately approved a second single rehearsal. The coordinator and speaker completed the signed handoff, review, and final delivery. Reported costs were USD 0.9825715 for the coordinator and USD 0.398974 for the speaker, with zero service transfers. The validator recorded **unassessed**, with null quality and total, because the artifact GET redirects from Blossom to its storage host and the downloader refused redirects. Both approvals are consumed, all rehearsal processes are stopped, and production snapshots remain unchanged. The [second rehearsal result](../../experiments/2026-09-11-bazaar-gauntlet-rehearsal-2.md) preserves the signed outcome and read-only diagnosis.

The downloader correction now permits at most three independently allowlisted public HTTPS redirects under the existing shared timeout and size cap. All 342 Bazaar tests, typechecking, and builds pass. Fetching the existing recording with both explicit storage hosts succeeded, and independent local decoding/transcription accepted the saved speech contract without new paid inference, synthesis, or signatures. The original unassessed job is preserved; no live deployment or additional paid job has run.

The separately approved free replay through the existing full `runCoordinationRound` also passed: accepted/verified-speech-delivery after enrollment, saved signed event collection/read-back, the default audio downloader/observer, mandatory scoring, and local assessment-template capture. The replay produced no new model calls, synthesis, signatures, live publications, service payments, or reward writes. The original signed unassessed assessment and evidence hashes remain unchanged. Details and the unsigned local replay output are linked in the second rehearsal report.
