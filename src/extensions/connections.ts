import { execFileSync } from "node:child_process";
import { execFile } from "node:child_process";
import http from "node:http";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { loadSettings, saveSettings } from "../shared/settings.js";

/**
 * Connections — sign in, don't paste. One MCP OAuth flow (discovery →
 * DCR or shipped client_id → PKCE browser sign-in → keychain custody →
 * refresh-before-use) for every OAuth-protected MCP server. Per-service
 * difference is DATA in the catalog below, never a code path.
 * Spec: docs/superpowers/specs/2026-09-05-fez-connections-design.md
 *
 * fez owns the whole flow; the harness only ever sees an
 * `Authorization: Bearer` header (see withFreshOAuth, called at spawn).
 */

export interface ConnectionEntry {
  /** Settings/keychain key AND the mcpServers name personas declare. */
  key: string;
  title: string;
  /** The MCP server URL — also what tokens are scoped to (RFC 8707 resource). */
  url: string;
  /** Requested scope, where the server documents one. */
  scope?: string;
  /**
   * Shipped public client_id for servers without dynamic registration
   * (the `gh` CLI precedent). Absent for DCR servers — they mint one.
   */
  clientId?: string;
  /** One line: what an agent gets. Shown by `fez connect` with no args. */
  what: string;
}

/** The catalog. DCR servers need nothing but a URL; the GitHub bucket
 * gains a clientId once the fez OAuth app is registered (until then,
 * connect explains instead of failing cryptically). */
export const CONNECTIONS: ConnectionEntry[] = [
  // Zero-config: these advertise dynamic registration (RFC 7591), so
  // fez self-registers at connect time — nothing to pre-set. Probed live
  // 2026-09-05. Scope omitted where the server's consent screen decides.
  { key: "linear", title: "Linear", url: "https://mcp.linear.app/mcp", scope: "read write", what: "issues, projects, comments — read and write" },
  { key: "notion", title: "Notion", url: "https://mcp.notion.com/mcp", what: "pages and databases the sign-in grants" },
  { key: "sentry", title: "Sentry", url: "https://mcp.sentry.dev/mcp", what: "errors, issues, and releases across your projects" },
  { key: "cloudflare", title: "Cloudflare", url: "https://mcp.cloudflare.com/mcp", what: "Workers, DNS, and account resources" },
  { key: "stripe", title: "Stripe", url: "https://mcp.stripe.com", what: "customers, payments, and billing" },
  { key: "paypal", title: "PayPal", url: "https://mcp.paypal.com/mcp", what: "invoices, orders, and transactions" },
  { key: "vercel", title: "Vercel", url: "https://mcp.vercel.com", what: "deployments, projects, and logs" },
  { key: "neon", title: "Neon", url: "https://mcp.neon.tech/mcp", what: "Postgres databases and branches" },
  { key: "supabase", title: "Supabase", url: "https://mcp.supabase.com/mcp", what: "database, auth, and storage" },
  { key: "canva", title: "Canva", url: "https://mcp.canva.com/mcp", what: "designs and brand assets" },
  { key: "webflow", title: "Webflow", url: "https://mcp.webflow.com/mcp", what: "sites and CMS collections" },
  // No DCR — needs fez's one-time registered client_id (the gh precedent).
  { key: "github", title: "GitHub", url: "https://api.githubcopilot.com/mcp/", what: "repos, PRs, issues", clientId: undefined },
];

/**
 * Resolve a connection from BOTH homes: the shipped seed catalog above,
 * and this machine's settings.json — any mcpServers entry with
 * auth:"oauth" is connectable, which is what makes connections
 * community-ownable: an extension (or a hand edit) that installs
 *   "linear2": { type:"http", url:"…", auth:"oauth", scope?, clientId? }
 * is a full citizen with zero presence in fez's own list. Settings win
 * over the seed (this machine's truth), seed fills the gaps (titles,
 * shipped client_ids).
 */
export function connectionEntry(key: string): ConnectionEntry | undefined {
  const seed = CONNECTIONS.find((c) => c.key === key);
  let s: { url?: unknown; auth?: unknown; scope?: unknown; clientId?: unknown; title?: unknown; what?: unknown } | undefined;
  try {
    s = (loadSettings() as { mcpServers?: Record<string, typeof s> }).mcpServers?.[key];
  } catch {
    /* settings unavailable — seed only */
  }
  if (s && s.auth === "oauth" && typeof s.url === "string") {
    return {
      key,
      title: typeof s.title === "string" ? s.title : seed?.title ?? key,
      url: s.url,
      scope: typeof s.scope === "string" ? s.scope : seed?.scope,
      clientId: typeof s.clientId === "string" ? s.clientId : seed?.clientId,
      what: typeof s.what === "string" ? s.what : seed?.what ?? "",
    };
  }
  return seed;
}

