# fez Connections — sign in, don't paste

*2026-09-05. Prompted by UR (Bittensor sn22's privacy network): its MCP
server is OAuth-protected, "no keys to paste" by design, and fez's
hosted-skill custody only knew static headers. Ken's ask generalized past
UR: the Corsair DX — "ask an agent to connect Google Drive, click a
link, sign in, done" — for many services. Corsair itself was evaluated
and rejected: it's a web-backend integration platform (database, tenant
model, mounted HTTP handlers, REST-API plugins, optional hosted Hub
holding client secrets) solving an adjacent problem. The MCP OAuth spec
does fez's actual job with a dependency every extension already carries.*

## Proven live before this spec was written

The spike (scratchpad `oauth-spike/`, ~80 lines over
`@modelcontextprotocol/sdk/client/auth.js`) ran the full flow against
Linear's production MCP server:

- **Discovery**: protected-resource metadata → authorization server.
- **DCR**: `/register` minted client_id `PKMjqhc6rS8DA4Tl` at connect
  time — no pre-registered app anywhere.
- **PKCE + loopback**: browser sign-in, callback on `127.0.0.1:41765`,
  code exchanged. Ken pasted nothing.
- **The token works**: authenticated `initialize` against Linear MCP, 200.
- **Silent refresh**: access token deleted, `auth()` used the refresh
  token, new 24h token, no browser.

Probes of the wider field sorted every server into three buckets:

| bucket | servers probed | per-service burden |
|---|---|---|
| **DCR** (self-registering) | Linear, Notion | none — zero config |
| **shipped client_id** | GitHub (`github.com/login/oauth`, no DCR) | fez registers ONE public OAuth app, ever; its client_id ships in the catalog (the `gh` CLI precedent — native apps can't hold secrets, GitHub blesses this) |
| **discovery quirks** | UR (`auth.bringyour.com`, AS metadata off the standard path) | small per-entry accommodation |

Plus the universal fallback that already exists: paste a token into the
keycard (GitHub PAT works against its MCP today).

## Thesis

Agents get tools by signing in, not by humans minting API keys. One
OAuth flow — discovery → (DCR | shipped client_id) → PKCE browser
sign-in → keychain custody → refresh-before-use — covers every
OAuth-protected MCP server. Per-service difference is DATA (a catalog
entry), never a code path. This is Corsair's DX with nobody between the
user and the provider: no hub, no broker, no third party on the redirect.

## Architecture: fez owns the flow, the harness sees a header

fez never connects to MCP servers — it hands ACP `McpServerHttp`
configs (`{name, url, headers}`) to the harness. That type has no OAuth
affordance, so the design is forced and clean:

**fez runs OAuth itself and injects `Authorization: Bearer <token>` as a
header at spawn time** — exactly where `resolveHeaders()` already fills
static keychain values. OAuth tokens become headers whose lifecycle fez
owns. No harness cooperation needed; works identically for claude-code
and pi agents.

## Parts

**1. `src/extensions/connections.ts` (core, new)** — an
`OAuthClientProvider` (the MCP SDK interface) over the keychain:

- Storage: one keychain item per connection — service `fez-skill-env`,
  account `<skill>.OAUTH`, value a JSON blob `{client, tokens, verifier}`
  (same custody, listing, and rotation story as every secret; the
  secrets page shows it as one entry).
- `connect(name)`: loopback listener on an ephemeral `127.0.0.1` port →
  `auth(provider, {serverUrl})` → browser opens → callback exchanges the
  code → tokens land in the keychain. ~the spike, productionized.
- `freshToken(name)`: called at spawn/resolve time — returns the access
  token, refreshing via the SDK first when stale (refresh-before-use,
  not a timer). On refresh failure: the skill is withheld and the agent
  told to say so (the existing honest-gap path), with "reconnect in
  settings" as the message.
- Catalog entries may carry `client_id` (GitHub bucket) and
  `authServerUrl` (UR bucket) — data, not code paths.

**2. `mcp-servers.ts` (edit)** — a settings entry gains
`auth: "oauth"`; `resolveHeaders` consults `freshToken()` for such
entries instead of a static keychain string. A filled static header
still wins (the PAT fallback is free).

**3. The Connections catalog (data)** — service name, MCP URL, bucket
fields, one-line "what your agent gets". First entries: Linear, Notion
(DCR, zero config), GitHub (shipped client_id), UR (authServerUrl
accommodation).

**4. Secrets page (GUI)** — an oauth-backed keycard shows **Connect**
instead of a paste field; connected state shows the 🔒 chip like any
stored secret, plus "reconnect". The keycard redesign already carries
the frame; this is a new card body variant, not a new page.

**5. In-chat**: "@fez connect linear" → fez replies with the authorize
link (clickable) and confirms when the callback lands. Same code path
as the button.

## Deliberately parked (named so they're chosen later)

- **Device flow** (GitHub's `ABCD-1234` code path) — the right answer
  for headless/droplet agents with no local browser; also sidesteps
  GitHub's token-exchange secret quirk. Add when a headless agent
  actually needs an OAuth connection; loopback covers the desktop.
- **UR itself** — the extension that started this becomes a trivial
  catalog entry once `authServerUrl` accommodation lands; its x402
  upgrade path meets the wallet rail later.
- **REST-only services** (no MCP server) — the one rung where
  Corsair-style adapters would earn their keep. YAGNI until a needed
  service lacks an MCP server; revisit Corsair then.
- **Per-agent token scoping** — v1 tokens are per-user (the human signed
  in), shared by their agents, consistent with every other secret. An
  agent-scoped identity story (agents as OAuth subjects) is a spec of
  its own.

## Security notes

- PKCE S256 always; `state` from the SDK; loopback binds `127.0.0.1`
  only and one-shots (server closes after the callback).
- Tokens never in settings.json, never in chat — keychain only; the
  authorize URL shown in chat contains no secret (that's its design).
- A revoked/expired refresh token degrades to the honest-gap path, never
  a silent broken tool.
