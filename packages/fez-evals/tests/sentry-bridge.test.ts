import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../fez-sentry/src/config.js";
import { pollSentry } from "../../fez-sentry/src/headless.js";
import { fetchIssues, SentryRateLimit } from "../../fez-sentry/src/sentry.js";

const bridge = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../../fez-client/src/bridge-work.js", () => ({
  bridgeScope: (owner: string, relay: string) => `${owner}:${relay}`,
  readBridgeConfig: async (_nostr: unknown, _name: string, parse: (value: unknown) => unknown) => parse(bridge.current),
  requireBridgeTarget: async () => undefined,
  externalText: (text: string, max = 200) => text.replace(/@/g, "＠").slice(0, max),
  bridgeMessage: ({ channelId, content, threadRoot }: Record<string, string>) => ({ kind: 47103, content, tags: [["h", channelId], ...(threadRoot ? [["e", threadRoot, "", "root"]] : [])] }),
  bridgeTask: ({ channelId, worker, content, threadRoot }: Record<string, string>) => ({
    kind: 47103, tags: [["h", channelId], ["e", threadRoot, "", "root"], ["p", worker], ["task", worker]], content,
  }),
  publishOnce: async (nostr: { publish(event: unknown): Promise<unknown> }, storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }, key: string, template: Record<string, unknown>) => {
    let event = await storage.get(key);
    if (!event) { event = { ...template, id: key }; await storage.set(key, event); }
    return nostr.publish(event);
  },
}));
vi.mock("../../../src/extensions/mcp-servers.js", () => ({ keychainSecret: () => undefined }));

const config = { enabled: true, autoInvestigate: true, origin: "https://sentry.io", organization: "acme", project: "web", repo: "acme/web", channelId: "channel", worker: "b".repeat(64) };
const started = Date.parse("2026-09-11T12:00:00Z");
const issue = (overrides = {}) => ({ id: "1", project: { id: "42", slug: "web" }, title: "Crash @someone", count: "1", status: "unresolved", firstSeen: "2026-09-11T12:01:00Z", lastSeen: "2026-09-11T12:01:00Z", ...overrides });

function harness() {
  const values = new Map<string, unknown>();
  const published: Record<string, unknown>[] = [];
  const storage = { get: vi.fn(async <T>(key: string) => structuredClone(values.get(key)) as T | undefined), set: vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)); }) };
  const publish = vi.fn(async (event: Record<string, unknown>) => { published.push(event); return event; });
  const api = { storage, workspace: { owner: "a".repeat(64), relayUrl: "wss://relay.example" } };
  const ctx = { ownerPubkey: "a".repeat(64), nostr: { pubkey: "a".repeat(64), publish }, channels: { list: async () => [{ id: "channel", name: "bugs" }] }, missedWindow: false };
  let rows: unknown[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(String(input).includes("/projects/") ? { id: "42", slug: "web", organization: { slug: "acme" } } : rows)));
  const poll = () => pollSentry(api as Parameters<typeof pollSentry>[0], ctx as unknown as Parameters<typeof pollSentry>[1], { fetch, token: () => "secret", now: () => started });
  return { values, published, storage, publish, api, ctx, fetch, poll, rows: (next: unknown[]) => { rows = next; } };
}

beforeEach(() => { bridge.current = { ...config }; });

