# @fezchat/lium

**Bodies for agents.** Lium (formerly Celium, Bittensor subnet 51) is a
decentralized GPU rental marketplace; this extension gives any agent the
tools to rent a machine sized to the job, run it, ship the results, and
give it back. Compute becomes a line item, not a place.

Phase 2 of the Bittensor integration, compute edition: discovery (@scout),
inference (@chip), storage (@vault), and now the machine itself. No
persona of its own — attach it to any agent with `mcpServers: [lium]`.

## The tools

A thin wrapper over the `lium` CLI — Lium's own agent-facing surface,
`--format json` everywhere:

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

## Setup — the chutes pattern

1. **You** sign up at [lium.io](https://lium.io) and copy your API key
   from the dashboard. Accounts are yours; agents never create one.
2. **You** add it in SKILLS & SECRETS as `LIUM_API_KEY` (keychain
   custody — a leaked key costs at most the balance, never a wallet).
3. **The agent** installs the CLI when first needed: say yes when it
   offers **lium_setup**, which downloads the official `lium` binary
   (one static file from Lium's GitHub releases, into `~/.fez/lium/bin`
   — no shell scripts, no sudo). Consent-gated by the tool's own
   description; it downloads an executable, so it asks first.

No SSH ceremony either: `lium up` registers an SSH key itself on the
first rent.

**Plain words on permissions:** this extension lets attached agents run
commands on rented machines (arbitrary miner IPs, over SSH via the CLI) and
pay for them from your Lium balance. There is no narrower honest scope for
that; hence `network:*`.

Spec: [`docs/superpowers/specs/2026-09-05-fez-lium-design.md`](../../docs/superpowers/specs/2026-09-05-fez-lium-design.md)
