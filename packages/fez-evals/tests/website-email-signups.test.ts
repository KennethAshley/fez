import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let captured: (request: Request) => Promise<Response>;
vi.stubGlobal("Deno", {
  env: { get: (key: string) => key === "SUPABASE_URL" ? "https://signup-db.test" : "test-service-key" },
  serve: (handler: typeof captured) => { captured = handler; },
});
await import("../../../infra/email-signups/index.ts");
const { POST } = await import("../../../web/app/api/email-signups/route.ts");

const writes: Request[] = [];
let storageStatus = 201;
let storageThrows = false;

beforeEach(() => {
  writes.length = 0;
  storageStatus = 201;
  storageThrows = false;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.includes("/functions/v1/email-signups")) return captured(request);
    if (request.url.startsWith("https://signup-db.test/rest/v1/")) {
      writes.push(request);
      if (storageThrows) throw new Error("private storage credentials");
      return new Response(storageStatus < 400 ? null : "private storage details", { status: storageStatus });
    }
    throw new Error(`Unexpected request: ${request.url}`);
  });
});

afterEach(() => vi.unstubAllGlobals());

function signup(body: unknown, origin = "https://fez.chat") {
  return POST(new Request("https://fez.chat/api/email-signups", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  }));
}

describe("website email collection", () => {
  it("persists a normalized address without exposing the list or replacing its signup date", async () => {
    for (let i = 0; i < 2; i++) {
      const response = await signup({ email: "  Person+beta@Example.COM  ", website: "" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
    expect(writes).toHaveLength(2);
    for (const request of writes) {
      expect(request.url).toBe("https://signup-db.test/rest/v1/fez_email_signups?on_conflict=email");
      expect(request.method).toBe("POST");
      expect(request.headers.get("prefer")).toBe("resolution=ignore-duplicates,return=minimal");
      expect(request.headers.get("authorization")).toBe("Bearer test-service-key");
      expect(await request.json()).toEqual({ email: "person+beta@example.com" });
    }
  });

  it.each([null, {}, { email: 12 }, { email: "" }, { email: "a@" }, { email: "a b@example.com" }, { email: `${"x".repeat(250)}@example.com` }])(
    "rejects malformed addresses before storage: %j", async body => {
      expect((await signup(body)).status).toBe(400);
      expect(writes).toHaveLength(0);
    },
  );

  it("discards a filled honeypot without adding an address", async () => {
    const response = await signup({ email: "bot@example.com", website: "https://spam.test" });
    expect(await response.json()).toEqual({ ok: true });
    expect(writes).toHaveLength(0);
  });

  it("rejects malformed JSON, oversized bodies and cross-origin submissions", async () => {
    const invalid = new Request("https://fez.chat/api/email-signups", { method: "POST", body: "{" });
    expect((await POST(invalid)).status).toBe(400);
    expect((await signup({ email: "a@example.com", extra: "x".repeat(2048) })).status).toBe(413);
    expect((await signup({ email: "a@example.com" }, "https://elsewhere.test")).status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it("accepts the public host when Next.js uses an internal request URL", async () => {
    const response = await POST(new Request("http://localhost:3467/api/email-signups", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://fez.chat", Host: "fez.chat" },
      body: JSON.stringify({ email: "person@example.com" }),
    }));
    expect(response.status).toBe(200);
    expect(writes).toHaveLength(1);
  });

  it("offers retry on storage failure without reporting success or leaking details", async () => {
    for (const failure of ["status", "network"]) {
      storageStatus = 500;
      storageThrows = failure === "network";
      const response = await signup({ email: "a@example.com" });
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.ok).not.toBe(true);
      expect(body.error).toMatch(/try again/i);
      expect(JSON.stringify(body)).not.toMatch(/private|credentials|a@example/);
    }
  });

  it("does not provide an endpoint for reading collected emails", async () => {
    expect((await captured(new Request("https://edge.test"))).status).toBe(405);
    expect(writes).toHaveLength(0);
  });
});
