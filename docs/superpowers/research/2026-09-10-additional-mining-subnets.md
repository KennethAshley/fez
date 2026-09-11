# Additional mining subnets for Fez

Research date: 2026-09-10. Four candidates, ranked by agent relevance and clarity of the integration contract, not expected returns. Sources are official repositories/docs. Netuids below are verified against those sources, not a live chain query; registration availability and currently open competitions remain unverified. No code changed, agents executed, keys supplied, registrations made, or money spent.

Local context supplied by the main agent: Gradients supports testnet SN241; Numinous supports testnet SN155; the existing Ridges extension purchases coding through x402 and does not mine. Container/Compose/publicEndpoint support exists; the generic submission test result currently expects a numeric prediction. Integration observations below are inferences, not a review of those seams.

## Ranked shortlist

| Rank | Candidate | Network | Work and submission model | Main caveat |
|---|---|---|---|---|
| 1 | Ridges | Mainnet 62 | Upload a Python coding agent; platform evaluates patches | Paid upload, inference credentials, competition-specific eligibility |
| 2 | Autoppia Web Agents | Mainnet 36 | Advertise a GitHub commit; validators run browser agent | Public executable agent, stake requirement, sandbox compatibility |
| 3 | Bitsec | Mainnet 60 | Upload a security agent that produces vulnerability reports | Round-based screening, execution-key delegation, specialist benchmark |
| 4 | Desearch | Mainnet 22; testnet 41 | Run an axon serving AI/web/X search responses | Always-on service and upstream API capacity; narrower than autonomous research |

## 1. Ridges — strongest coding candidate

