# TypeSafe live routing trial — September 18, 2026

**Deployed September 18, 2026: TypeSafe is the default hosted routing model,
with the existing Qwen model retained as fallback.**

The owner requested a default rollout rather than an optional pilot. The live
gateway uses the same TypeSafe request and validation implementation as this
benchmark; no per-user enablement is needed for hosted-router clients.

TypeSafe Jev `jev-1.13.0` completed the existing frozen Fez routing battery in one
live pass. The integration used the existing agent descriptions, no-fit option,
deterministic prelayers, and agent-name scrubbing. No confidence threshold or
automatic retry was applied, and no fixture-specific prompt tuning followed the
results.

| Measure | TypeSafe `jev-1.13.0` | Hosted baseline `fez-router` |
|---|---:|---:|
| Full pipeline accuracy | 96/97 (98.97%) | 92/97 (94.85%) |
| Model-only accuracy | 80/81 (98.77%) | 76/81 (93.83%) |
| Deterministic cases, no API call | 16/16 | 16/16 |
| Unnecessary summons | 0 | 0 |
| Incorrect declines | 0 | 5 |
| Wrong agent selections | 1 | 0 |
| Model-call latency, median / p95 | 184 ms / 284 ms | 2,808 ms / 9,910 ms |
| API calls | 81 | 81 |
| Input / output tokens | 43,118 / 4,362 | Not collected |
| Estimated API cost | $0.001811 | Self-hosted; per-call cost not measured |

