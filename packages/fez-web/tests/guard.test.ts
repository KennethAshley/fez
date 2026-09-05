import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { isPrivateAddress, guardedFetch } from "../src/guard.js";

// Minimal fetch stand-ins for the redirect tests below: only what guard.ts
// actually reads (res.status, res.headers.get(...), res.body?.getReader()).
// A real Headers so .get() behaves correctly; a real ReadableStream so the
// manual reader loop in guardedFetch works unmodified; null body for
// redirect hops, since guard.ts only calls res.body?.cancel() on those.
type StubResponse = { status: number; headers: Headers; body: ReadableStream<Uint8Array> | null };

function textBody(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function mkRes(status: number, opts: { location?: string; body?: string } = {}): StubResponse {
  return {
    status,
    headers: new Headers(opts.location ? { location: opts.location } : {}),
    body: opts.body !== undefined ? textBody(opts.body) : null,
  };
}

function stubFetch(routes: Record<string, StubResponse>) {
  const impl = async (input: RequestInfo | URL): Promise<StubResponse> => {
    const url = input.toString();
    const r = routes[url];
    if (!r) throw new Error(`unstubbed fetch: ${url}`);
    return r;
  };
  globalThis.fetch = impl as unknown as typeof fetch;
}

describe("isPrivateAddress", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.10.10", "::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "feb0::1", "fec0::1"]) {
    it(`refuses ${ip}`, () => expect(isPrivateAddress(ip)).toBe(true));
  }
  for (const ip of ["1.1.1.1", "142.250.80.46", "172.15.0.1", "172.32.0.1", "2606:4700::1111"]) {
    it(`allows ${ip}`, () => expect(isPrivateAddress(ip)).toBe(false));
  }
});

describe("isPrivateAddress — IPv4-mapped IPv6, hex-group form", () => {
  // These are the canonical forms Node's URL parser produces for literal
  // IPv4-mapped hosts (e.g. "[::ffff:127.0.0.1]" canonicalizes to hostname
  // "::ffff:7f00:1"), not hand-typed dotted strings.
  for (const ip of ["::ffff:7f00:1", "::ffff:a00:1", "::ffff:c0a8:101", "::ffff:ac10:1"]) {
    it(`refuses ${ip}`, () => expect(isPrivateAddress(ip)).toBe(true));
  }
  it("allows a public mapped address", () => expect(isPrivateAddress("::ffff:101:101")).toBe(false));
});

describe("guardedFetch refuses IPv4-mapped loopback literal", () => {
  it("refuses http://[::ffff:127.0.0.1]/", async () => {
    await expect(guardedFetch("http://[::ffff:127.0.0.1]/")).rejects.toThrow(/private|internal/i);
  });
});

describe("guardedFetch refusals (no network needed)", () => {
  it("refuses non-http schemes", async () => {
    await expect(guardedFetch("ftp://example.com/x")).rejects.toThrow(/http/i);
    await expect(guardedFetch("file:///etc/passwd")).rejects.toThrow(/http/i);
  });
  it("refuses literal private hosts before any DNS", async () => {
    await expect(guardedFetch("http://127.0.0.1:7777/")).rejects.toThrow(/private|internal/i);
    await expect(guardedFetch("http://[::1]/")).rejects.toThrow(/private|internal/i);
    await expect(guardedFetch("http://localhost/")).rejects.toThrow(/private|internal/i);
  });
});

describe("guardedFetch — redirects (stubbed fetch)", () => {
  let realFetch: typeof fetch;
  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("refuses a redirect to a private address", async () => {
    stubFetch({ "http://1.1.1.1/": mkRes(302, { location: "http://127.0.0.1/" }) });
    await expect(guardedFetch("http://1.1.1.1/")).rejects.toThrow(/private|internal/i);
  });

  it("refuses a chain of 4 redirects", async () => {
    stubFetch({
      "http://1.1.1.1/": mkRes(302, { location: "http://2.2.2.2/" }),
      "http://2.2.2.2/": mkRes(302, { location: "http://3.3.3.3/" }),
      "http://3.3.3.3/": mkRes(302, { location: "http://4.4.4.4/" }),
      "http://4.4.4.4/": mkRes(302, { location: "http://5.5.5.5/" }),
    });
    await expect(guardedFetch("http://1.1.1.1/")).rejects.toThrow(/redirects/i);
  });

  it("follows one public-to-public redirect and returns the body", async () => {
    stubFetch({
      "http://1.1.1.1/": mkRes(302, { location: "http://2.2.2.2/" }),
      "http://2.2.2.2/": mkRes(200, { body: "hello world" }),
    });
    const res = await guardedFetch("http://1.1.1.1/");
    expect(res.finalUrl).toBe("http://2.2.2.2/");
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello world");
  });
});
