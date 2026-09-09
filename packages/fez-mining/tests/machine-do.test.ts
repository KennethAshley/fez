import { describe, expect, it } from "vitest";
import { doProvision, doAlive, doDestroy, DO_SIZE } from "../src/machine-do.js";

const fakeFetch = (routes: Record<string, { status: number; body?: unknown }[]>) => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const counts: Record<string, number> = {};
  const f = async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    // Normalize only numeric path segments (droplet ids) to "N" — a plain
    // /\d+/g also clobbers the "v2" in the API base path, breaking every
    // route lookup regardless of implementation.
    const key = `${method} ${url.replace(/\/\d+(?=\/|$)/g, "/N")}`;
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const seq = routes[key] ?? [{ status: 404 }];
    const r = seq[Math.min(counts[key] ?? 0, seq.length - 1)];
    counts[key] = (counts[key] ?? 0) + 1;
    return { status: r.status, json: async () => r.body ?? {} };
  };
  return { f, calls };
};

const OPTS = { token: "tok", netuid: 56, persona: "gauss", servePorts: [7999], publicKey: "ssh-ed25519 AAA fez", keyPath: "/k" };

describe("DoMachine provisioner", () => {
  it("creates with cloud-init (fez key + docker), polls to active, returns ssh spec", async () => {
    const { f, calls } = fakeFetch({
      "POST https://api.digitalocean.com/v2/droplets": [
        { status: 202, body: { droplet: { id: 42 } } },
      ],
      "GET https://api.digitalocean.com/v2/droplets/N": [
        { status: 200, body: { droplet: { id: 42, status: "new", networks: { v4: [] } } } },
        { status: 200, body: { droplet: { id: 42, status: "active", networks: { v4: [{ type: "public", ip_address: "1.2.3.4" }] } } } },
      ],
    });
    const r = await doProvision(OPTS, f, 1);
    expect(r.ref).toBe("42");
    expect(r.ssh).toEqual({ host: "1.2.3.4", user: "root", keyPath: "/k", ports: [{ externalIp: "1.2.3.4", externalPort: 7999, internalPort: 7999 }] });
    const create = calls[0].body as { name: string; size: string; user_data: string };
    expect(create.name).toBe("fez-56-gauss");
    expect(create.size).toBe(DO_SIZE);
    expect(create.user_data).toContain("ssh-ed25519 AAA fez");
    expect(create.user_data).toContain("docker.io");
  });

  it("alive: active droplet true, 404 false", async () => {
    const live = fakeFetch({ "GET https://api.digitalocean.com/v2/droplets/N": [{ status: 200, body: { droplet: { id: 42, status: "active" } } }] });
    expect(await doAlive("tok", "42", live.f)).toBe(true);
    const gone = fakeFetch({});
    expect(await doAlive("tok", "42", gone.f)).toBe(false);
  });

  it("destroy issues DELETE, resolves on 204, and tolerates 404 (already gone = success)", async () => {
    const { f, calls } = fakeFetch({ "DELETE https://api.digitalocean.com/v2/droplets/N": [{ status: 204 }] });
    await doDestroy("tok", "42", f);
    expect(calls[0].method).toBe("DELETE");
    await doDestroy("tok", "42", fakeFetch({}).f); // 404 — resolves anyway
  });

  // Review finding #1 (CRITICAL): a swallowed destroy failure reads as
  // "billing stopped" to every caller — must throw instead so callers can
  // keep state pointing at the still-billing droplet.
  it("destroy throws on a non-2xx/404 status (401/5xx)", async () => {
    const { f } = fakeFetch({ "DELETE https://api.digitalocean.com/v2/droplets/N": [{ status: 500 }] });
    await expect(doDestroy("tok", "42", f)).rejects.toThrow(/500/);
  });

  it("destroy throws when the fetch itself rejects (network failure)", async () => {
    const rejecting = async () => { throw new Error("network unreachable"); };
    await expect(doDestroy("tok", "42", rejecting)).rejects.toThrow(/network unreachable/);
  });

  // Review finding #2 (IMPORTANT): a rate-limited (or otherwise erroring)
  // status check is UNKNOWN, not "dead" — treating it as dead triggers an
  // unwarranted destroy→recreate of a droplet that's actually fine.
  it("alive throws on a non-2xx/404 status (429 rate-limit) instead of reading it as dead", async () => {
    const { f } = fakeFetch({ "GET https://api.digitalocean.com/v2/droplets/N": [{ status: 429 }] });
    await expect(doAlive("tok", "42", f)).rejects.toThrow(/429/);
  });

  it("a failed create throws with DO's message", async () => {
    const { f } = fakeFetch({
      "POST https://api.digitalocean.com/v2/droplets": [{ status: 422, body: { message: "size unavailable" } }],
    });
    await expect(doProvision(OPTS, f, 1)).rejects.toThrow(/size unavailable/);
  });
});
