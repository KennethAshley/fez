# vLLM-Omni: fit for Fez

Reviewed 2026-09-12 against the official repository and current documentation. This is source inspection only; no models were installed, serving benchmarks run, or Fez runtime behavior changed.

## Decision

Useful as an optional external inference service for Fez specialists. Start with speech through the existing specialist workflow if there is a reason to self-host. Do not add it to the protocol core or desktop bundle. This is an architectural recommendation, not a verified integration.

## What it provides

- **Multimodal inference and generation.** vLLM-Omni extends vLLM with heterogeneous pipelines covering text, images, audio, video and actions, including diffusion generation. The supported-model table includes Qwen Omni, Qwen image generation/editing, speech models and video models; hardware support varies by model. [Repository](https://github.com/vllm-project/vllm-omni), [supported models](https://docs.vllm.ai/projects/vllm-omni/en/latest/models/supported_models/).
- **An HTTP boundary Fez can call.** Documented endpoints include `/v1/chat/completions`, `/v1/audio/speech`, `/v1/images/generations`, `/v1/images/edits` and asynchronous `/v1/videos`. OpenAI-compatible shapes reduce adapter work, but an instance serves one model and each endpoint requires a compatible model. It is not one model that automatically supplies every modality. [API server](https://docs.vllm.ai/projects/vllm-omni/en/latest/serving/).
- **Self-hosting has operational cost.** The documented GPU setup requires Linux and Python 3.12, with supported accelerator backends; NVIDIA requires compute capability 7.0 or newer. vLLM and vLLM-Omni major/minor versions must match. Memory depends on the model and pipeline: the official memory guide demonstrates Qwen3-Omni across two H100 80GB GPUs, an example rather than a universal minimum. [Installation](https://docs.vllm.ai/projects/vllm-omni/en/latest/getting_started/installation/), [GPU requirements](https://docs.vllm.ai/projects/vllm-omni/en/latest/getting_started/installation/gpu/), [memory configuration](https://docs.vllm.ai/projects/vllm-omni/en/latest/configuration/gpu_memory_utilization/).
- **Realtime needs additional integration.** The full-duplex WebSocket API supports simultaneous listening/speaking, interruption and reconnect semantics, with capabilities varying by model. Its advanced session and playback features extend the OpenAI vocabulary; a generic client does not obtain them just by changing a base URL. [Realtime contract](https://github.com/vllm-project/vllm-omni/blob/main/docs/serving/realtime_duplex_api.md).

## Fez already has the useful starting point

The speech specialist already generates audio through ElevenLabs or macOS, uploads it to Blossom, and publishes a signed voice note with an `imeta` attachment. The first Bazaar workflow already checks a brief → script → spoken deliverable through an independent observer. An optional vLLM-Omni speech backend can reuse that delivery and verification path. [Speech specialist](../../../packages/fez-elevenlabs/README.md), [Bazaar workflow](../../../web-docs/content/docs/concepts/bazaar.mdx).

Audio/video understanding would add a capability the inspected generic attachment path currently refuses: `attachmentNotice` explicitly says audio/video cannot be perceived. It needs a specialist adapter and attachment routing that reflects actual model capabilities, not only an endpoint setting. [Attachment handling](../../../src/agent/media.ts).

The smallest useful experiment is one speech model behind the existing MCP specialist, evaluated with the existing script-to-audio workflow. Measure accepted output, latency and actual hosting cost before replacing a provider. Image/video generation and realtime voice can wait for a concrete workflow that needs them.