describe("Sentry incident bridge", () => {
  it("baselines even an empty project and only investigates brand-new issues once", async () => {
    const h = harness();
    await h.poll();
    expect(h.published).toEqual([]);
    h.rows([issue()]);
    await h.poll();
    expect(h.published).toHaveLength(2);
    const [root, task] = h.published;
    expect(root.content).not.toContain("@someone");
    expect(task.content).toContain("draft pull request");
    expect(task.content).toContain("acme/web");
    expect(task.content).toContain("reproduce");
    expect(task.tags).toContainEqual(["e", root.id, "", "root"]);
    await h.poll();
    expect(h.published).toHaveLength(2);
  });

  it("updates repeated, resolved and regressed incidents in the original thread without another task", async () => {
    const h = harness();
    await h.poll(); h.rows([issue()]); await h.poll();
    const root = h.published[0].id;
    for (const change of [{ count: "2" }, { count: "2", status: "resolved" }, { count: "3", status: "unresolved" }]) {
      h.rows([issue(change)]); await h.poll();
    }
    expect(h.published).toHaveLength(5);
    for (const reply of h.published.slice(2)) expect(reply.tags).toContainEqual(["e", root, "", "root"]);
    expect(h.published.filter(event => (event.tags as string[][]).some(tag => tag[0] === "task"))).toHaveLength(1);
  });

  it("does not investigate baseline issues or older issues newly visible in the window", async () => {
    const h = harness(); h.rows([issue({ firstSeen: "2026-09-10T12:00:00Z" })]); await h.poll();
    h.rows([issue({ firstSeen: "2026-09-10T12:00:00Z", count: "2" }), issue({ id: "2", firstSeen: "2026-09-09T12:00:00Z" })]);
    await h.poll();
    expect(h.published.filter(event => (event.tags as string[][]).some(tag => tag[0] === "task"))).toHaveLength(0);
  });

  it("retains a pending incident after publication failure even if the source no longer returns it", async () => {
    const h = harness(); await h.poll(); h.rows([issue()]);
    h.publish.mockRejectedValueOnce(new Error("relay offline"));
    await expect(h.poll()).rejects.toThrow(); h.rows([]); await h.poll();
    expect(h.published).toHaveLength(2);
  });

  it("reuses delivery IDs after a state save fails and a poller restarts", async () => {
    const h = harness(); await h.poll(); h.rows([issue()]);
    const set = h.storage.set.getMockImplementation()!;
    let fail = true;
    h.storage.set.mockImplementation(async (key, value) => {
      if (fail && h.published.length === 2 && key.startsWith("watch:")) { fail = false; throw Error("disk full"); }
      return set(key, value);
    });
    await expect(h.poll()).rejects.toThrow("disk full");
    await h.poll();
    expect(new Set(h.published.map(event => event.id)).size).toBe(2);
  });

  it("stops dispatch after a mid-poll config change and baselines a moved channel", async () => {
    const h = harness(); await h.poll(); h.rows([issue()]);
    const fetch = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation(async input => { const response = await fetch(input); bridge.current = { ...config, enabled: false }; return response; });
    await h.poll(); expect(h.published).toHaveLength(0);
    h.fetch.mockImplementation(fetch); bridge.current = { ...config, channelId: "other" }; await h.poll();
    expect(h.published).toHaveLength(0);
  });

  it("fails closed on wrong-project or malformed API data and leaves baseline intact", async () => {
    const h = harness(); h.rows([issue({ project: { id: "99", slug: "elsewhere" } })]);
    await expect(h.poll()).rejects.toThrow("project");
    h.rows([issue()]); await h.poll(); expect(h.published).toEqual([]);
    h.rows([issue({ count: "NaN" })]); await expect(h.poll()).rejects.toThrow("count");
  });

  it("does not read Sentry or summon while disabled and respects automatic investigation opt-out", async () => {
    const h = harness(); bridge.current = { ...config, enabled: false }; await h.poll(); expect(h.fetch).not.toHaveBeenCalled();
    bridge.current = { ...config, autoInvestigate: false }; await h.poll(); h.rows([issue()]); await h.poll(); expect(h.published).toHaveLength(1);
  });

  it("preserves incident roots when investigation settings change", async () => {
    const h = harness(); await h.poll(); h.rows([issue()]); await h.poll();
    const root = h.published[0].id;
    bridge.current = { ...config, autoInvestigate: false, revision: "changed" };
    h.rows([issue({ count: "2" })]); await h.poll();
    expect(h.published).toHaveLength(3);
    expect(h.published[2].tags).toContainEqual(["e", root, "", "root"]);
  });

  it("rechecks consent after the outbox has persisted a prepared message", async () => {
    const h = harness(); await h.poll(); h.rows([issue()]);
    const set = h.storage.set.getMockImplementation()!;
    h.storage.set.mockImplementation(async (key, value) => {
      await set(key, value);
      if (key.endsWith(":message")) bridge.current = { ...config, enabled: false };
    });
    await expect(h.poll()).rejects.toThrow("settings changed");
    expect(h.published).toHaveLength(0);
  });

  it("preserves a partially published root but suppresses its pending task after consent changes", async () => {
    const h = harness(); await h.poll(); h.rows([issue()]);
    const publish = h.publish.getMockImplementation()!;
    h.publish.mockImplementationOnce(async event => {
      const result = await publish(event);
      bridge.current = { ...config, autoInvestigate: false, revision: "changed" };
      return result;
    });
    await h.poll(); const root = h.published[0].id;
    h.rows([issue({ count: "2" })]); await h.poll();
    expect(h.published.filter(event => (event.tags as string[][]).some(tag => tag[0] === "task"))).toHaveLength(0);
    expect(new Set(h.published.map(event => event.id)).size).toBe(2);
    expect(h.published.at(-1)!.tags).toContainEqual(["e", root, "", "root"]);
  });
});

