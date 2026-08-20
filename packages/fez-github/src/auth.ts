import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * GitHub auth by device flow — no client secret, because a desktop app
 * cannot keep one.
 *
 * Any flow that needs a secret on the user's machine is a flow that
 * lies: the "secret" ships inside the app and anyone can read it out.
 * The device flow exists for exactly this shape of program — it is what
 * `gh auth login` uses — and needs only the client ID, which is public.
 *
 * The app is a GITHUB App, not an OAuth App, so there are no scopes to
 * request here. Its permissions (issues, pull requests, checks — all
 * read-only) and its repository list are fixed when you install it, on
 * GitHub, before fez asks for anything. A repo the app is not installed
 * on is not one fez declines to read; it is one fez cannot see. See
 * SETUP.md.
 */

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";

/** Keychain custody, same service the rest of fez's third-party secrets use. */
const KEYCHAIN_SERVICE = "fez-skill-env";
const ACCOUNT_TOKEN = "fez-github.token";
const ACCOUNT_REFRESH = "fez-github.refresh";
const ACCOUNT_CLIENT = "fez-github.client_id";

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds between polls — GitHub adds 5s every time you go too fast. */
  interval: number;
  expiresIn: number;
}

export interface Tokens {
  token: string;
  refreshToken?: string;
  /** Epoch ms. GitHub App user tokens are short-lived (8h). */
  expiresAt?: number;
}

async function post(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} from ${new URL(url).pathname}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Step 1: ask for a code the user will type into github.com. */
export async function requestDeviceCode(clientId: string): Promise<DeviceCode> {
  const body = await post(DEVICE_CODE_URL, { client_id: clientId });
  if (typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    // The commonest cause by far, and the error GitHub returns for it is
    // unhelpful — so name the fix rather than echoing the payload.
    throw new Error(
      `GitHub refused the device code request. Device Flow is OFF by default: ` +
        `enable it on the app's settings page. (${JSON.stringify(body).slice(0, 160)})`
    );
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: typeof body.verification_uri === "string" ? body.verification_uri : "https://github.com/login/device",
    interval: typeof body.interval === "number" ? body.interval : 5,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 900,
  };
}

/**
 * One poll. Returns tokens, or the reason to keep waiting.
 *
 * Split out from the loop so the four outcomes are testable without
 * fifteen minutes of real time: still waiting, slow down, the user said
 * no, the code died.
 */
export type PollResult =
  | { status: "ok"; tokens: Tokens }
  | { status: "pending" }
  | { status: "slow_down"; addSeconds: number }
  | { status: "denied"; why: string }
  | { status: "expired" };

export function readPoll(body: Record<string, unknown>, now = Date.now()): PollResult {
  if (typeof body.access_token === "string") {
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : undefined;
    return {
      status: "ok",
      tokens: {
        token: body.access_token,
        refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
        expiresAt: expiresIn ? now + expiresIn * 1000 : undefined,
      },
    };
  }
  switch (body.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      // GitHub adds 5s to the required interval each time this happens.
      return { status: "slow_down", addSeconds: typeof body.interval === "number" ? body.interval : 5 };
    case "expired_token":
      return { status: "expired" };
    case "access_denied":
      return { status: "denied", why: "you declined the authorization" };
    default:
      return { status: "denied", why: typeof body.error_description === "string" ? body.error_description : String(body.error ?? "unknown error") };
  }
}

/** Step 3: poll until the user finishes, or the code dies. */
export async function pollForToken(clientId: string, code: DeviceCode, onWait?: (seconds: number) => void): Promise<Tokens> {
  let interval = code.interval;
  const deadline = Date.now() + code.expiresIn * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    onWait?.(interval);
    const body = await post(TOKEN_URL, {
      client_id: clientId,
      device_code: code.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const result = readPoll(body);
    if (result.status === "ok") return result.tokens;
    if (result.status === "slow_down") { interval += result.addSeconds; continue; }
    if (result.status === "pending") continue;
    if (result.status === "expired") break;
    throw new Error(result.why);
  }
  throw new Error("the code expired — run connect again");
}

/**
 * Refresh a short-lived user token.
 *
 * GitHub App user tokens last 8 hours. Refreshing normally needs the
 * client secret — except for tokens minted by the device flow, which is
 * the one reason this can work at all in a program with no server.
 */
export async function refresh(clientId: string, refreshToken: string): Promise<Tokens> {
  const body = await post(TOKEN_URL, {
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const result = readPoll(body);
  if (result.status !== "ok") throw new Error("refresh failed — reconnect with: fez github connect");
  return result.tokens;
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
