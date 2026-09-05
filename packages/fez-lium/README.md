# @fezchat/lium

**Bodies for agents.** Lium (formerly Celium, Bittensor subnet 51) is a
decentralized GPU rental marketplace; this extension ships **@rig**, an agent
that rents a machine sized to the job, runs it, ships the results, and gives
it back. Compute becomes a line item, not a place.

Phase 2 of the Bittensor integration, compute edition: discovery (@scout),
inference (@chip), storage (@vault), and now the machine itself.

## What @rig does

Tools (the `lium` skill, a thin wrapper over the `lium` CLI — Lium's own
agent-facing surface, `--format json` everywhere):

- `lium_nodes(gpu?, country?)` — what's rentable, at what $/hour.
- `lium_pods()` — your pods: status, uptime, burn rate.
- `lium_up(node, template?, ttl?)` — rent. **TTL mandatory** (default 1h);
  Lium itself stops billing when it expires, even if fez is gone.
- `lium_exec(pod, command)` — run a command on the pod.
- `lium_copy(pod, source, destination?, download?)` — files in/out.
- `lium_rm(pod)` — terminate, stop paying.
- `lium_balance()` / `lium_topup(usd, network)` — funds; topup emits a USDT
  invoice for the HUMAN to pay (the network — e.g. tron — is theirs to name).
  Agents cannot move money in.

## The guards (checked before any spend)

- price ceiling `FEZ_LIUM_MAX_USD_HOUR` (default $5/h)
- ttl cap `FEZ_LIUM_MAX_TTL` (default 4h)
- the balance must cover the **full lease** or the rent is refused
- unreadable price or balance refuses — never rent blind
- every up/rm/refusal is a row in `~/.fez/lium-pods.json`, so "what did
  compute cost this week" has an exact answer

## Setup (in-channel, consent-gated)

No curl, no terminal. Say yes when @rig offers **lium_setup**:

- without an email it downloads the official `lium` binary (one static
  file from Lium's GitHub releases, into `~/.fez/lium/bin` — no shell
  scripts, no sudo);
- with your email it also runs `lium signup` — non-interactive by design,
  generates a password, stores the API key in `~/.lium/config.ini`,
  registers an SSH key, and grants the $5 signup credit when available.

@rig is instructed to run it only after you agree in the channel — the
binary is an executable and signup creates an account in your name.
Already have an account? Skip signup: `lium init`, or set `LIUM_API_KEY`
in SKILLS & SECRETS (keychain custody — a leaked key costs at most the
balance, never a wallet).

**Plain words on permissions:** this extension lets attached agents run
commands on rented machines (arbitrary miner IPs, over SSH via the CLI) and
pay for them from your Lium balance. There is no narrower honest scope for
that; hence `network:*`.

Spec: [`docs/superpowers/specs/2026-09-05-fez-lium-design.md`](../../docs/superpowers/specs/2026-09-05-fez-lium-design.md)
