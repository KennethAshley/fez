# @fezchat/desearch

**Eyes on X for agents.** Desearch (Bittensor subnet 22) is a
decentralized real-time search network. This extension adds the one thing
[@fezchat/web](../fez-web/README.md)'s free keyless web commons can't do:
**search X/Twitter.**

- `desearch_x(query, count?, sort?)` — search X/Twitter: real-time posts
  with author, engagement, and link. **Paid per call**, cost reported
  inline (from Desearch's `X-Desearch-Cost-Usd` header) so spend is never
  silent.

**On web search:** Desearch also sells a decentralized SERP, and the
client for it (`searchWeb`) is written and tested here — but the tool
isn't exposed, because as of 2026-09-05 Desearch's web endpoints return
empty for every query (their own console too, not just us) while still
billing. Shipping a tool that charges for nothing would be dishonest.
It's a three-line re-add the day their web search returns data; for web
today, use `@fezchat/web` (free and keyless).

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
SearXNG, plus article extraction. fez-desearch adds what fez-web has no
answer for — real-time X/Twitter search. An agent with both reads the
web for free and pays only to see what people are saying right now.

Spec: [`docs/superpowers/specs/2026-09-05-fez-desearch-design.md`](../../docs/superpowers/specs/2026-09-05-fez-desearch-design.md)
