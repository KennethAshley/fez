# @fezchat/ridges

The first paid-service extension for fez. `/ridges <issue-url>` pays the
[Ridges](https://ridges.ai) coding subnet, through your own wallet's
x402 rail, to turn a GitHub issue into a pull request. One payment, one
PR — with job history and updates available in conversation.

## Mine on SN62

This same package also exports a `miner` part. Install it alongside
`@fezchat/mining` to use the existing submission panel, CLI and
`mining_submission` agent tool. It uploads Python coding agents to Ridges;
it does not run your desktop persona inside the validator.

1. Use the official [Ridges setup and registration](https://docs.ridges.ai/guides/submit)
   for an existing SN62 mainnet hotkey. Select that network explicitly in
   Fez; the adapter refuses a testnet wallet. Fez's mainnet registration
   restrictions remain in force; this adapter never enrolls or funds a miner.
2. Configure `hotkey` and an explicit numeric `competition` ID using the
   mining configuration form. The public list is
   `https://agent-upload.ridges.ai/competitions?accepting=true`.
   Optionally set `name`. Status and source checks need no secrets.
3. Install and start Docker, then explicitly pull the check image:
   `docker pull python:3.11-slim@sha256:9534e5a8e315485d4061ed659af0fd78a284c015f9b73661b41d6bab25604534`.
   Test your UTF-8 `.py` source using the commands below. Fez checks syntax
   and a synchronous `agent_main(input)` declaration in a networkless container;
   it **does not execute the candidate or validate its patches**. Run the
   official Ridges local evaluation before paying for screening.
4. Prepare a single-use ticket using the official `ridges prepare-upload`
   flow (this can spend Alpha or consume an upload credit). In Fez's mining
   secret fields, set `ticket`, `openrouter_api_key` and
   `openrouter_management_key`. These stay in the mining keychain until
   Submit sends them directly to Ridges. Ridges stores the inference keys
   and screening bills their account. No automatic funding or key creation.
5. Explicitly submit the SHA256 returned by the check. Fez verifies the
   receipt's source bytes, persona, hotkey and competition; checks that
   the competition accepts uploads; and redeems the supplied ticket once.

```sh
fez-mine submission status --netuid 62 --persona coder --json
fez-mine submission test --netuid 62 --persona coder --file /absolute/agent.py --json
fez-mine submission submit --netuid 62 --persona coder --file /absolute/agent.py --sha256 TESTED_SHA256 --json
```

`coder` is an example persona. The public `hotkey` configuration is an
explicit association with your registered Ridges identity; it is not derived
or created from the persona. Status reports competition-specific screening,
approval, score and rank. Missing scores are not zero; finished screening is
not approval. Registration, execution, approval and earnings are different states.

Submission source is limited to 1 MiB (below Ridges' 2 MiB server maximum).
The local source check requires only Python's standard library; dependencies
and runtime behavior are the official evaluator's responsibility.

### Upload receipts and recovery

`~/.fez/mining/62-coder/ridges-upload.json` records the source hash, ticket
hash, competition and accepted agent ID. It contains no ticket or inference
keys. Acceptance survives a failed status readback. An uncertain upload
blocks further uploads rather than risking another redemption.

If blocked, inspect the Ridges dashboard for that hotkey and competition
before retrying. Preserve the receipt while resolving acceptance. Only after
confirming the outcome with Ridges should you archive that receipt and
explicitly retry with appropriate funding. Fez never retries a POST or
replaces funding automatically. The server enforces the actual cooldown.

The adapter deliberately avoids `/upload/ticket/check`: the inspected
upstream middleware logs unredacted JSON tickets. It instead lets the
multipart upload endpoint validate signatures, funding and enrollment.
Contract reviewed against upstream commit
`bbf48c64122bffabe046639d9802f90eaf1fa5c7`; no live paid upload is part of tests.

```
fez install @fezchat/ridges
```

## Before you dispatch

Ridges only works a repo that has the **Ridgeline** GitHub app
installed on it:
https://github.com/apps/ridges-ai/installations/new

Dispatching against a repo without the app installed refuses before any
payment — the 404 it gets back names this install link, and that
`detail` is surfaced verbatim in the reply.

**Mainnet note:** Ridges charges on Base **mainnet**. Real payment logic
lives entirely in `@fezchat/wallet` (this package never touches keys,
caps, or consent) — flip the wallet's x402 network to mainnet when
you're ready to spend for real; ridges itself has no network setting of
its own to change.

## Use it

From any channel:

```
/ridges https://github.com/acme/widgets/issues/42
```

Or as an agent tool, `ridges_dispatch({ issueUrl, maxUsd? })` — same
underlying dispatch, same wallet caps and consent. `maxUsd` defaults to
**5**; big spends still ask you first.

A background poller checks GitHub every 90s for the PR your payment
bought, and transitions the job row honestly as it moves: `working` →
`pr-open` → `merged` or `closed`.

## Job history and background updates

There is no standalone Ridges panel. `/ridges status [offset]` shows the
local history in the headless command host, paginated 20 jobs at a time: persona, issue/title, PR link,
working/open/merged/closed/refused/payment-unclear status, payment amount,
transaction receipt, provider ID, timestamps and tracking problems. It also
shows live/merged counts and seven-day confirmed and uncertain payment totals
separately. The `ridges_status` MCP tool provides the same report filtered to
the calling persona, with `offset` and `limit` arguments. In desktop chat,
ask a Ridges-enabled agent to use `ridges_status`; `allPersonas: true`
includes owner-dispatched and other local personas' jobs when you request
the full history. Desktop does not execute headless slash commands.

Enable channel announcements in desktop chat by asking that agent to use
`ridges_updates` with your chosen `channelId`; `channelId: null` disables
them, and omitting it only inspects the setting. In the headless host,
use `/ridges watch <channel-id>` or `/ridges watch off`. The sentinel posts updates for local paid
jobs to that channel, so select one whose members may see those issue links
and receipts. No channel is chosen automatically. Failed deliveries remain
pending; unchanged states do not produce repeated messages. A crash after
sending but before recording delivery can repeat the last update.

An hour without a matching PR produces one stalled-work notice.
Unreadable repositories and API problems appear in the report and opted-in
updates. A 404 stops polling that repository until the sentinel restarts;
private-repository token support is not implemented. History remains in
`ridges-jobs.json` (newest 1,000 jobs); removing the GUI does not delete it.

## If a payment looks stuck

An `ambiguous`/payment-unclear outcome means the money may have
**already settled** — a paid-but-unclear response can't be told apart
from a lost one. **Do not re-dispatch the same issue.** Contact Ridges
support with the transaction hash from the reply (or the job row's
receipt) instead; retrying risks paying twice for the same issue.

## Paid-service boundaries

For issue dispatch, wallet custody, spend caps and consent belong to
`@fezchat/wallet`'s `x402FetchRaw`. No automatic rerun of a closed,
unmerged PR. No token support for a private repo Ridges/GitHub can't
read (that job's row just notes it and polling stops for that repo).
