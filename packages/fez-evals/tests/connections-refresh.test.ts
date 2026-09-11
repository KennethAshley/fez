import { afterEach, expect, it, vi } from "vitest";

const keychain = vi.hoisted(() => ({ value: "" }));
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn((_command: string, args: string[]) => {
    if (args[0] === "find-generic-password") return keychain.value;
    if (args[0] === "add-generic-password") {
      keychain.value = args[args.indexOf("-w") + 1];
      return "";
    }
    throw new Error("Unexpected keychain operation");
  }),
}));
import { freshToken, readConnection, markOAuthServer, withFreshOAuth } from "../../../src/extensions/connections.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("refreshes an expired connection without a browser and retains the refresh token", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  keychain.value = JSON.stringify({ tokens: { access_token: "expired", refresh_token: "refresh", expires_in: 3600 }, savedAt: 1 });
  let exchanges = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("oauth-protected-resource")) return Response.json({
      resource: "https://drivemcp.googleapis.com/mcp/v1",
      authorization_servers: ["https://accounts.google.com"],
    });
    if (url.includes(".well-known")) return Response.json({
      issuer: "https://accounts.google.com",
      authorization_endpoint: "https://accounts.google.com/authorize",
      token_endpoint: "https://accounts.google.com/token",
      response_types_supported: ["code"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      code_challenge_methods_supported: ["S256"],
    });
    if (url === "https://accounts.google.com/token") {
      const params = new URLSearchParams(String(init?.body));
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe("refresh");
      exchanges++;
      return Response.json({ access_token: `fresh-${exchanges}`, token_type: "Bearer", expires_in: 3600 });
    }
    throw new Error(`Unexpected OAuth request: ${url}`);
  }));
  expect(await freshToken("google-drive")).toBe("fresh-1");
  expect(readConnection("google-drive")?.tokens?.refresh_token).toBe("refresh");
  // A second expiry must remain refreshable when Google omits refresh_token.
  keychain.value = JSON.stringify({ ...JSON.parse(keychain.value), savedAt: 1 });
  expect(await freshToken("google-drive")).toBe("fresh-2");
  expect(exchanges).toBe(2);
});

it("fails an evaluation when an enabled OAuth tool cannot refresh instead of silently removing it", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  keychain.value = "";
  markOAuthServer("google-drive");
  vi.stubEnv("FEZ_EVALUATION_ACTIVE", "1");
  await expect(withFreshOAuth([{ name: "google-drive", headers: [] }])).rejects.toThrow("Evaluation tool unavailable: google-drive");
});
