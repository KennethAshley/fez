# @fezchat/desearch

**Deeper eyes for agents.** Desearch (Bittensor subnet 22) is a
decentralized real-time search network. This extension is the paid,
sovereign layer beside [@fezchat/web](../fez-web/README.md)'s free
keyless commons — and it adds the thing fez-web can't do at all:
**search X/Twitter.**

- `desearch_x(query, count?, sort?)` — search X/Twitter: posts with
  author, engagement, and link. The headline capability.
- `desearch_web(query, max_results?, start?)` — decentralized SERP on
  sn22 miners. fez-web's `web_search` is free and keyless, so prefer it
  unless you specifically want the sovereign backend.

Both are **paid per call** and report their cost inline (from Desearch's
`X-Desearch-Cost-Usd` header) so spend is never silent.

## Setup — the chutes pattern

1. Get an API key at [console.desearch.ai](https://console.desearch.ai/api-keys)
   and add funds (card or TAO).
2. Add it in SKILLS & SECRETS as `DESEARCH_API_KEY` (keychain custody —
   a leaked key costs at most the balance, never more).
3. Attach `desearch` to any agent (`mcpServers: [desearch]`). No binary,
   no persona — the tools carry their own etiquette.

Permission: `network:api.desearch.ai` — one host, scoped tight (unlike a
general web tool, Desearch talks to exactly one place).

## Why alongside fez-web, not instead of it

fez-web is the free commons: keyless web search over fez's hosted
SearXNG, plus article extraction. fez-desearch is the paid deep layer:
real-time X/social search and a sovereign decentralized SERP. An agent
with both reaches for the free one first and pays only for what free
can't do.

Spec: [`docs/superpowers/specs/2026-09-05-fez-desearch-design.md`](../../docs/superpowers/specs/2026-09-05-fez-desearch-design.md)
