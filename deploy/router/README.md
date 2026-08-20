# Running the fez router

The router is the endpoint `@fez` asks "who should take this?". It
exists so fez works with **nothing installed** — no brew, no model
download, no local inference.

Live: **`https://137-184-135-188.sslip.io/v1`** (DigitalOcean, 2 GB
droplet `fez-router`, nyc1, $12/mo).

## Why this is a separate box from the relay

The relay holds the only copy of a community's history and its own
README is emphatic that memory, not disk, is its constraint. A 400 MB
model next to it trades "routing is slow" for "the community is gone".
They share nothing but a region.

## Why not cactus + needle

You can't run it here. cactus ships wheels for macOS-arm64 and
linux-aarch64 only, its kernels are ARM NEON, and DigitalOcean has no
ARM droplets. That isn't awkward, it's impossible — which is why the
hosted router runs Qwen3-0.6B under llama.cpp instead.

The swap is not a downgrade: measured on the 97-case battery, needle
scores 71% and Qwen3-0.6B with the right request shape scores 90%. See
the orchestrator README for the full table and the profile it needs.

## First time

```bash
doctl compute droplet create fez-router --image ubuntu-24-04-x64 \
  --size s-1vcpu-2gb --region nyc1 --ssh-keys <id> --wait
ssh root@<ip> 'HOSTNAME_FOR_TLS=<ip-with-dashes>.sslip.io bash -s' < deploy/router/provision-router.sh
deploy/router/deploy-router.sh root@<ip>
```

`provision-router.sh` does system setup — swap, a prebuilt llama.cpp
(nothing is compiled on the box), the model, Caddy, ufw — and is
idempotent. `deploy-router.sh` ships only the gateway and the units, so
a policy change can never break the machine.

## The shape of it

```
internet ──443──> caddy ──> gateway :8081 ──> llama-server :8080
                            (policy)          (loopback only)
```

`llama-server` never faces the internet. The gateway is the only public
surface, and it exists for the three things llama-server won't do:

| policy | why |
| --- | --- |
| `RATE_PER_MIN=20` per IP | the endpoint answers unauthenticated strangers by design; a tiny model is cheap but not free |
| `RATE_BURST=2` | one vCPU, one slot — concurrency just makes everyone wait |
| `MAX_TOKENS=96` | a 4096-token request is a 90-second CPU hold. Measured: 96 scores the same as 512 |
| `temperature: 0` | pinned server-side, so two identical mentions can't route differently |

Only `/v1/models` and `/v1/chat/completions` are routed. `/slots`, the
web UI and `/completion` return 404 — this is a routing appliance, not a
public playground.

**It is currently open** (no `ROUTER_API_KEY`), because a token shipped
to every user is not a secret and zero-install is the whole point. To
close it:

```bash
ssh root@<ip> 'echo ROUTER_API_KEY=<token> > /etc/fez-router.env && systemctl restart fez-router-gateway'
```

Clients then set `FEZ_ORCHESTRATOR_KEY`.

## Operating it

```bash
systemctl status fez-router          # the model
systemctl status fez-router-gateway  # the policy layer
journalctl -u fez-router -f
curl https://137-184-135-188.sslip.io/health
```

**Context size is a memory decision.** Qwen3-0.6B costs ~114 KB of KV
cache per token, so `-c 8192` allocates ~940 MB — more than the model.
That was the first configuration here and it put the box 524 MB into
swap, where generation ran at 6 tok/s and looked exactly like a slow
CPU. `-c 2048` holds the process near 890 MB with swap at zero. If
routing ever truncates, raise it **and** check `free -m`.

**Speed is the honest weak point.** DigitalOcean's shared vCPU generates
~9 tok/s, and a tool call is ~16 tokens, so a warm route is ~1.9s and a
cold one (new prompt prefix) is 5s+. Accuracy does not suffer — it's 90%
here, same as on a laptop. If that latency stops being acceptable, the
lever is the droplet, not the config: a premium-Intel or CPU-optimized
size, since the model, the quant and the token count are all already at
their floor.

## Rollback

```bash
ssh root@<ip> 'cd /opt/fez-router && mv gateway.mjs.prev gateway.mjs && systemctl restart fez-router-gateway'
```

The model and the llama.cpp build are pinned in `provision-router.sh`
(`MODEL_URL`, `LLAMA_BUILD`) — change them there and re-run it.