// ── keychain custody ────────────────────────────────────────────────────
// One item per connection: service "fez-skill-env", account "<key>.OAUTH",
// value a JSON blob {client, tokens, verifier} — same store, listing and
// rotation as every other skill secret.

interface Blob {
  client?: unknown;
  tokens?: { access_token?: string; refresh_token?: string; expires_in?: number; [k: string]: unknown };
  verifier?: string;
  /** Stamped at save so expires_in can be judged later. */
  savedAt?: number;
}

const KC_SERVICE = "fez-skill-env";
const account = (key: string) => `${key}.OAUTH`;

export function readConnection(key: string): Blob | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const raw = execFileSync("security", ["find-generic-password", "-s", KC_SERVICE, "-a", account(key), "-w"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return raw ? (JSON.parse(raw) as Blob) : undefined;
  } catch {
    return undefined;
  }
}

function writeConnection(key: string, patch: Partial<Blob>): void {
  const next = { ...(readConnection(key) ?? {}), ...patch };
  execFileSync("security", ["add-generic-password", "-U", "-s", KC_SERVICE, "-a", account(key), "-w", JSON.stringify(next)], {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

export function disconnectService(key: string): void {
  try {
    execFileSync("security", ["delete-generic-password", "-s", KC_SERVICE, "-a", account(key)], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    /* nothing stored — already disconnected */
  }
}

/** Stale = past ~90% of its lifetime (refresh-before-use, not on failure). */
export function isStale(blob: Blob | undefined, now = Date.now()): boolean {
  const t = blob?.tokens;
  if (!t?.access_token) return true;
  if (!t.expires_in || !blob?.savedAt) return false; // no expiry told to us — assume usable
  return now - blob.savedAt > t.expires_in * 1000 * 0.9;
}

// ── the OAuthClientProvider over that custody ───────────────────────────

class NeedsSignIn extends Error {
  constructor(public authUrl?: string) {
    super("this connection needs a browser sign-in — run `fez connect`");
  }
}

function makeProvider(
  entry: ConnectionEntry,
  opts: { port?: number; onAuthUrl?: (url: string) => void }
): OAuthClientProvider {
  const redirect = opts.port ? `http://127.0.0.1:${opts.port}/callback` : undefined;
  return {
    get redirectUrl() {
      return redirect;
    },
    get clientMetadata() {
      return {
        client_name: "fez",
        redirect_uris: redirect ? [redirect] : [],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(entry.scope ? { scope: entry.scope } : {}),
      };
    },
    clientInformation() {
      // A shipped client_id (GitHub bucket) outranks anything DCR saved.
      if (entry.clientId) return { client_id: entry.clientId };
      return readConnection(entry.key)?.client as never;
    },
    saveClientInformation(info) {
      writeConnection(entry.key, { client: info });
    },
    tokens() {
      return readConnection(entry.key)?.tokens as never;
    },
    saveTokens(tokens) {
      writeConnection(entry.key, { tokens: tokens as never, savedAt: Date.now() });
    },
    saveCodeVerifier(v) {
      writeConnection(entry.key, { verifier: v });
    },
    codeVerifier() {
      const v = readConnection(entry.key)?.verifier;
      if (!v) throw new Error("no PKCE verifier saved — restart the connect flow");
      return v;
    },
    redirectToAuthorization(url) {
      if (!opts.onAuthUrl) throw new NeedsSignIn(url.href);
      opts.onAuthUrl(url.href);
    },
  };
}

// ── connect: the interactive flow (loopback + browser) ──────────────────

/**
 * Run the full sign-in for a catalog entry. Opens the browser (or hands
 * the URL to `onAuthUrl` — the in-chat path), catches the callback on a
 * one-shot 127.0.0.1 listener, exchanges the code, lands tokens in the
 * keychain. Resolves when connected.
 */
export async function connectService(
  key: string,
  opts: { onAuthUrl?: (url: string) => void; timeoutMs?: number } = {}
): Promise<void> {
  const entry = connectionEntry(key);
  if (!entry) throw new Error(`unknown connection "${key}" — \`fez connect\` lists what's available`);
  if (entry.key === "github" && !entry.clientId) {
    throw new Error(
      "GitHub's OAuth doesn't support dynamic registration — fez needs its one-time registered client_id shipped in the catalog first. Until then: paste a PAT into the github keycard (SKILLS & SECRETS), which its MCP server accepts."
    );
  }

  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const openUrl = opts.onAuthUrl ?? ((url: string) => void execFile("open", [url]));
  const provider = makeProvider(entry, { port, onAuthUrl: openUrl });

  try {
    const first = await auth(provider, { serverUrl: entry.url });
    if (first === "AUTHORIZED") return; // valid tokens already in the keychain

    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sign-in timed out — nothing arrived on the callback")), opts.timeoutMs ?? 5 * 60_000);
      server.on("request", (req, res) => {
        const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        if (!u.pathname.startsWith("/callback")) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<body style="font-family:system-ui;padding:3em"><h2>fez connected to ${entry.title}.</h2>You can close this tab.</body>`);
        clearTimeout(timer);
        const err = u.searchParams.get("error");
        if (err) reject(new Error(`${entry.title} refused: ${err} ${u.searchParams.get("error_description") ?? ""}`));
        else resolve(u.searchParams.get("code") ?? "");
      });
    });

    const result = await auth(provider, { serverUrl: entry.url, authorizationCode: code });
    if (result !== "AUTHORIZED") throw new Error(`token exchange ended in ${result}`);

    // Register the skill so personas can declare it — auth:"oauth" is
    // what routes the entry through withFreshOAuth at spawn. Done here,
    // not in the CLI, so every connect surface (CLI, desktop, in-chat)
    // leaves the machine in the same state.
    const settings = loadSettings() as { mcpServers?: Record<string, Record<string, unknown>> };
    const existing = settings.mcpServers?.[key] ?? {};
    saveSettings({
      mcpServers: { ...settings.mcpServers, [key]: { headers: [], ...existing, type: "http", url: entry.url, auth: "oauth" } },
    } as never);
    markOAuthServer(key);
  } finally {
    server.close();
  }
}

// ── refresh-before-use: the spawn-time path ─────────────────────────────

/**
 * A fresh access token for a connected service — refreshing first when
 * stale, never opening a browser (a spawn must not pop UI; not-connected
 * throws NeedsSignIn instead).
 */
export async function freshToken(key: string): Promise<string> {
  const entry = connectionEntry(key);
  if (!entry) throw new Error(`unknown connection "${key}"`);
  const blob = readConnection(key);
  if (!blob?.tokens?.access_token && !blob?.tokens?.refresh_token) throw new NeedsSignIn();
  if (!isStale(blob)) return blob.tokens!.access_token!;
  const provider = makeProvider(entry, {}); // no port, no browser — refresh only
  const result = await auth(provider, { serverUrl: entry.url });
  if (result !== "AUTHORIZED") throw new NeedsSignIn();
  const token = readConnection(key)?.tokens?.access_token;
  if (!token) throw new NeedsSignIn();
  return token;
}

// ── the harness seam ────────────────────────────────────────────────────
// mcp-servers.ts marks names whose settings entry says auth:"oauth";
// harness.ts calls withFreshOAuth on the resolved list right before
// withMcpServer. Import runs one way (mcp-servers → connections), no cycle.

const oauthNames = new Set<string>();
export function markOAuthServer(name: string): void {
  oauthNames.add(name);
}

interface HeaderedServer {
  name?: string;
  headers?: { name: string; value: string }[];
  [k: string]: unknown;
}

/**
 * Swap fresh Bearer tokens into oauth-marked servers. A connection that
 * can't produce a token DROPS its server from the list (with one stderr
 * line) — the agent lacks the tool and says so, the existing honest-gap
 * behavior; a silently-401ing tool would be the bad outcome.
 */
export async function withFreshOAuth<T extends HeaderedServer>(servers: T[]): Promise<T[]> {
  const out: T[] = [];
  for (const server of servers) {
    const name = server.name ?? "";
    if (!oauthNames.has(name)) {
      out.push(server);
      continue;
    }
    try {
      const token = await freshToken(name);
      const headers = (server.headers ?? []).filter((h) => h.name.toLowerCase() !== "authorization");
      headers.push({ name: "Authorization", value: `Bearer ${token}` });
      out.push({ ...server, headers });
    } catch (e) {
      console.error(`⚠️  skill "${name}" withheld: ${e instanceof Error ? e.message : e}`);
    }
  }
  return out;
}
