# Running the fez router

The router is the endpoint `@fez` asks "who should take this?". It
exists so fez works with **nothing installed** — no brew, no model
download, no local inference.

Live: **`https://137-184-135-188.sslip.io/v1`** (DigitalOcean, 2 GB
droplet `fez-router`, nyc1, $18/mo).

## Why this is a separate box from the relay

The relay holds the only copy of a community's history and its own
README is emphatic that memory, not disk, is its constraint. A 400 MB
model next to it trades "routing is slow" for "the community is gone".
They share nothing but a region.

## Primary model and fallback

TypeSafe is the live default as of September 18, 2026.
With `TYPESAFE_API_KEY` configured, the gateway calls TypeSafe’s hosted
`jev-1.13.0` model for every ordinary Fez routing request. The model runs at
TypeSafe, not on this droplet. The gateway returns the same OpenAI tool-call
response, so clients keep their existing URL, model alias, and gateway key.

An API error, invalid response, or two-second timeout falls back to local
Qwen3-0.6B under llama.cpp. A valid `nobody` decision is final. Requests with
conversation history, custom system instructions, or richer tool arguments
also use Qwen because the TypeSafe adapter only selects an agent. Existing
roster permissions and deterministic routing rules remain in the client.

The [September 18 comparison](../../docs/superpowers/research/2026-09-18-typesafe-routing-results.md)
scored TypeSafe 96/97 versus Qwen 92/97, with model-call medians of 184 ms
and 2,808 ms. This was one pass with three agents, not a universal guarantee.
The droplet still costs $18/month; TypeSafe API usage is additional.

## Local fallback history: cactus + needle

You can't run it here. cactus ships wheels for macOS-arm64 and
linux-aarch64 only, its kernels are ARM NEON, and DigitalOcean has no
ARM droplets. That isn't awkward, it's impossible — which is why the
local fallback runs Qwen3-0.6B under llama.cpp instead.

The swap is not a downgrade: measured on the 97-case battery, needle
scores 71% and Qwen3-0.6B with the right request shape scores 90%. See
the orchestrator README for the full table and the profile it needs.

## First time

```bash
doctl compute droplet create fez-router --image ubuntu-24-04-x64 \
  --size s-2vcpu-2gb --region nyc1 --ssh-keys <id> --wait
ssh root@<ip> 'HOSTNAME_FOR_TLS=<ip-with-dashes>.sslip.io bash -s' < deploy/router/provision-router.sh
deploy/router/deploy-router.sh root@<ip>
```

`provision-router.sh` does system setup — swap, a prebuilt llama.cpp
(nothing is compiled on the box), the model, Caddy, ufw — and is
idempotent. `deploy-router.sh` ships only the gateway and the units, so
gateway updates do not reprovision the machine. It bundles the shared TypeSafe
client locally with esbuild, stages one dependency-free file, and verifies an
authenticated routing request after restarting the gateway. A failed check
restores the previous gateway. Qwen is not restarted during a gateway update.

## The shape of it

```
internet ──443──> caddy ──> gateway :8081 ──HTTPS──> TypeSafe API
                                  └──fallback──> llama-server :8080
                                                    (loopback only)
```

`llama-server` never faces the internet. The gateway is the only public
surface. It authenticates and rate-limits calls to either model; token and
sampling limits apply to local inference:

| policy | why |
| --- | --- |
| `RATE_PER_MIN=20` per IP | bounds client load; a tiny model is cheap but not free |
| `RATE_BURST=2` | one model slot — concurrency just makes everyone wait for the same cores |
| `MAX_TOKENS=96` | a 4096-token request is a 90-second CPU hold. Measured: 96 scores the same as 512 |
| `temperature: 0` | pinned server-side, so two identical mentions can't route differently |

Only `/v1/models` and `/v1/chat/completions` are routed. `/slots`, the
web UI and `/completion` return 404 — this is a routing appliance, not a
public playground.

**The live deployment requires authentication** (verified September 18, 2026).
`ROUTER_API_KEY` is configured in `/etc/fez-router.env`, which the gateway service
loads. Clients and benchmarks must supply the matching `FEZ_ORCHESTRATOR_KEY`;
SSH access alone does not authenticate a separate HTTP request.

The gateway code permits an open deployment when `ROUTER_API_KEY` is unset, but
that default does not describe the current server. Update the key in the existing
environment file and restart `fez-router-gateway` when rotating it; do not remove
authentication to run a benchmark. Pace benchmark calls within the configured
rate limit.

