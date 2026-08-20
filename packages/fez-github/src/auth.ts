import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createOAuthDeviceAuth } from "@octokit/auth-oauth-device";
import { DEFAULT_CLIENT_ID, type DeviceCodeLike } from "./app-id.js";

const run = promisify(execFile);

/**
 * GitHub auth by device flow — no client secret, because a desktop app
 * cannot keep one.
 *
 * Any flow needing a secret on the user's machine is a flow that lies:
 * the "secret" ships inside the app and anyone can read it out. The
 * device flow exists for exactly this shape of program — it is what
 * `gh auth login` uses — and needs only the client ID, which is public.
 *
 * The protocol itself is @octokit/auth-oauth-device, GitHub's own
 * strategy package, rather than the hand-rolled version this file used
 * to hold: requesting the code, polling, honouring `slow_down` (GitHub
 * adds five seconds every time you poll too fast), and giving up when
 * the code expires. That was ~120 lines of protocol we had to keep
 * correct against someone else's spec, and the package is isomorphic —
 * the SAME call runs in the webview, so the panel and the CLI cannot
 * drift into two different flows.
 *
 * The app is a GITHUB App, not an OAuth App, so there are no scopes to
 * request. Its permissions (issues, pull requests, checks — all
 * read-only) and its repository list are fixed when you install it, on
 * GitHub, before fez asks for anything. A repo the app is not installed
 * on is not one fez declines to read; it is one fez cannot see.
 */

const TOKEN_URL = "https://github.com/login/oauth/access_token";

/** Keychain custody, same service the rest of fez's third-party secrets use. */
const KEYCHAIN_SERVICE = "fez-skill-env";
const ACCOUNT_TOKEN = "fez-github.token";
const ACCOUNT_REFRESH = "fez-github.refresh";
const ACCOUNT_CLIENT = "fez-github.client_id";

export interface Tokens {
  token: string;
  refreshToken?: string;
  /** Epoch ms. GitHub App user tokens are short-lived (8h). */
  expiresAt?: number;
}

/** The App to authenticate as — fez's own unless you point it elsewhere. */
export function appClientId(): string {
  return process.env.FEZ_GITHUB_CLIENT_ID?.trim() || DEFAULT_CLIENT_ID;
}

/**
 * Connect: hand back the code to show, resolve when the human approves.
 *
 * `onCode` fires once, as soon as GitHub issues the code — that is the
 * moment to open the browser and put the code on the clipboard. The
 * promise then sits there until they approve, decline, or the code
 * dies, which is the package's problem rather than ours.
 */
export async function connect(
  onCode: (code: DeviceCodeLike) => void,
  clientId = appClientId()
): Promise<Tokens> {
  const auth = createOAuthDeviceAuth({
    clientType: "github-app",
    clientId,
    onVerification: (v) => onCode({ userCode: v.user_code, verificationUri: v.verification_uri }),
  });
  const result = (await auth({ type: "oauth" })) as {
    token: string;
    refreshToken?: string;
    expiresAt?: string;
  };
  const tokens: Tokens = {
    token: result.token,
    refreshToken: result.refreshToken,
    expiresAt: result.expiresAt ? Date.parse(result.expiresAt) : undefined,
  };
  await saveTokens(clientId, tokens);
  return tokens;
}

/**
 * Refresh a short-lived user token — by hand, and deliberately.
 *
 * @octokit/oauth-methods has refreshToken(), but its signature requires
 * a clientSecret, so fez cannot call it. GitHub's API turns out not to
 * require one for a token the device flow minted: posting client_id +
 * grant_type=refresh_token alone is accepted. Verified against the live
 * API on 2026-08-20 — the response carried a fresh 8h token and a new
 * refresh token.
 *
 * So this is fifteen lines the package cannot replace rather than
 * fifteen lines nobody checked, and it is what lets the extension
 * outlive its first eight hours on a machine holding no secret. If
 * GitHub ever tightens this, the fix is to turn OFF expiring user
 * tokens on the App, which removes the need for any refresh at all.
 */
export async function refresh(clientId: string, refreshToken: string): Promise<Tokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body.access_token !== "string") {
    throw new Error(
      `refresh refused (${String(body.error ?? res.status)}) — reconnect from settings → extensions → fez-github`
    );
  }
  return {
    token: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : refreshToken,
    expiresAt: typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : undefined,
  };
}

// ── keychain ────────────────────────────────────────────────────────

async function keychainSet(account: string, value: string): Promise<void> {
  await run("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", value]);
}

async function keychainGet(account: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function saveTokens(clientId: string, tokens: Tokens): Promise<void> {
  await keychainSet(ACCOUNT_CLIENT, clientId);
  await keychainSet(ACCOUNT_TOKEN, JSON.stringify({ token: tokens.token, expiresAt: tokens.expiresAt }));
  if (tokens.refreshToken) await keychainSet(ACCOUNT_REFRESH, tokens.refreshToken);
}

/** A minute of slack, so a token never expires mid-request. */
const SKEW_MS = 60_000;

export function isExpired(expiresAt: number | undefined, now = Date.now()): boolean {
  return expiresAt !== undefined && now >= expiresAt - SKEW_MS;
}

/**
 * The current access token, refreshed if it has aged out. Undefined when
 * nobody has connected — which the caller must report as "not connected"
 * rather than as an error, because it is the normal state before setup.
 */
export async function currentToken(): Promise<string | undefined> {
  const raw = await keychainGet(ACCOUNT_TOKEN);
  if (!raw) return undefined;
  let stored: { token?: string; expiresAt?: number };
  try {
    stored = JSON.parse(raw) as typeof stored;
  } catch {
    return undefined;
  }
  if (!stored.token) return undefined;
  if (!isExpired(stored.expiresAt)) return stored.token;

  const [clientId, refreshToken] = await Promise.all([keychainGet(ACCOUNT_CLIENT), keychainGet(ACCOUNT_REFRESH)]);
  if (!clientId || !refreshToken) return undefined;
  const next = await refresh(clientId, refreshToken);
  await saveTokens(clientId, next);
  return next.token;
}

export async function savedClientId(): Promise<string | undefined> {
  return keychainGet(ACCOUNT_CLIENT);
}
