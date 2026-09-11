# Coordination benchmark foundation

**Current alpha focus:** demonstrate useful work across agents with different capabilities. The [writing → speech demo](./CAPABILITY-DEMO.md) completes through the installed app’s `@fez` and a separate `speaker` persona, with signed completion, requester acceptance, and final delivery in 74 seconds with zero retries. Independent waveform transcription matches the requested script. The local validator below accepts that saved submission and rejects deliberately bad controls. Earlier enrollment failures remain in the report. Model-ranking comparisons below are historical research; beating a single general-purpose agent is not a prerequisite for capability interoperability.

## Validate a saved speech handoff

[speech-validator.ts](./speech-validator.ts) checks a frozen, reviewer-approved script,
signed assignment/result/acceptance/delivery records, artifact hash, WAV decoding,
non-silence, and independent spoken content. It reuses the client's `workResult`,
`acceptWork`, and thread parser. The reviewer supplies the trusted contract:
`{ request, coordinator, specialist, script }`, where `request` is the original
signed user event and the two identities are authorized public keys. The untrusted
submission contains `{ assignment, result, acceptance, delivery }`, each a signed
event or null. Keep the contract outside the submitter's control. This case freezes
an already-reviewed script; it does not grade arbitrary new writing.

On macOS 26 with Swift, ffmpeg, and an installed English SpeechTranscriber model:

```sh
speech_validator_build=$(mktemp -d -t fez-speech-validator)
./node_modules/.bin/esbuild dev/experiments/coordination/run-speech-validator.ts --bundle --platform=node --format=esm --target=node24 --outfile="$speech_validator_build/run.mjs"
node "$speech_validator_build/run.mjs" /validator/contract.json /submission/records.json /submission/audio.wav /path/to/new-assessment
```

The output directory must be new. The command snapshots the input bytes, decodes
them with ffmpeg, and independently transcribes the waveform on-device. No script
hints, network fetch, model download, relay post, or paid inference call is made.
It never accepts a submitter-provided transcript as the observation. The exported
assessor's `AudioObservation` is likewise validator-owned input, not a miner API.
Use `-` instead of the audio path to record missing audio. Missing records, audio,
decoder, or transcription remain unassessed; established event violations remain
rejections. CLI exit codes: 0 accepted, 2 rejected, 3 unassessed, 1 setup failure.

Word comparison ignores case, punctuation, hyphens and whitespace, preserving word
order and Unicode letters/numbers. If the top transcript differs but a supplied
full alternative matches, the result stays unassessed for review. The native
adapter constructs alternatives by substituting one recognition segment at a
time; this is a conservative development check, not a calibrated speech judge.
Unknown original model cost remains null.

Acceptance is scoped to the saved handoff and approved script. The report explicitly
leaves live URL availability and the coordinator's claimed tool actions unverified,
and `rewardEligible` false. Signed acceptance does not prove those actions occurred.
There is no miner identity admission, live permission audit, human voice-quality
grade, or chain-weight integration. Audio processing runs locally with bounded
inputs/process output/time, not in a sandbox suitable for hostile miners.

Deterministic checks run in the normal eval suite. The opt-in control check uses
the saved public demo, preserves its records, creates separately signed synthetic
negative submissions, and tests actual shortened, silent and corrupt files:

```sh
FEZ_SPEECH_VALIDATOR_EVIDENCE=/private/tmp/fez-completion-app.UWOsB5 npm test --prefix packages/fez-evals -- tests/speech-validator.test.ts
```

It prints a retained `summary.json` and assessment paths. Without that environment
variable, the native/file control test is skipped; the deterministic checks still run.

Compare complete, locally supplied validator assessments for coordination-miner candidates. Outcome quality determines the ordering. Cost, time and human interventions are reported separately.

The [18-case development task pack](./TASKS.md) now supplies concrete repository fixtures, writing source packs, acceptance rules and baseline instruction snapshots. Start with its C01 invoice-repair case for a task grounded in a recorded specialist hire.

The scorer is an offline experiment. It does not execute an agent, grade an artifact, enforce a budget, verify an identity/payment, or publish subnet weights. Its inputs must come from a trusted assessor. Hashes identify declarations; they do not prove honest execution. Synthetic examples below establish no coordination advantage.

## Preview or run a model artifact pilot

[model-pilot.ts](./model-pilot.ts) now connects model HTTP requests to the same Fez team used by the transport rehearsal. It compares one attempt each for an individual lead, a host-enforced fixed workflow, and an adaptive instruction file. All arms use the same lead model, specialist roster and total call allowance. Every lead may revise its own drafts. The fixed sequence is coder → reviewer for coding, researcher → writer → reviewer for writing, and coder → writer → reviewer for combined tasks. Only the adaptive lead may choose additional handoffs.

This is a **file-generation pilot with no code execution**. Models receive the public task, sources and starting files; they can submit files, revise drafts, or ask named specialists through Fez. They have no host shell, filesystem, browser, payment tools or access to the API credential. Returned code/test text is saved under allowlisted filenames and never executed. Prepared inputs stay unchanged. Reference repairs and reviewer notes are not sent to models.