Source: [complete raw results](./2026-09-18-typesafe-routing-results.json).
Cost uses the published $0.042 per million input tokens and free output, rather
than an invoice. [TypeSafe pricing](https://docs.typesafe.ai/models).

## The failure matters

Input: “researcher found three candidate libraries — review which fits us best”

Fez's shared preprocessing sent: “a teammate found three candidate libraries —
review which fits us best”. The fixture expects `reviewer`; Jev selected
`researcher` with probability 0.87 and confidence 0.82.

The choice overlaps the researcher's description, but it fails the existing
fixture and is counted as a failure. Confidence cannot be used as proof of a
correct route. Some correct choices had lower confidence, including an ambiguous
case at 0.39. Do not tune a production threshold to remove this single observed
mistake; use separate calibration and held-out cases.

## Authenticated comparison

The initial baseline attempt returned HTTP 401 because the benchmark did not load
the hosted gateway's credential. Read-only inspection through existing SSH access
confirmed both services were healthy and `ROUTER_API_KEY` was set in
`/etc/fez-router.env`. The deployment README's statement that the service was open
was stale and has been corrected.

The follow-up used that credential only in the benchmark process's memory and
supplied it through the existing `FEZ_ORCHESTRATOR_KEY` mechanism. No server
configuration or permissions changed. Requests were spaced at least 3.2 seconds
apart to respect the configured 20-request/minute limit. Reported latency excludes
those deliberate pacing waits. The baseline used the existing `tools` profile,
temperature zero, 96-token cap, identical roster/cases/prelayers, and the model ID
returned by the server: `fez-router`.

TypeSafe handled five cases the baseline incorrectly declined; the baseline
handled the one case TypeSafe misrouted. That is a net gain of four correct
decisions, or 4.12 percentage points, in this sample. TypeSafe's median latency
was 15.26 times faster; its p95 was 34.89 times faster.

The baseline's five misses were “tear apart my draft README”, “would you approve
this pull request?”, “find the release notes format and cut the release”,
“reviewer signed off, ship it”, and “get it live”. Each returned no agent.

The local `@fez` persona on this machine uses `harness: claude-code`, with no
router URL configured. This comparison establishes performance against Fez's
separate hosted routing service, not against a complete Claude Code agent turn.

This is one run per provider against 97 public prompts and a frozen roster of three agents.
All seven existing adversarial cases passed, but that small sample does not
establish prompt-injection resistance or performance on private workspace
traffic, larger rosters, other languages, or repeated runs.

## What was installed and built

The upstream TypeSafe skill was installed for Codex in this project using
`npx skills add typesafe-ai/skills --skill typesafe-ai --agent codex --yes`.
The installer recorded its source hash in `skills-lock.json`.

The benchmark gained a native-fetch TypeSafe adapter and an opt-in CLI. It reuses
the baseline's routing prelayers and scoring, validates responses, caps each
TypeSafe request at five seconds, and stops on service errors. Baseline HTTP
errors also now stop rather than accidentally score as correct no-fit choices.
At the end of the initial benchmark, production routing was unchanged. The
subsequent hosted-router rollout is recorded below.

The API key was used from a temporary file with mode 0600, never included in
reports or repository files, and removed after the live run.

## Initial benchmark verification

- Full `npm run evals`: 298 files passed, 6 skipped; 2,557 tests passed, 12 skipped.
  Local socket access was required for the test relays; the restricted-sandbox
  attempt was stopped and rerun with that access.
- Latest focused run: all 13 TypeSafe checks and 17 routing-prelayer checks passed.
- Root and `packages/fez-bench` TypeScript checks passed.
- Benchmark package build and changed-file whitespace checks passed.

See [benchmark usage](../../../packages/fez-bench/README.md#typesafe-comparison-opt-in).
The next meaningful measurement is held-out examples from the intended agent
roster. The four-decision advantage in this small sample does not establish
universal routing superiority, while the observed latency difference is large.


## Default hosted-router rollout

The DigitalOcean `fez-router` droplet now runs the TypeSafe gateway at the existing
`https://137-184-135-188.sslip.io/v1` endpoint. TypeSafe hosts Jev; DigitalOcean hosts
our authenticated adapter and local Qwen fallback. The pinned primary model is
`jev-1.13.0`, with one API attempt and a two-second timeout before local fallback.
Valid `nobody` decisions are not retried against Qwen. Richer tool schemas or
custom conversation instructions continue through the local model.

The gateway credential was preserved. The TypeSafe key was transferred through
SSH stdin with terminal echo disabled and stored in root-owned mode-0600
`/etc/fez-router.env`; no key is included in source or these reports. The old
configuration and gateway were backed up before deployment. Only the gateway
was restarted; local Qwen remains active.

The deploy script bundles the shared TypeScript client, verifies local fallback
readiness, and requires a successful authenticated TypeSafe selection after
restart. It restores the previous gateway if its check fails.

The public smoke test verified authentication is still required, `/v1/models`
still exposes `fez-router`, and research, review, deployment, and no-match requests
all returned the expected selection with `X-Fez-Router-Backend: typesafe` and
model `jev-1.13.0`. End-to-end latencies were 393, 197, 267, and 188 ms. These four
checks prove deployment behavior, not an additional accuracy benchmark.
[Raw deployment checks](./2026-09-18-typesafe-rollout-smoke.json).

The 2-vCPU/2-GB droplet is billed to DigitalOcean team “Kens Team” at a listed
$18/month. That fixed infrastructure cost continues alongside TypeSafe API usage.
This changes the hosted routing service; the local `@fez` Claude Code persona
and the models doing specialists' work remain separately configured.

Final verification:

- Full `npm run evals`: 305 files passed, 6 skipped; 2,615 tests passed, 12 skipped.
- All 29 TypeSafe adapter/gateway checks passed, including service failure,
  timeout, malformed response, both orchestrator request profiles, richer-schema
  fallback, authentication, and special object-key candidate validation.
- Root, orchestrator, benchmark, and focused TypeSafe-test TypeScript checks
  passed; benchmark/orchestrator builds and deployment shell syntax passed.
- The additional whole-evals-package typecheck reports errors outside this
  change in desktop, extension, Deno, and older test files; it is not clean.
- Independent review found two edge cases (schema-valued `additionalProperties`
  and `__proto__` probabilities). Both were reproduced with failing tests,
  corrected, and confirmed by the reviewer before deployment.