**Verified mechanism:** the current [submission guide](https://docs.ridges.ai/guides/submit) identifies SN62 and requires a registered hotkey. `ridges upload --file agent.py --competition <set-id>` submits to one accepting competition; scripted uploads must specify that ID. Uploads require OpenRouter runtime and management keys, incur an Alpha burn unless an upload credit applies, and have a 12-hour per-hotkey/per-competition cooldown. Screening inference is billed separately. Do not treat upload as a harmless dry run.

**Contract/hardware:** a single Python file exports `agent_main(input: dict) -> str`, returning a unified diff; execution happens in Docker with the repository at `/repo`. See [agent contract](https://docs.ridges.ai/guides/agent-contract). Local development requires Docker and uv; no GPU or numeric RAM minimum is specified in the [setup guide](https://docs.ridges.ai/guides/miner-setup). API-backed inference makes a local GPU unnecessary for that documented path (inference).

**Caveats:** setup docs and [README](https://github.com/ridgesai/ridges) disagree about management-key necessity for local testing; README says it is upload-only. Both require it for upload. Current setup docs describe rewarding improvements in score or cost; do not reuse the README's simplified highest-score description as the full incentive model. Buying [Ridgeline coding](https://docs.ridges.ai/) is tool access, not mining.

**Fez implication:** package/test/upload/status workflow, with a diff artifact and submission receipt; an x402 client or public endpoint alone cannot enter this competition.

## 2. Autoppia — strongest browser-agent candidate

**Verified mechanism and needs:** the [official miner guide](https://github.com/autoppia/autoppia_web_agents_subnet/blob/main/docs/miner.md) specifies mainnet SN36. A Python/PM2/Bittensor miner announces agent metadata and a GitHub ref, preferably an exact commit. Validators clone and execute it; the miner host only answers metadata handshakes. The agent must implement HTTP `/act`. Requirements include at least 100 alpha staked and no more than two hotkeys per coldkey. The example axon uses port 8091. The metadata runtime has no stated GPU/RAM minimum and does not install Playwright/IWA. A fresh commit is needed for re-evaluation in the same season; cost overruns can force zero score.

**Local preparation:** the [benchmark guide](https://github.com/autoppia/autoppia_web_agents_subnet/blob/main/docs/advanced/benchmark_readme.md) requires IWA and demo websites; this is separate from the lightweight production miner. Full evaluation needs browser/container infrastructure. No universal miner LLM credential requirement is established by these guides: the handshake only needs metadata/wallet settings, while agent inference and benchmark credentials depend on configuration. Confirm sandbox-supported inference and secret provisioning before building a remotely dependent agent.

**Fez implication:** commit publication plus metadata service, not forwarding browser tasks to Fez's running desktop agent. Browser tool access alone is not a submitted, benchmark-compatible policy. No testnet netuid was verified.

## 3. Bitsec — security research through coding agents

**Verified network:** the [official validator configuration](https://docs.bitsec.ai/validator/) explicitly pairs `NETUID=60` with `NETWORK=finney`.

**Submission:** [sandbox README](https://github.com/Bitsec-AI/sandbox) documents platform registration via `bitsec.py miner create` using email, name, and wallet, followed by `bitsec.py miner submit --wallet ...`. It uploads `miner/agent.py` and an execution API key. `agent_main()` returns JSON with a top-level `vulnerabilities` list; validators execute the submitted code. Platform registration is a separate step; this source does not establish current on-chain registration fees or availability.

**Hardware/credentials and competition:** the [miner guide](https://docs.bitsec.ai/miner/) recommends 32 GB RAM and 512 GB SSD for local evaluation, Docker, uv, and a Chutes or OpenRouter inference key. No GPU requirement is stated. Miner execution uses that supplied key through the inference proxy. Agents face code/security/duplicate/benchmark-memorization screening; code becomes public after the submission phase. The documented rounds select one winning eligible agent, with confirmed findings breaking ties. A syntactically valid upload is not competitive mining; provider concurrency and model timeouts matter.

**Fez implication:** a useful specialist agent-development target, with structured report artifacts and platform submission IDs. Running a security-review tool locally does not participate. No testnet netuid was verified.

## 4. Desearch — research infrastructure, less autonomous-agent work

**Verified mechanism:** [miner guide](https://github.com/Desearch-ai/subnet-22/blob/main/docs/running_a_miner.md) specifies mainnet SN22/testnet SN41. Run `neurons/miners/miner.py` as a Bittensor axon; validators send search synapses directly. It answers health checks and AI/web/X queries. Configure wallet/hotkey, public axon port (example 14000), and per-search concurrency in a manifest. Capacity is per validator, so aggregate demand can multiply substantially. Sender stake gates concern requesting validators, not a stated miner staking minimum.

**Hardware/credentials:** Python 3.10+ and PM2 are documented. This guide leaves host sizing to the operator; it provides no fixed GPU/RAM minimum. The [environment reference](https://github.com/Desearch-ai/subnet-22/blob/main/docs/env_variables.md) requires OpenAI, Apify, and ScrapingDog keys for the reference miner; direct Twitter bearer access is optional. Older SerpAPI-based instructions should not override that current reference.

**Caveats/Fez implication:** [official architecture](https://github.com/Desearch-ai/subnet-22) separates external API consumers from miner axons. A Desearch search tool would buy/use results; mining supplies search capacity that validators verify. Existing endpoint/container support appears relevant, but Fez would need the actual synapse and capacity contract. Best viewed as verifiable retrieval and synthesis, not an open-ended research-agent tournament.

## Decision

Prioritize **Ridges and Autoppia** for agent-native mining prototypes; keep **Bitsec** as a specialist code/research option and **Desearch** as the clearer live-service/testnet path. All require more than access to a capable tool: a compatible submission, eligibility, evaluation, and sustained competitive quality are separate concerns. No profitability conclusion follows from integration feasibility.

For the main agent's seam review, distinguish **agent source/commit**, **local evaluation artifact**, **remote submission receipt**, and **competitive score/status**. A numeric prediction alone cannot represent those outputs. This is a contract observation, not a request to add a new abstraction now.

Creative media was considered but not promoted into this time-boxed four: no creative candidate received the same current identity/submission verification. Do not infer current mineability from a generation API or an old subnet README. Recheck mutable guides and actual runtime contracts before any future submission.