## Server credentials

Keep `/etc/fez-router.env` owned by root with mode `0600`. Preserve the existing
`ROUTER_API_KEY`; add `TYPESAFE_API_KEY` there using the server's secret-management
workflow. Optional settings are `TYPESAFE_MODEL=jev-1.13.0` and
`TYPESAFE_TIMEOUT_MS=2000`. Restart `fez-router-gateway` after changing them.
The TypeSafe key never goes to Fez clients. Removing it and restarting restores
Qwen as the primary model without changing client configuration.

`/health` reports the configured primary model, not a provider availability probe.
Authenticated completions include `X-Fez-Router-Backend: typesafe` or `local` to
show which backend actually answered, and `X-Fez-Router-Confidence` when TypeSafe
did. `/v1/models` keeps the stable `fez-router` alias and remains available
during a local-model outage when TypeSafe is enabled.

## Judge route

`POST /v1/judge` passes TypeSafe's own `{ state, questions }` shape through to
Jev and returns its `answers` and `usage` unchanged. Question types are `noul`,
`choice`, and `score`; at most 32 questions per call; same bearer key and
per-IP limit as routing. There is no local fallback: a 5xx means the caller
should do whatever it did before it had a judge. `JUDGE_TIMEOUT_MS` (default
5000) bounds the call. Each call logs question names, tokens, and latency,
never content.

Agents reach it through `askJudge` in the orchestrator's TypeSafe client. The
first consumer is the thread governor in fez-acp: a persona with
`judge: <router url>/v1` and `judgeKey: <router key>` in its frontmatter (or
`FEZ_JUDGE_URL` / `FEZ_JUDGE_KEY` in the environment) asks three yes/no
questions before a fellow agent's mention costs a harness turn, and skips
turns that would only acknowledge or re-answer a resolved thread. The
governor never applies to the owner's messages or to assignment/result
events, and a judge failure runs the turn as before. Raise `RATE_PER_MIN`
on the box once agents use it; routing traffic alone was sized for 20/min.

## Operating it

```bash
systemctl status fez-router          # the local fallback
systemctl status fez-router-gateway  # TypeSafe integration + policy
journalctl -u fez-router -f
curl https://137-184-135-188.sslip.io/health
```

The following sizing notes concern only the local Qwen fallback.

**Context size is a memory decision.** Qwen3-0.6B costs ~114 KB of KV
cache per token, so `-c 8192` allocates ~940 MB — more than the model.
That was the first configuration here and it put the box 524 MB into
swap, where generation ran at 6 tok/s and looked exactly like a slow
CPU. `-c 2048` holds the process near 890 MB with swap at zero. If
routing ever truncates, raise it **and** check `free -m`.

**Speed scales with cores, and only with cores.** Measured on this box,
same 98-case battery, identical accuracy (90%) at both sizes:

| size | cost | warm route (median) | bench p50 |
| --- | --- | --- | --- |
| `s-1vcpu-2gb`, `--threads 1` | $12/mo | 3.02s | 5.5s |
| `s-2vcpu-2gb`, `--threads 2` | $18/mo | **1.66s** | **3.2s** |

Near-linear, because routing is one short generation on a CPU: the
model, the quant, the context and the token cap are all already at their
floor, so cores are the only lever left. **`--threads` must be updated
by hand when the droplet is resized** — llama.cpp won't infer it, and a
stale `1` leaves half the box idle.

The **tail** is a different animal: worst case is ~9s, and it is always
the `max_tokens` cap being reached. Qwen writes a prose preamble before
the tool call, and on the cases where it rambles it runs to 96 tokens
instead of the usual 12-28. Lowering the cap shortens the tail directly
(the cap *is* the worst case) but risks truncating the legitimately
longer calls — `nobody` picks have been seen at 105 tokens. Re-run
`@fezchat/bench` before changing it.

A resize is power-off → `doctl compute droplet-action resize <id> --size
<slug> --resize-disk=false` → power-on. Keeping the disk out of it is
what makes the change reversible.

## Rollback

```bash
ssh root@<ip> 'cd /opt/fez-router && mv gateway.mjs.prev gateway.mjs && systemctl restart fez-router-gateway'
```

The model and the llama.cpp build are pinned in `provision-router.sh`
(`MODEL_URL`, `LLAMA_BUILD`) — change them there and re-run it.
