# @fezchat/chutes

**Inference on Bittensor subnet 64 (Chutes).** Phase 2 of the Bittensor
integration: from the *map* (discovery) to the *territory* — agents actually
running models on decentralized serverless compute.

## Tools (agent-facing)

- `chutes_models(filter?)` — the models available to run.
- `chutes_infer(model, prompt, system?, max_tokens?, temperature?)` — run a prompt
  and get the completion. OpenAI-compatible under the hood.

## The key: custody, not a coldkey

Chutes is an OpenAI-compatible HTTPS API keyed by a **Chutes API key**. You set it
once in the desktop under **SKILLS & SECRETS** (skill `chutes`, `CHUTES_API_KEY`);
it lives in the macOS keychain (`fez-skill-env`), never in plaintext, and is
injected into the skill at spawn. It's an *API key* — revocable, scoped to Chutes
spending, capped by your balance — so a leak costs at most the balance, never the
wallet. To mint one: register with Chutes once (their CLI/web, using a Bittensor
hotkey), then create a key.

Config: `CHUTES_API_KEY` (required, via SKILLS & SECRETS), `CHUTES_BASE_URL`
(optional, default `https://llm.chutes.ai/v1`).

## @chip

Ships the `@chip` persona — the Chutes-native agent, **both ways at once**: its
brain *runs on* Chutes (pi + a Chutes model) and it can *call* specific Chutes
models as a tool (`chutes_models` / `chutes_infer`) for a different or specialized
model on demand.

## How the substrate works

pi speaks to any OpenAI-compatible endpoint through its `local-models` extension
(registers each as a `local-<id>` provider, id = sha256(baseUrl)[:10]), and
fez-acp already writes a persona's `provider:`/`model:` into pi's settings. Chutes
is just another OpenAI-compatible endpoint — provider **`local-56105ece7a`**. No
fez-acp change was needed.

Setup, all in the UI:
1. Set `CHUTES_API_KEY` in **Settings → secrets → chutes**.
2. In the agent editor, an agent with **harness `pi`** shows a **"runs on"**
   dropdown → pick **Chutes** → pick a model. (The desktop's `wire_chutes_pi`
   registers the endpoint and lists the models.)

`@chip` ships pre-set to Chutes, so once the key's in you just open it, confirm a
model, and save.

**Custody note:** pi stores the endpoint's `apiKey` in
`~/.pi/agent/local-models.json` in **plaintext** — pi's custody, not the keychain
(where the skill's copy lives). Running an agent's *brain* on Chutes means pi
holds the key; that's the tradeoff.
