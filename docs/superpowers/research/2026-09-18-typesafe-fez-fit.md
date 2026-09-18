# TypeSafe AI / Jev: fit for Fez

Reviewed September 18, 2026 against primary documentation and the current Fez working tree. No inference requests, installation, signup, benchmark run, or production changes were performed. Recommendations below are engineering judgments, not measured improvements.

Subsequent work: the user authorized a skill installation and live trial. See
[measured routing results](./2026-09-18-typesafe-routing-results.md); the assessment
below records the earlier research before that trial.

## Recommendation

Trial Jev as an optional semantic routing backend for `@fez`, using the existing routing benchmark first. Its bounded choices and answer distributions fit deciding which available agent should handle a request. Adoption depends on better routing outcomes at acceptable end-to-end latency; structured outputs alone do not establish superiority.

Keep the integration inside the existing orchestrator/benchmark packages. No new Nostr event kind, relay dependency, Python service, or general evaluation framework is needed for this experiment.

## What it supplies

Jev accepts state plus typed questions. Choice selects among named alternatives; Score evaluates an ordered rubric; Noul expresses belief in a yes/no proposition. Questions in one request independently share the same state. Answers can be combined in code, but dependent questions require another call. These are narrow judgments rather than free-text agent responses. [Primitives](https://docs.typesafe.ai/primitives), [API reference](https://docs.typesafe.ai/api).

The HTTP endpoint is `POST https://api.typesafe.ai/v1/systemone`, with bearer authentication and `{ state, model, questions }`. There is a [JavaScript/TypeScript SDK](https://docs.typesafe.ai/sdk/javascript), but Fez's native `fetch` is sufficient. This is not a URL-only swap: Fez currently sends OpenAI chat-completion tool schemas and reads tool calls. A small adapter must translate roster descriptions into Choice criteria and validate returned selections. [Quick start](https://docs.typesafe.ai/introduction/quickstart), [current router](/Users/ken/Projects/Fez/fez/packages/fez-orchestrator/src/orchestrator.ts:327).

Current model `jev-1.13.0` costs $0.042 per million input tokens, with free output. At an illustrative 2,000 billed tokens per request, 1,000 requests cost $0.084, excluding retries and fallback calls. This is arithmetic from published pricing, not measured Fez usage. Pin the version while evaluating; `jev-latest` moves. The model is text-only, with 64k total input and 32k for state plus the longest question. The general primitives page still gives an approximate 32k combined limit; prefer model-specific documentation and check boundaries before production. [Models](https://docs.typesafe.ai/models).

## Ranked Fez uses

| Priority | Proposed use | Practical benefit and limit |
|---|---|---|
| First | Choose an agent, including `none` | Compare a bounded roster; use measured uncertainty thresholds to abstain or invoke a fallback. Does not establish permission to act. |
| Later | Rank skill or retrieved-context candidates | Evaluate relevance before sending full descriptions to the main agent. Pursue only if current selection has measured failures or excess context. |
| Later | Flag incomplete or off-topic work for review | Rubric judgments can provide advisory feedback. They cannot establish that code ran, tests passed, a deliverable is true, or a requester accepted it. |

These uses map to the documented primitives; the ordering is our assessment of Fez's existing needs. [Choice](https://docs.typesafe.ai/primitives/choice), [Score](https://docs.typesafe.ai/primitives/score).

The current orchestrator already filters routable agents, provides a no-fit option, handles explicit actors before model inference, and forwards the original request in a signed summon. Preserve those behaviors. Its `route()` currently accepts multiple returned tool calls, whereas one Choice selects one candidate; make that behavior explicit in any trial. [Roster and route](/Users/ken/Projects/Fez/fez/packages/fez-orchestrator/src/orchestrator.ts:312), [explicit actor path](/Users/ken/Projects/Fez/fez/packages/fez-orchestrator/src/orchestrator.ts:535).

## Constraints that affect adoption

**Confidence is not correctness.** Choice/Score confidence is computed from how concentrated their answer distribution is. It is not a documented probability that a Fez route is correct. Tune thresholds on labeled examples, then evaluate on separate held-out cases; a confident wrong answer remains possible. [Confidence](https://docs.typesafe.ai/confidence).

**Untrusted messages can steer it.** TypeSafe explicitly documents vulnerability to injected instructions and misleading state, plus weaknesses with numeric precision, date comparisons, indirect questions, and irrelevant context. Preserve deterministic membership, attestation, cancellation, and permission checks. Keep signed completion/acceptance semantics in the existing client; a model score is advisory. [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13), [Fez work acceptance](/Users/ken/Projects/Fez/fez/packages/fez-client/src/work-completion.ts:59).

**It adds hosted processing.** The published policy says customer inputs are not used for training and describes US hosting, but standard retention is necessity-based rather than zero by default. Enterprise zero retention requires an arrangement. An optional provider should send only the request and candidate descriptions needed for the decision. No self-hosted/offline model distribution was established by this review. [Privacy policy](https://typesafe.ai/legal/privacy-policy), [enterprise data handling](https://docs.typesafe.ai/legal).

**Budget total latency explicitly.** SDK defaults include a ten-second timeout per attempt and two retries; Retry-After can extend waits further. A router needs a bounded request budget and defined timeout/error/invalid-response fallback. Vendor speed claims do not establish Fez's latency or accuracy. [Client configuration](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig), [retry policy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy).

## Smallest useful experiment

1. Add a bench-only HTTP adapter using a pinned model and the existing roster descriptions, with an explicit `none` choice. Use public fixture messages first. Keep keys in the Node process and validate selections against the supplied candidates.
2. Reuse the existing labeled routing battery, including adversarial, no-fit, ambiguous, and name-as-content cases. Preserve the same deterministic prelayers for a fair comparison. The current runner requires OpenAI `/models` and `/chat/completions`, so it needs a small adaptation; the existing environment URL alone will not run Jev.
3. Compare accuracy, over-routes, under-routes, and wrong-agent choices using existing scoring. Also measure p95, abstention versus accepted-decision error, and actual token cost. Existing scoring measures router-only p50; total latency with fallback should be measured separately. Keep live-roster coverage distinct from labeled accuracy.
4. Only if results justify adoption, share the adapter between production and bench, retain the current provider as a configurable fallback, and add protocol-compatible opt-in configuration. Keep required evals deterministic; a paid live endpoint should not become a mandatory test dependency.

Sources: [benchmark runner](/Users/ken/Projects/Fez/fez/packages/fez-bench/src/runner.ts:39), [labeled cases](/Users/ken/Projects/Fez/fez/packages/fez-bench/src/cases.ts:55), [scoring](/Users/ken/Projects/Fez/fez/packages/fez-bench/src/core.ts:34), [live roster coverage](/Users/ken/Projects/Fez/fez/packages/fez-bench/src/score.ts:7).

Allow approximately 2–4 engineering hours for the first comparison, assuming an API key and a reachable baseline router. This estimate excludes production integration and threshold calibration on representative held-out traffic.