Version 3 retains `response_format: {"type":"json_object"}` on every call, following [Chutes' JSON-mode interface](https://chutes.ai/docs/guides/agents-and-tools). Specialists receive only the submit action; leads may revise, and only adaptive leads receive the delegation action. Exact policies, response format and model settings are included in hashed preview conditions and recorded requests. JSON mode constrains syntax; Fez still validates actions, role permissions and artifact filenames. It does not establish truthful claims or correct code. The runner does not strip fences, repair answers or silently fall back. Earlier results remain distinct experiments.

A model may declare optional `thinking: true|false`, sent as `chat_template_kwargs: {thinking: ...}` only for that model. Omission preserves the provider default. This is a provider chat-template option, not a portable setting for every API/model. The Chutes configuration explicitly disables thinking for Kimi's writer role, using the [documented Instant-mode interface](https://chutes.ai/docs/models/chutes-moonshotai-kimi-k2-6-tee). Other models retain their defaults.

The [proposed Chutes configuration](./chutes-pilot.json) uses DeepSeek for the lead/researcher, GLM for coding, Kimi for writing and Qwen for review. These are starting hypotheses about useful roles. Exact IDs and declared prices were checked against [Chutes' pricing catalog](https://chutes.ai/pricing) on 2026-09-10; refresh them before a funded run. Chutes documents the endpoint and bearer authentication in its [starter guide](https://chutes.ai/docs/guides/starter-guide). The caller supplies the credential only as `FEZ_COORDINATION_API_KEY`; the runner does not inspect Fez's credential store.

1. Compile the command using the installed dependencies, then create a preview. Run from the repository root:

   ```sh
   coordination_build=$(mktemp -d dev/experiments/coordination/.model-pilot.XXXXXX)
   ./node_modules/.bin/esbuild dev/experiments/coordination/run-model-pilot.ts --bundle --platform=node --format=esm --target=node20 --packages=external --outfile="$coordination_build/run.mjs"
   coordination_output=$(mktemp -d -t fez-model-pilot)
   node "$coordination_build/run.mjs" dev/experiments/coordination/chutes-pilot.json dev/experiments/coordination/candidate-first.md "$coordination_output/preview"
   ```

   Preview is the default and contacts no provider. `preview.json` contains the exact configuration, candidate/baseline instruction bytes and hashes, task-pack hash, protocol prompt and common conditions hash. The proposed C01 run allows at most **18 model requests total**, six per arm, with at most 4,096 requested output tokens per call, 64,000 request bytes per call and 180 seconds per arm. These are a small pilot's limits, distinct from the development pack's proposed full benchmark profile.

2. Review the preview and authorize provider spending separately. Once the credential is securely present in the process environment, explicitly start execution in a new directory:

   ```sh
   node "$coordination_build/run.mjs" dev/experiments/coordination/chutes-pilot.json dev/experiments/coordination/candidate-first.md "$coordination_output/run" --run
   ```

   This command performs real inference. It sends the key only in the configured endpoint's authorization header, refuses redirects, and accepts HTTPS or literal loopback HTTP. It never reads a key from candidate instructions or writes the authorization header into evidence. Missing/mismatched reported model IDs, malformed or oversized replies, output-limit violations and deadlines remain recorded failures. The requested/reported model ID is a provider declaration, not proof of its underlying weights.

3. Inspect `report.json`, each arm's `episode.json`, and its `delivered` files. Remove the temporary bundle after use:

   ```sh
   rm "$coordination_build/run.mjs"
   rmdir "$coordination_build"
   ```

Every attempted model request, including lead, specialist and failed calls, is retained with the request body, visible response text, reported input/output token counts, model IDs and elapsed time. Stop reason is retained even when final content is missing. Valid reported `usage.reasoning_tokens` counts are recorded separately; absent or invalid counts remain null. Private reasoning text is never collected or substituted for an answer. Full signed task/result events preserve the final delivery and its parent/child handoffs. The same local-team admission code serves both the scripted rehearsal and model pilot.

`costMicrousd` here estimates **model token charges only**, from provider-reported usage and the declared per-million-token prices. It excludes host/infrastructure costs and other fees; it is not a paid invoice or full-system total. A missing response, invalid usage, unknown price or model mismatch leaves the affected call's cost null and the arm's total unknown. Failed responses with valid usage still count. Prices are integer micro-USD per million tokens; zero is a declared zero price, while null means unknown. These call/byte/time controls do not impose a hard dollar billing cap on the provider; use provider-side spending controls when that is required.

`complete: true` means all three attempts have been recorded, including failed ones. `delivered` means the lead returned all required filenames; it does not mean the files are correct. Each arm keeps `assessment: null` and `checks: null`. The command exits `2` when any arm failed, `1` for setup/configuration failure, and `0` when all returned files. An interrupted run may have an incomplete report or only its preview.

The pilot runs one public task once per arm, in a declared fixed order. It supplies fewer tools than the full benchmark and does not run the native desktop @fez persona. It supports source review and draft revision, but no test execution. It cannot establish full task acceptance, model quality, statistical significance or causal delegation benefit. Tool isolation for executing generated code, repeated/counterbalanced trials, independent assessment and the remaining task schedule are required before scorer or reward use. No assessment rows or chain weights are emitted.

## R01 repository tools

The same pilot now accepts `--repositories <checkouts.json>` after the optional `--run` flag, with `taskId: "R01"` in its configuration. The JSON maps `individual`, `fixed-workflow` and `adaptive` to three clean, independent prepared checkouts of the same commit. Preview remains the default and makes no provider call. Compile the existing command as above; this mode requires macOS and Node 24+ for checks. Its distinct conditions version is `fez-model-repository-pilot-v1`; prior artifact-only conditions remain unchanged.

[repository-tools.ts](./repository-tools.ts) supplies tracked-source listing/reading, writes to R01's three allowed files with a prior-hash check, and two named checks: the delivery Vitest suite and ACP TypeScript. Lead and specialists share their arm's checkout sequentially. Tool turns count against the same model-call/request/time allowance as other turns. The signed lead result includes the final source hashes; the host saves those files, `patch.diff`, all tool observations and final source even for a failed attempt. The three files supplied initially are baseline sources; later reads observe edits.

Checks run with a cleared environment and deny-default macOS sandbox. Checkout files and tool evidence are read-only to the check process; Git test repositories live in a disposable writable scratch directory. Network and host/other-checkout file-content reads/writes are denied; filesystem metadata reads remain permitted. Node, Git, its shell/hooks and the pinned esbuild executable are allowed as needed. Checks have a 30-second deadline, 128 KiB per output stream and a 512 MiB V8 heap setting; cancellation kills their process group. These are local development controls, not hard aggregate memory/process quotas or a hostile-miner sandbox. Child output remains an observation with `accepted: null`, not an independent grade.

Verified tool evidence: `/private/tmp/fez-r01-tools.Ri51JL/results.md`. All 35 focused tests and root/explicit strict TypeScript checks passed. At that stage the full gate passed 1,565 tests with one skipped and one concurrently added Polls GUI test failed on a non-`file:` URL; the later evaluator stage below passed the full gate. Local HTTP fixtures exercise read/write requests, signed specialist handoffs, source capture and shared cost accounting without billable inference. All three prepared R01 checkouts pass their original four delivery tests and ACP types under the tool sandbox and retain unchanged source. The defect still exists; this verifies the tools, not a repair. The external code evaluator is now available below; a separately frozen funded-run manifest remains required before the first live R01 comparison. The six-call artifact configuration is only used for CLI preview validation; R01's actual allowance is not selected yet.

## Evaluate a saved R01 repository pilot

The existing verifier also accepts a third positional argument: R01's frozen baseline checkout. From the repository root, on macOS with Node 24+:

```sh
coordination_evaluator_build=$(mktemp -d -t fez-r01-evaluator-build)
./node_modules/.bin/esbuild dev/experiments/coordination/run-code-checks.ts --bundle --platform=node --format=esm --target=node24 --outfile="$coordination_evaluator_build/run.mjs"
node "$coordination_evaluator_build/run.mjs" /path/to/R01/report.json /path/to/new-evaluation /path/to/frozen-baseline
```

[repository-acceptance.ts](./repository-acceptance.ts) first verifies the saved conditions hash, complete delivered file set, artifact hashes, current checkout contents and the lead's signed root result. Failed deliveries stay recorded without an acceptance judgment. Each delivered arm then runs five jobs under the existing repository sandbox: the independent [C1–C8 checks](./r01-acceptance.test.ts), the unchanged original delivery tests, the submitted tests, those same tests with the frozen baseline helper, and ACP TypeScript. All source bytes, effective override hashes, bounded outputs, test reports and runtime fingerprints are recorded. Generation evidence and checkout source are preserved.

The evaluator supplies read-only test/helper overrides through a Vite loader; this capability is absent from the model tool API. It makes no model call. A regression is demonstrated only if the same test list passes on the repair and contains an assertion failure on the baseline. Empty/skipped suites, changed test lists, compilation failures, timeouts and inconsistent reports do not become passes. `codeChecksPassed` combines the eight requirements, original coverage, submitted tests, regression and types. CLI exit 0 means all delivered arms passed these code checks; 2 means incomplete/failing code evidence; 1 means setup/integrity failure.

**Final acceptance remains pending review.** Each arm gets a `review.md` packet and frozen source/test/README copies. Review must confirm the patch's scope, preserved submitted coverage, a regression specifically exercising the second helper call after rejected push, and D1–D8 with citations. A failing baseline test alone does not prove that specific coverage. Preserve disagreements for the designated human maintainer; do not retry judges until they agree. No subnet weights or rewards are produced. Candidate code still shares the test process: these are local development checks, not an attestation suitable for hostile miners.

Calibration on 2026-09-10: the baseline passes C1/C2/C4/C7 and fails C3/C5/C6/C8; a known repair passes all eight. Unsafe branch/force-push/cached-auth and error-leak controls are rejected. A synthetic signed repair passes the complete compiled-verifier flow, including original coverage, baseline regression and types; it is explicitly not a model comparison. Full eval gate: 1,601 passed, one skipped. Evidence: `/private/tmp/fez-r01-evaluator.vL6w74/results.md`. The live R01 run and its resource manifest remain next.

## Check saved code in a local sandbox

On **macOS with Node 24+**, [run-code-checks.ts](./run-code-checks.ts) verifies an existing pilot without more model calls. Run from the repository root:

```sh
coordination_checks_build=$(mktemp -d -t fez-code-checks-build)
./node_modules/.bin/esbuild dev/experiments/coordination/run-code-checks.ts --bundle --platform=node --format=esm --target=node24 --outfile="$coordination_checks_build/run.mjs"
coordination_checks_output=$(mktemp -d -t fez-code-checks)
node "$coordination_checks_build/run.mjs" /path/to/pilot/report.json "$coordination_checks_output/results"
```

The input must be a complete saved pilot for a code task in the current public pack. Regular-file, directory, artifact and pack hash checks precede execution. Results go in a fresh directory; the source pilot stays unchanged. The command first runs trusted isolation checks and verifies that public acceptance tests fail on the starter and pass on the reference. It then runs unchanged acceptance tests against each delivered repair, and submitted regressions against both the repair and starter. Each job retains exact input hashes, exit/signal, bounded stdout/stderr, test summary and elapsed time. `verification.json` binds the observations to the source report's SHA-256.

The deny-default macOS policy allows read-only fixture/runtime access and Apple's loader rules. Network, writes and subprocess creation are denied; inherited environment is cleared. Every process has a five-second timeout, 64 KiB per output stream and a 64 MiB V8 heap setting. Missing sandbox support, failed controls, timeouts, output floods and empty test runs cannot become passes. No unsandboxed fallback exists. The CLI exits 0 when all delivered repairs show passing code checks and red/green regressions, 2 for incomplete/failing observations, or 1 for setup/integrity/control failure.

**Scope:** this observes reviewed local fixtures, not hostile miner submissions. `sandbox-exec` is a deprecated macOS facility; the policy and Apple loader rules are fingerprinted in the report. The heap setting is not a hard total-memory limit, and Node's in-process test reporter can be interfered with by code under test. Consequently, full `accepted` and `assessment` remain null. Process observations require independent review and a stronger evaluator boundary before reward use. A model's earlier claim that it ran tests remains unsupported even when a later verification passes.

After inspecting results, remove the temporary compiled command:

```sh
rm "$coordination_checks_build/run.mjs"
rmdir "$coordination_checks_build"
```

## Rehearse a local Fez handoff

[rehearsal.ts](./rehearsal.ts) exercises the existing Fez `Agent`, `CapabilityClient` and relay using **scripted C01 reference workers**. It calls no model or paid service. Each run creates fresh identities and an in-memory relay bound to `127.0.0.1`; only those identities may publish the permitted task chain. It does not import the desktop's identity or records. The C01 task and reference are public development fixtures.

From the repository root, with installed dependencies (validated on Node 24.20.0):

1. Compile the command. Keep this temporary bundle inside the repository so its existing external dependencies resolve correctly.

   ```sh
   coordination_build=$(mktemp -d dev/experiments/coordination/.rehearsal.XXXXXX)
   ./node_modules/.bin/esbuild dev/experiments/coordination/run-rehearsal.ts --bundle --platform=node --format=esm --target=node20 --packages=external --outfile="$coordination_build/run.mjs"
   coordination_output=$(mktemp -d -t fez-coordination-rehearsal)
   ```

2. Run the three cases. The non-delivery case waits five seconds. Each child output directory must be new; an existing directory is refused.

   ```sh
   for coordination_mode in direct delegated missing-delivery; do
     node "$coordination_build/run.mjs" "$coordination_output/$coordination_mode" "$coordination_mode"
   done
   ```

   | Mode | Expected saved evidence |
   | --- | --- |
   | `direct` | Buyer → lead → buyer; exact reference artifact delivered and fixture checks pass |
   | `delegated` | Buyer → lead → specialist → lead → buyer; parent/child IDs and unchanged artifact retained |
   | `missing-delivery` | Specialist returns its artifact, lead omits the root reply, buyer times out; no delivered artifact or checks |

3. Open the printed `episode.json` paths. Remove only the temporary bundle when finished; keep the output for inspection.

   ```sh
   rm "$coordination_build/run.mjs"
   rmdir "$coordination_build"
   ```

Each episode includes complete signed accepted events with monotonic receipt offsets, public participant identities, the pack hash, root task ID, artifact hashes and fixture-check output. `elapsedMs` measures the buyer's task wait, including specialist work and delivery; it excludes setup and the subsequent local fixture checks. It is transport timing for scripts, not model latency. No model calls occur, but total host cost is unknown, so cost remains null. Private keys are neither written nor printed.

The client validates the expected signer and task/recipient tags. Its optional `timeoutMs` and `signal` stop the local wait and release the subscription; they do **not** cancel remote computation. This rehearsal bounds the root wait at five seconds and the child wait at two seconds; the command has a 30-second process cap. These are rehearsal limits, not the development pack's proposed model-run limits.

Only the exact trusted reference code is written and executed. This is not an untrusted-code sandbox, a native desktop `@fez` run, or a candidate comparison. The returned reference omits the full task's prose deliverable; passing its code checks is not full C01 acceptance. `candidateSha256` and `assessment` stay null; do not convert these episodes into scorer success rows. Live model isolation, provider accounting, blinded assessment and native host integration remain required for a real comparison.

## Run a synthetic comparison

From the repository root, using Node with native TypeScript support (validated with Node 24.20.0):

1. Generate a disposable file of **synthetic assessments**. The repeated-letter hashes are placeholders, not actual instruction/configuration hashes.

   ```sh
   coordination_input=$(mktemp -t fez-coordination)
   node --input-type=module - "$coordination_input" <<'NODE'
   import { writeFileSync } from "node:fs";
   const cases = ["coding", "writing", "combined"].map(family => ({ taskId: family, family, trial: 0 }));
   const inputs = ["a", "b"].map(letter => {
     const manifest = {
       candidateSha256: letter.repeat(64), conditionsSha256: "c".repeat(64), cases,
     };
     const rows = cases.map(c => ({
       ...c, candidateSha256: manifest.candidateSha256, conditionsSha256: manifest.conditionsSha256,
       status: "assessed", quality: letter === "b" ? 1 : 0.9, accepted: true, withinLimits: true,
       elapsedMs: 1000, costMicrousd: 10000, costBasis: "measured", humanInterventions: 0,
     }));
     return { manifest, rows };
   });
   writeFileSync(process.argv[2], JSON.stringify(inputs, null, 2));
   NODE
   ```

2. Print the comparison:

   ```sh
   node dev/experiments/coordination/report.ts "$coordination_input"
   ```

   The `b…b` candidate comes first with quality `1`; `a…a` has quality approximately `0.9`. Both report synthetic cost `30000` micro-USD ($0.03) and summed attempt time `3000` ms. Invalid or incomplete comparisons exit `1`, explain the error on stderr, and print no ranking.

3. Remove the disposable file:

   ```sh
   rm "$coordination_input"
   ```

For a runtime without native TypeScript support, use the repository's installed esbuild (no dependency installation):

```sh
coordination_build=$(mktemp -d -t fez-coordination)
./node_modules/.bin/esbuild dev/experiments/coordination/report.ts --bundle --platform=node --format=esm --target=node20 --outfile="$coordination_build/report.mjs"
node "$coordination_build/report.mjs" "$coordination_input"
rm "$coordination_build/report.mjs"
rmdir "$coordination_build"
```

Run this alternative while the assessment file still exists. The regression test uses this compiled entry point so it also runs on the repository's Node 20 baseline.

## Candidate identity

`readCandidate(bytes)` in [benchmark.ts](./benchmark.ts) accepts non-whitespace UTF-8 Markdown of 1–32,768 bytes, rejects invalid UTF-8 and NULs, and returns `{ sha256, instructions }`. SHA-256 covers the exact bytes, including any BOM and trailing whitespace. Frontmatter is instruction text, never executable configuration.

To identify a real instruction file from the repository root:

```sh
node --input-type=module - ./coordinator.md <<'NODE'
import { readFileSync } from "node:fs";
import { readCandidate } from "./dev/experiments/coordination/benchmark.ts";
console.log(readCandidate(readFileSync(process.argv[2])).sha256);
NODE
```

The reporting command accepts declared hashes; it does not load or authenticate candidate files. A future runner must bind them to the executed instructions.

## Input contract

The JSON file is an array of at least two `{ manifest, rows }` entries with distinct candidates. The exact TypeScript types are exported from [benchmark.ts](./benchmark.ts). Every field below is required; unknown measurements are explicitly `null`, never omitted or zero-filled.

| Manifest field | Required value |
| --- | --- |
| `candidateSha256` | 64 lowercase hex characters identifying exact candidate bytes |
| `conditionsSha256` | 64 lowercase hex characters identifying the declared evaluation conditions |
| `cases` | Nonempty array of `{ taskId, family, trial }` |

Task IDs are non-whitespace strings. Family is `coding`, `writing` or `combined`. Trial is a nonnegative safe integer. Include all three families. Each task has one family and the same set of trials as every other task. Duplicate cases are invalid.

The conditions declaration should identify the task pack/rubrics, coordinator model/version, tool definitions, specialist roster, resource allowances and environment. Prepare it before attempts begin. All candidates in a comparison must declare the same conditions and task/trial schedule. The scorer computes a schedule hash from JSON-encoded, sorted `[taskId, family, trial]` case keys; input order does not change the report.

Each assessment repeats the exact `candidateSha256`, `conditionsSha256`, `taskId`, `family` and `trial`, plus:

| Assessment field | Required value |
| --- | --- |
| `status` | `assessed` or `unavailable` |
| `quality` | Finite number from 0 to 1 when assessed; otherwise `null` |
| `accepted` | Mandatory requirements passed: boolean when assessed; otherwise `null` |
| `withinLimits` | Declared limits respected: boolean when assessed; otherwise `null` |
| `elapsedMs` | Nonnegative safe integer or `null` |
| `costMicrousd` | Nonnegative safe integer or `null`; 1 USD = 1,000,000 micro-USD |
| `costBasis` | `measured` or `estimated` for numeric cost; `unknown` for null cost |
| `humanInterventions` | Nonnegative safe integer or `null` |

Extra, duplicated or mismatched assessment cases are rejected. Non-finite numbers, invalid statuses and unsafe integer measurements/totals are rejected. Account for all specialist and verification calls in an attempt's measurements, including work in failed attempts.

## Reading a report

- Each assessed attempt contributes its quality only if `accepted` and `withinLimits` are both true; otherwise it contributes zero. Candidate-caused failures remain in the denominator.
- Average attempts within each family, then average the three families equally. Adding coding tasks cannot increase coding's family weight. Higher spending, more handoffs and stake confer no score bonus.
- `scoreCandidate` reports `ready: false`, missing/unavailable counts, and null aggregate quality/totals for an incomplete schedule. `compareCandidates` refuses to rank until every candidate is ready. Infrastructure/grader failures require rerunning the affected matched comparison; they must not be hidden as selective omissions.
- Complete schedules can still have unknown measurements. Each total is null if any of its components is null. Any estimated cost makes the known cost total estimated. `totalElapsedMs` sums attempt durations; it is not the experiment's elapsed wall-clock time when attempts run concurrently.
- Results are ordered by descending quality. Equal quality is a tie; lexical candidate-hash order only stabilizes its display. No reward distinction is implied. This scorer reports neither statistical significance nor a causal delegation benefit.

## Verify

```sh
npm test --prefix packages/fez-evals -- tests/coordination-benchmark.test.ts tests/coordination-pack.test.ts tests/coordination-rehearsal.test.ts tests/coordination-model-pilot.test.ts tests/coordination-code-checks.test.ts tests/task-client.test.ts
npx tsc --noEmit --strict --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --allowImportingTsExtensions dev/experiments/coordination/*.ts
```

The transport and task-client checks start temporary local relays. Model-pilot regression tests use a local HTTP fixture; they never call a real model.

Live attempt, 2026-09-10: the authorized Chutes pilot reached the provider, but all three requests returned HTTP 402. An authenticated account check confirmed a negative balance and no active subscription. No completion, generated artifact, usage total or quality result exists. Local evidence: `/private/tmp/fez-chutes-live.qfXWfe/results.md`.

Funded retry, 2026-09-10: the same frozen conditions produced three HTTP 200 responses for $0.008118 in estimated model-token costs. Solo delivered files in 8.081 s; fixed workflow failed on fenced JSON after 21.791 s; adaptive failed on malformed JSON after 5.579 s without delegating. All three asserted passing tests despite no execution capability. No specialist result reached the lead, and no acceptance or delegation-benefit result exists. All 23 event signatures and delivered artifact hashes verify. Local evidence: `/private/tmp/fez-chutes-retry.GU0XOn/results.md`.

JSON-mode pilot, 2026-09-10: all three arms delivered files with five calls and $0.018837 in estimated model-token costs. Solo took 6.981 s, fixed workflow 72.585 s, adaptive 10.784 s. The fixed workflow completed coder/reviewer handoffs but repeated unsupported test-pass claims. Adaptive chose direct work and correctly reported no execution, while misnaming its null-prototype object as a Set. All 25 event signatures, delivered hashes and unchanged inputs verify. No code acceptance or delegation advantage is established. Local evidence: `/private/tmp/fez-chutes-json-mode.STCUFl/results.md`.

Saved-code verification, 2026-09-10: all three C01 repairs passed the unchanged public acceptance tests. Every submitted regression failed on the starter and passed on its repair. The trusted isolation/starter/reference controls passed; all 12 jobs' input hashes and the unchanged source report verify. Later tests do not validate earlier claims of execution. Full task acceptance and quality remain ungraded. Local evidence: `/private/tmp/fez-code-verified.YEpalE/results.md`.

X01 mixed pilot, 2026-09-10: four calls cost $0.021651 in estimated model tokens. Solo delivered in 18.076 s; its repair passed public checks and its operator note passed a provisional local review. Adaptive delivered in 5.692 s without delegating; code passed, but its note attributed the credit to the importer without source support. Both submitted regressions failed on the starter and passed on the repair. Fixed workflow stopped after 132.943 s at the writer's HTTP-200 response (`missing model answer`), after a successful coder handoff; no final result was delivered. All 25 event signatures, artifact/input hashes and nine sandbox jobs verify. Review used anonymous labels but the same assistant, not an independent evaluator. X01 shares C01's scenario; no general delegation advantage or complete benchmark ranking follows. Local evidence: `/private/tmp/fez-x01-pilot.xk7stI/results.md`.

Writer diagnosis, 2026-09-10: the exact request reproduced null final content with all output classified as reasoning. Disabling thinking restored visible JSON but produced a forbidden specialist `revise` action; removing JSON mode or changing temperature each exhausted the reasoning budget without final text. Four probes cost $0.040712 estimated model tokens. Local envelope replays through the real runner confirmed both rejection paths and a logging gap: stop reason is recorded only after the final-content assertion. No complete fix is validated. Evidence: `/private/tmp/fez-writer-diagnosis.is8Loe/diagnosis.md`.

Writer repair validation, 2026-09-10: version 3 adds per-model thinking settings, role-specific action instructions and preserved stop/reasoning-token metadata. Five expected test failures reproduced before the fix; all 21 model-pilot tests, root/strict TypeScript and the full eval gate subsequently passed (1,542 tests, one skipped). One live writer call with the archived coder draft returned valid submitted artifacts through Fez in 18.931 s for $0.004281 estimated model tokens. The other five model replies were simulated; this is an integration check, not a fresh benchmark. The writer copied all three coder artifacts unchanged. Evidence: `/private/tmp/fez-writer-fix.pmHKj0/results.md`.

X01 version-3 live comparison, 2026-09-10: solo and adaptive passed public code checks, demonstrated regressions, and passed provisional local writing review. Solo took 17.090 s/$0.001769; adaptive worked directly in 4.496 s/$0.001886. Fixed workflow failed after 127.971 s/$0.014342 when its coder reached the 4,096-output-token limit (3,680 reasoning tokens); the writer was never invoked. Three live requests cost $0.017997 estimated model tokens. No simulated replies or retries. All 23 signatures, six artifact hashes, nine sandbox jobs and unchanged inputs/report verify. Writing review used anonymous labels with the same assistant; it was not independent. No delegation benefit or general ranking follows. Evidence: `/private/tmp/fez-x01-v3.wU0Tuz/results.md`.

X06 version-3 live comparison, 2026-09-10: all three approaches delivered code that passed 3/3 public checks and regressions that failed 3/3 on starter and passed 3/3 on repair. Solo passed provisional combined acceptance in 5.064 s/$0.001583; adaptive passed in 7.420 s/$0.001475 without delegating. Fixed coder → writer → reviewer → lead completed in 108.396 s/$0.020688 but retained a runbook instruction to push existing committed artifacts whenever a checkout is preserved, including failed-commit and cleanup-only states. The coder introduced that instruction; writer, reviewer and lead retained it. Six live calls cost $0.023746 estimated model tokens. All 27 signatures, nine artifact hashes, 12 sandbox jobs and unchanged inputs/report verify. Model settings and budgets match X01; only task ID changed. Review used anonymous labels with the same assistant, not independent grading. No delegation benefit is established. Evidence: `/private/tmp/fez-x06-v3.un3UL2/results.md`.

X06 separate-model review, 2026-09-10: Gemma 4 31B Turbo, absent from the generation team, assessed one anonymous submission per fresh request without prior judgments, workflow labels or other submissions. It accepted all three, agreeing on solo/adaptive but disagreeing with the assistant's fixed-runbook rejection. Fixed acceptance is now explicitly disputed; both judgments are preserved and no authoritative score is assigned. Three calls took 55.934 s and cost $0.000884 estimated model tokens; generation plus review totals $0.024630, excluding operator/local verification costs. Frozen request/model/usage and original-evidence hashes verify. This is separate-model review on the same provider, not human adjudication. Evidence: `/private/tmp/fez-x06-independent.N7fVtI/results.md`.

Selected repository task, 2026-09-10: [R01](./REPOSITORY-TASK.md) repairs the actual `deliverHire` retry path and documents operator recovery. A local bare-remote reproduction confirms that retrying after a rejected push fails at an unnecessary commit; all four existing tests pass because their recovery bypasses the helper. The candidate must return a source/test/README patch against a declared repository snapshot. State-specific code and prose requirements and human dispute handling are fixed before attempts; prior X06 judgments remain unchanged. Evidence: `/private/tmp/fez-repository-task.j9JgKF/contract.json`. No candidate generation or production edit occurred.

R01 checkout preparation, 2026-09-10: the reconstructed snapshot passed the full build (core + 43 packages), root/ACP TypeScript and 1,395 evals with one skipped. Three copies with separate Git directories share the same snapshot and dependency-lock fingerprints. Each passes the original four delivery tests and ACP typecheck, and reproduces the failed retry through its own helper. All dependency links resolve within each copy; the shared source checkout is unchanged. This is working-state separation, not an OS sandbox. No candidate inference ran. Evidence and checkout paths: `/private/tmp/fez-r01-workspaces.zz6pbp/results.md`.

R01 repository-tool integration, 2026-09-10: the existing runner now supports bounded source reads/writes and named sandboxed checks for leads and specialists. Local HTTP fixtures verify shared edits, signed delivery hashes, patches and cost accounting. All three prepared checkouts pass the original four Git tests and ACP types inside the sandbox and retain unchanged source. No live R01 inference ran. Evidence: `/private/tmp/fez-r01-tools.Ri51JL/results.md`.

R01 evaluator calibration, 2026-09-10: independent C1–C8 checks reject the baseline and unsafe controls, accept a known repair, and bind evaluation to signed delivered source. Original coverage, candidate regressions against the baseline and types are checked separately; source/test/README review remains required for final acceptance. A synthetic signed control passed the complete verifier. No live model calls ran. Evidence: `/private/tmp/fez-r01-evaluator.vL6w74/results.md`.

First live R01 comparison, 2026-09-10: the frozen $12 allowance provided 24 calls, 8,192 output tokens per call, 128,000 request bytes and 600 seconds per arm. All three attempts failed before delivery. Solo exhausted 24 calls in 135.182 s/$0.185973, including nine no-op writes; its unsubmitted helper fails seven of eight independent checks and ACP types. Fixed stopped after three coder calls in 297.731 s/$0.055474 when all 8,192 output tokens were reported as reasoning and final content was missing. Writer/reviewer/lead generation never started. Adaptive exhausted 24 calls in 43.696 s/$0.155015, making one list and 23 reads without edits or delegation. Total estimated token cost: $0.396462; no documentation-review calls were needed. All 23 signatures, 50 tool observations, costs, source/report hashes and dependency-lock fingerprints verify. The baseline and shared source are unchanged. No accepted result or delegation advantage was demonstrated. Evidence: `/private/tmp/fez-r01-live.7lIKQ2/results.md`.

R01 trace review, 2026-09-10: two offline replays match all 51 recorded requests (normalizing only fresh handoff identifiers), final source and failures. Every feedback prefix and read/write hash is correct. A scripted read/edit/submit control delivers through all three workflows. GLM’s third response reaches the 8,192-output-token limit entirely in reported reasoning; its generic missing-answer error obscures the stored stop reason. DeepSeek’s loop cause remains unproven: all turns use two-message JSON summaries, no explicit remaining budget, and 17 solo turns repeat starting source beside newer state. Adaptive never edits, so stale source alone cannot explain its 19 consecutive identical reads. Zero paid calls or implementation changes. Evidence: `/private/tmp/fez-r01-traces.wNaiHC/diagnosis.md`.

R01 feedback-format probe, 2026-09-10: six live DeepSeek continuations cost $0.032040 estimated model tokens. Starting from the same saved adaptive call-6 context, flat JSON repeated the helper read three times (3.834 s/$0.015825); chronological assistant-action/user-result messages read README, tsconfig and tests (3.941 s/$0.016215). README was already in starting source and the test read repeated history; only tsconfig added a previously absent file. Neither branch edited, checked, delegated or submitted. The offline control and all live request/source/cost evidence verify; original R01 evidence is unchanged. This changes the observed read sequence but does not prove a repair loop or justify a production change. Evidence: `/private/tmp/fez-r01-format.BYjtOh/results.md`.

Tiny repository interaction, 2026-09-10: the same DeepSeek lead completed a cleanup-warning change and regression test in seven calls/29.069 s/$0.013885 estimated model tokens. It read both files, wrote both, ran 4/4 delivery tests and ACP types successfully, and submitted an accurate explanation. A frozen independent oracle passed 4/4 on the candidate; the submitted regression failed on the original helper. Local diff review accepted the requested scope. Chronological feedback used a fresh smaller task, no duplicated starting source and explicit limits, so this is a capability smoke test rather than a causal format comparison or R01 retry acceptance. All evidence and unchanged baseline/shared source verify. No production code changed. Evidence: `/private/tmp/fez-tiny-loop.M5ICC1/results.md`.

Full R01 interaction diagnostics, 2026-09-10: DeepSeek repeated 18 unchanged writes and failed after 24 calls/119.810 s/$0.116296. A two-call thinking-switch probe cost $0.016484; the enabled request exhausted 8,192 output tokens with empty final content and unavailable reasoning subtotal. Kimi K2.6 with thinking disabled then generated a helper that passes all independent C1–C8 checks and ACP types, but its own divergence fixture fails, README is unchanged, and no successful delivery exists. It stopped after 19 calls/498.616 s/$0.189759 when the next request reached 129,653 bytes. An offline compact-check-feedback prototype reduces that request to 94,499 bytes while preserving all test assertions/failures; it is not a live or production fix. Source, signatures, costs and original evidence verify. Cumulative R01 and diagnostics: $0.764926 estimated model tokens. Evidence: `/private/tmp/fez-r01-loop.3MpqWf/results.md` and `/private/tmp/fez-r01-kimi.AlHH9T/results.md`.

Two assisted Kimi continuations, 2026-09-10: compact test feedback passed a real-tool/signed-transport control, but the retained-history continuation made one test edit and two unchanged writes before a 133,080-byte request exceeded its cap (6 calls, 224.309 s, $0.125390). A separately frozen current-source checkpoint began at 33,742 bytes and omitted old edits. It used 12 calls/52.625 s/$0.129032 on eleven reads and one listing, with no edits or submission. The relevant `deliverHire` caller was already visible by call 7; missing search alone cannot explain continued reading. Both independent evaluations retain C1–C8, original coverage and ACP types passing, candidate suite 9/10, unchanged README and no acceptance. These are assisted continuations, not independent trials or retroactive passes. Combined Kimi effort: 37 calls, 775.550 s, $0.444181. Cumulative R01 and diagnostics: **$1.019348 estimated token charges** within the original $12 authorization. No paid run is active. Evidence: `/private/tmp/fez-r01-resume.DQDj0P/results.md`, `/private/tmp/fez-r01-checkpoint.GlaGQ0/results.md`.

Native pi R01 diagnostic, 2026-09-10: the bundled engine used native read/edit/write/search plus the existing restricted test/type tools, with the provider key held only by a local proxy. Offline transport, sandbox-boundary and limit controls passed. A fresh original-snapshot attempt stopped at its 128,000-byte request cap after nine calls/457.693 s/$0.133515 with a broken Buffer conversion and no final answer. A separately frozen retained-session continuation used a verified context hook, 256,000-byte cap and eight further calls: it fixed the helper and fixture, observed 10/10 candidate tests and ACP types passing, but spent its final call reading back files and did not submit. Independent C1–C8, original coverage and baseline regression all pass on that saved patch. Continuation cost: $0.178751/65.593 s. Both original failed episodes remain failed. Evidence: `/private/tmp/fez-r01-pi.gJNDtE/results.md`, `/private/tmp/fez-r01-pi-resume.9d5qpV/results.md`.

Assisted R01 final delivery, 2026-09-10: one separately frozen terminal Kimi call received saved files/test observations and operator D4/D8 documentation feedback. It edited only README and delivered all three files plus a verification record through signed local Fez transport (49.825 s/$0.007399). All independent code checks, candidate 10/10, original 4/4, baseline regression and ACP types pass on the exact signed source. No specialist or handoff occurred; the answer’s “specialist-submitted” attribution is inaccurate and preserved. Local review accepts D1–D7 but rejects D8’s missing explicit remote-divergence correction instruction. One anonymous Gemma call returned raw all-pass judgments (28.812 s/$0.001280), but its nonliteral quotations failed the frozen exact-excerpt validator; no model review is admitted. Full acceptance remains unavailable, with the raw D8 disagreement awaiting maintainer adjudication. No judge rerolls or retrospective grading changes. The finalization/review pair stayed within its frozen $0.20 cap. All source/manifest/report hashes, costs, signatures and dependency locks verify. Evidence and proposed unapplied wording: `/private/tmp/fez-r01-finalize.8j9v5kym/results.md`, `/private/tmp/fez-r01-finalize.8j9v5kym/adjudication.md`.

The native episodes, finalization and review total 19 model requests, 601.923 seconds of summed active run/review time and $0.320945 estimated tokens; this excludes operator pauses, offline preparation and independent verification. Cumulative R01 and diagnostics: **$1.340293 estimated token charges** within the original $12 authorization. No paid run is active. This is an assisted delivered code-correct artifact, not a fresh autonomous accepted baseline, matched comparison or coordination gain.

Current app result: completion and acceptance are implemented and installed. One fresh request to `@fez` produced a signed specialist speech result, automatic coordinator callback, checked WAV, requester-signed acceptance chit, and final delivery in the original thread: 74 seconds, no operator retry. The 12.09-second audio and all six event signatures verify. Full gate: 1,667 passed, five skipped. Model usage remains unreported. These records distinguish specialist delivery from coordinator acceptance; they do not constitute a public reputation score or user listening verdict. Preserve R01’s unresolved documentation result without treating it as an alpha prerequisite. Comparative miner scoring, emission incentives and hostile-worker evaluation remain later work. See the [capability demonstration](./CAPABILITY-DEMO.md) and [selected design](../../../docs/superpowers/specs/2026-09-10-coordination-miners-design.md).
