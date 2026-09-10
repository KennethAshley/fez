# ORO mining for Fez

Develop shopping agents for **ORO, Bittensor mainnet subnet 15**, through Fez Mining's existing GUI and chat tools. The extension uses ORO's current generated-environment agent contract.

## Install from a checkout

Build the package with `npm --prefix packages/fez-oro run build`, then run `fez link packages/fez-oro`. Install Mining and Wallet as well. This source addition does not publish an npm package or a desktop release.

Open Mining and select ORO. Setup, source checks, development evaluations, submissions and status share one adapter. Attach Mining to your coding agent to use `mining_setup`, `mining_config`, `mining_workspace` and `mining_submission`.

## Develop a candidate

Ask your coding agent:

> Inspect my ORO setup. Create a shopping agent in my repository using ORO's current environment contract, commit it, and link the source. Explain the local evaluation prerequisites and cost before running it.

Start from the official `src/agent/environment_agent.py`. Your Python file must expose synchronous `agent_main(problem_data)` and drive the supplied environment binding with the task's dynamic tool schemas. The older `src/agent/agent.py` ShoppingBench example is not the current production contract.

Link your repository and relative source in **Develop your miner**. Source checks parse the file; they do not prove runtime correctness or qualification. Evaluations run the official local benchmark and record source identity, evaluator identity and numeric results in Fez's experiment history.

## Prepare local evaluation

Use Mining built from this checkout, which includes `development` commands. Select a clean ORO checkout at `ffb98e581e8976fbe33cc4a3a467eb617d4b0328` and a materialized release archive with SHA256 `9e5d11c6945edc19e06b730afd5681a035f75827933f958e6bfbcc846a28c73a`. A Git LFS pointer is not the archive.

In Mining setup, fill in:

| Field | Value |
| --- | --- |
| `evaluation_checkout`, `evaluation_commit` | Absolute ORO checkout path and the reviewed commit above |
| `evaluation_pack` | Absolute path to the actual EnvPack archive |
| `evaluation_validator_image`, `evaluation_sandbox_image`, `evaluation_proxy_image`, `evaluation_search_image` | Installed official images, identified by `ghcr.io/oro-ai/oro/<image>@sha256:<digest>` |
| `evaluation_provider`, `evaluation_model` | `openrouter` or `chutes`, and a model currently allowed by ORO |
| `openrouter_api_key` or `chutes_api_key` | The selected provider's local runtime key, entered privately |

The image names are `validator`, `sandbox`, `proxy`, and `search-server`. Prepare AMD64 images using ORO's current instructions and record their immutable repository digests with `docker image inspect`. The adapter does not pull mutable tags or build images during evaluation. On Apple Silicon, Docker Desktop must support AMD64 emulation. The search image requires a multi-gigabyte download; reserve at least 16 GB free disk.

For the lightweight source check, install its separate pinned image once:

```sh
docker pull python:3.11-slim@sha256:9534e5a8e315485d4061ed659af0fd78a284c015f9b73661b41d6bab25604534
```

Select **Evaluate candidate**, review the cost notice and confirm. The official runner evaluates 35 tasks, including model calls for both the candidate and shopper simulator. This local task roster is not guaranteed to match current qualifying tasks. Models and ORO's live allowlist can change between comparisons. The official summary does not report a total dollar cost, so Fez leaves cost unknown.

## Credentials and costs

Enter private credentials in Mining setup, not chat. A local runtime key is separate from the provider connection that funds live evaluations on ORO. Saving configuration does not enroll a wallet, submit code or start inference.

Before a live submission, register an existing hotkey on subnet 15 and connect its inference provider using ORO's official onboarding. This adapter does not register a hotkey or automatically retry uploads. ORO can apply a cooldown to rejected submissions as well as accepted ones. An accepted submission is not proof of qualification or earnings.

## Official references

- [Quick start](https://docs.oroagents.com/docs/miners/quick-start)
- [Agent contract](https://docs.oroagents.com/docs/miners/agent-interface)
- [Local evaluation](https://docs.oroagents.com/docs/miners/local-testing)
- [Submission rules](https://docs.oroagents.com/docs/miners/submitting)
- [Provider onboarding](https://docs.oroagents.com/docs/miners/inference-providers)
