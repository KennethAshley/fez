import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pollOnce, createPollerState } from "../src/poller.js";
import { upsertJob, readJobs, type RidgesJob } from "../src/store.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-ridges-poller-"));
});

function job(over: Partial<RidgesJob> = {}): RidgesJob {
  return {
    id: "job-1",
    ts: "2026-08-30T00:00:00.000Z",
    persona: "scout",
    issueUrl: "https://github.com/acme/widgets/issues/12",
    repo: "acme/widgets",
    issueNumber: 12,
    status: "working",
    updatedAt: "2026-08-30T00:00:00.000Z",
    ...over,
  };
}

function pr(over: Record<string, unknown> = {}) {
  return {
    number: 5,
    title: "fixes #12",
    body: "",
    state: "open",
    merged_at: null,
    html_url: "https://github.com/acme/widgets/pull/5",
    head: { ref: "issue-12-fix" },
    ...over,
  };
}

type Headers = Record<string, string>;

function okResponse(prs: unknown[], headers: Headers = {}) {
  return {
    status: 200,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? headers[n] ?? null },
    text: async () => JSON.stringify(prs),
  };
}

function notModified(headers: Headers = {}) {
  return {
    status: 304,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? headers[n] ?? null },
    text: async () => "",
  };
}

function rateLimited(reset: number) {
  return {
    status: 403,
    headers: {
      get: (n: string) => {
        const key = n.toLowerCase();
        if (key === "x-ratelimit-remaining") return "0";
        if (key === "x-ratelimit-reset") return String(reset);
        return null;
      },
    },
    text: async () => "",
  };
}

function notFound() {
  return { status: 404, headers: { get: () => null }, text: async () => "" };
}

describe("pollOnce", () => {
  it("does nothing when there are no open jobs", async () => {
    const fetchImpl = vi.fn();
    await pollOnce({ dir, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ignores refused/empty-repo rows", async () => {
    upsertJob(dir, job({ id: "refused-1", status: "refused", repo: "", issueNumber: 0 }));
    const fetchImpl = vi.fn();
    await pollOnce({ dir, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("matches a PR then transitions it to merged on a later tick", async () => {
    upsertJob(dir, job());
    const state = createPollerState();

    const fetchImpl1 = vi.fn(async () => okResponse([pr()], { etag: "W/\"v1\"" }));
    await pollOnce({ dir, fetchImpl: fetchImpl1, state, now: () => "2026-08-30T00:01:00.000Z" });

    let rows = readJobs(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pr-open", prNumber: 5, prUrl: "https://github.com/acme/widgets/pull/5" });
    expect(rows[0].updatedAt).toBe("2026-08-30T00:01:00.000Z");


    const fetchImpl2 = vi.fn(async () => okResponse([pr({ state: "closed", merged_at: "2026-08-30T00:02:00.000Z" })]));
    await pollOnce({ dir, fetchImpl: fetchImpl2, state, now: () => "2026-08-30T00:02:00.000Z" });

    rows = readJobs(dir);
    expect(rows[0]).toMatchObject({ status: "merged", prNumber: 5 });
  });

  it("never rebinds a job once it has matched a PR (first-match permanence)", async () => {
    upsertJob(dir, job());
    const state = createPollerState();

    await pollOnce({ dir, fetchImpl: vi.fn(async () => okResponse([pr({ number: 5 })])), state });
    expect(readJobs(dir)[0].prNumber).toBe(5);

    // A newer, also-matching PR (#9) appears first in the list.
    const fetchImpl2 = vi.fn(async () =>
      okResponse([pr({ number: 9, title: "fixes #12", head: { ref: "issue-12-take2" } }), pr({ number: 5 })])
    );
    await pollOnce({ dir, fetchImpl: fetchImpl2, state });
    expect(readJobs(dir)[0].prNumber).toBe(5);
  });

  it("sends If-None-Match once an etag is held, and a 304 changes nothing and does not rewrite history", async () => {
    upsertJob(dir, job());
    const state = createPollerState();

    await pollOnce({ dir, fetchImpl: vi.fn(async () => okResponse([pr()], { etag: '"abc123"' })), state });
    const beforeUpdatedAt = readJobs(dir)[0].updatedAt;

    const fetchImpl2 = vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      expect(init?.headers?.["If-None-Match"]).toBe('"abc123"');
      return notModified();
    });
    await pollOnce({ dir, fetchImpl: fetchImpl2, state, now: () => "2026-08-30T00:05:00.000Z" });

    expect(fetchImpl2).toHaveBeenCalledTimes(1);
    expect(readJobs(dir)[0].updatedAt).toBe(beforeUpdatedAt);
  });

  it("backs off a rate-limited repo until the reset time passes, without fetching", async () => {
    upsertJob(dir, job());
    const state = createPollerState();
    const resetEpoch = Math.floor(Date.parse("2026-08-30T00:10:00.000Z") / 1000);

    const fetchImpl1 = vi.fn(async () => rateLimited(resetEpoch));
    await pollOnce({ dir, fetchImpl: fetchImpl1, state, now: () => "2026-08-30T00:00:00.000Z" });
    expect(fetchImpl1).toHaveBeenCalledTimes(1);

    const fetchImpl2 = vi.fn(async () => rateLimited(resetEpoch));
    await pollOnce({ dir, fetchImpl: fetchImpl2, state, now: () => "2026-08-30T00:05:00.000Z" });
    expect(fetchImpl2).not.toHaveBeenCalled(); // still before reset

    const fetchImpl3 = vi.fn(async () => okResponse([pr()]));
    await pollOnce({ dir, fetchImpl: fetchImpl3, state, now: () => "2026-08-30T00:11:00.000Z" });
    expect(fetchImpl3).toHaveBeenCalledTimes(1); // past reset — fetched again
    expect(readJobs(dir)[0].prNumber).toBe(5);
  });

  it("marks a repo dead on 404 and never polls it again", async () => {
    upsertJob(dir, job());
    const state = createPollerState();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const fetchImpl1 = vi.fn(async () => notFound());
    await pollOnce({ dir, fetchImpl: fetchImpl1, state });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("acme/widgets");

    const fetchImpl2 = vi.fn();
    await pollOnce({ dir, fetchImpl: fetchImpl2, state });
    expect(fetchImpl2).not.toHaveBeenCalled();

    expect(readJobs(dir)[0]).toMatchObject({ status: "working" });
    warnSpy.mockRestore();
  });

  it("polls one repo once per tick across multiple open jobs in it", async () => {
    upsertJob(dir, job({ id: "a", issueNumber: 12 }));
    upsertJob(dir, job({ id: "b", issueNumber: 13, issueUrl: "https://github.com/acme/widgets/issues/13" }));
    const fetchImpl = vi.fn(async () => okResponse([]));
    await pollOnce({ dir, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("leaves a job unchanged when its matched PR number falls out of the fetched window", async () => {
    upsertJob(dir, job({ prNumber: 999, prUrl: "https://github.com/acme/widgets/pull/999", status: "pr-open" }));
    const fetchImpl = vi.fn(async () => okResponse([pr({ number: 5 })]));
    await pollOnce({ dir, fetchImpl });
    expect(readJobs(dir)[0]).toMatchObject({ status: "pr-open", prNumber: 999 });
  });
});