describe("Sentry API and settings boundaries", () => {
  it("follows cursors on the fixed organization endpoint with empty query", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/projects/")) return new Response(JSON.stringify({ id: "42", slug: "web", organization: { slug: "acme" } }));
      expect(url.pathname).toBe("/api/0/organizations/acme/issues/"); expect(url.searchParams.get("project")).toBe("42"); expect(url.searchParams.get("query")).toBe("");
      return new Response(JSON.stringify([issue({ id: url.searchParams.has("cursor") ? "2" : "1" })]), { headers: url.searchParams.has("cursor") ? {} : { Link: '<https://sentry.io/api/0/organizations/acme/issues/?cursor=0:100:0>; rel="next"; results="true"' } });
    });
    expect(await fetchIssues(parseConfig(config), "secret", fetch)).toHaveLength(2);
  });

  it("rejects unsafe pagination, rate limits, and truncated full pages without a cursor", async () => {
    for (const response of [
      new Response("[]", { headers: { Link: '<https://evil.test/?cursor=1>; rel="next"; results="true"' } }),
      new Response("secret", { status: 429 }),
      new Response(JSON.stringify(Array.from({ length: 100 }, (_, id) => issue({ id: String(id + 1) })))),
    ]) {
      const fetch = vi.fn(async (input: string | URL | Request) => String(input).includes("/projects/") ? new Response(JSON.stringify({ id: "42", slug: "web", organization: { slug: "acme" } })) : response);
      await expect(fetchIssues(parseConfig(config), "secret", fetch)).rejects.toThrow();
    }
  });

  it("fails the whole scan when a later page fails or the page bound is reached", async () => {
    for (const failPage of [2, 21]) {
      let page = 0;
      const fetch = vi.fn(async (input: string | URL | Request) => {
        if (String(input).includes("/projects/")) return new Response(JSON.stringify({ id: "42", slug: "web", organization: { slug: "acme" } }));
        page++;
        if (page === failPage) return new Response("private payload", { status: 503 });
        return new Response(JSON.stringify([issue({ id: String(page) })]), { headers: { Link: `<https://sentry.io/api/0/organizations/acme/issues/?cursor=0:${page * 100}:0>; rel="next"; results="true"` } });
      });
      await expect(fetchIssues(parseConfig(config), "secret", fetch)).rejects.toThrow(failPage === 2 ? "HTTP 503" : "20 pages");
      expect(page).toBe(failPage === 2 ? 2 : 20);
    }
  });

  it("bounds Retry-After without exposing response contents", async () => {
    const now = Date.now();
    const fetch = vi.fn(async () => new Response("private-token", { status: 429, headers: { "Retry-After": "999999" } }));
    try { await fetchIssues(parseConfig(config), "private-token", fetch); throw Error("expected a rate limit"); }
    catch (error) {
      expect(error).toBeInstanceOf(SentryRateLimit);
      expect((error as SentryRateLimit).retryAt).toBeGreaterThanOrEqual(now + 900_000);
      expect(String(error)).not.toContain("private-token");
    }
  });

  it("validates config without accepting arbitrary API URLs or malformed targets", () => {
    expect(parseConfig(undefined).enabled).toBe(false);
    for (const change of [{ origin: "https://evil.test" }, { repo: "acme/../web" }, { organization: "../" }, { worker: "@fez" }, { channelId: "" }, { autoInvestigate: "yes" }]) expect(() => parseConfig({ ...config, ...change })).toThrow();
  });
});
