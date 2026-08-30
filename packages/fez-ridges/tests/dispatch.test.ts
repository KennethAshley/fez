import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatchRidges, type DispatchDeps, type FetchLike, type X402Outcome } from "../src/dispatch.js";
import { readJobs, STORAGE_NAME } from "../src/store.js";

let dir: string;
let extensionDataDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-ridges-dispatch-"));
  extensionDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-ridges-extdata-"));
  process.env.FEZ_EXTENSION_DATA_DIR = extensionDataDir;
});

function readMirror() {
  return JSON.parse(fs.readFileSync(path.join(extensionDataDir, `${STORAGE_NAME}.json`), "utf8"));
}

function fakeGet(status: number, body = ""): FetchLike {
  return async () => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
}

function deps(over: Partial<DispatchDeps> = {}): DispatchDeps & { x402: ReturnType<typeof vi.fn> } {
  const defaultX402 = vi.fn(async (): Promise<X402Outcome> => ({ kind: "refused", message: "should not run" }));
  return {
    persona: "scout",
    dir,
    x402Deps: { fake: true },
    now: () => "2026-08-30T00:00:00.000Z",
    ...over,
    x402: (over.x402 as typeof defaultX402) ?? defaultX402,
  };
}

const ISSUE_URL = "https://github.com/acme/widgets/issues/42";

describe("dispatchRidges: invalid URL", () => {
  it("refuses before touching the network, records a refused row with usd undefined", async () => {
    const d = deps({ fetchImpl: fakeGet(200) });
    const message = await dispatchRidges(d, { issueUrl: "https://github.com/acme/widgets/pulls/42" });

    expect(message).toContain("not a github issue URL");
    expect(d.x402).not.toHaveBeenCalled();

    const jobs = readJobs(dir);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "refused", issueUrl: "https://github.com/acme/widgets/pulls/42" });
    expect(jobs[0].usd).toBeUndefined();

    const mirrored = readMirror();
    expect(mirrored.jobs).toHaveLength(1);
  });
});

describe("dispatchRidges: response outcome (app-not-installed guard)", () => {
  it("surfaces the detail verbatim, including the install link, and records a refused row", async () => {
    const detail = "the Ridges GitHub App is not installed on acme/widgets — install it at https://github.com/apps/ridges";
    const x402 = vi.fn(async (): Promise<X402Outcome> => ({
      kind: "response",
      status: 404,
      bodyText: JSON.stringify({ detail }),
    }));
    const d = deps({ x402, fetchImpl: fakeGet(200, JSON.stringify({ title: "Widget is broken" })) });

    const message = await dispatchRidges(d, { issueUrl: ISSUE_URL });

    expect(message).toBe(`ridges refused before payment — ${detail}`);
    expect(message).toContain("https://github.com/apps/ridges");

    const jobs = readJobs(dir);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "refused", repo: "acme/widgets", issueNumber: 42, title: "Widget is broken" });

    expect(readMirror().jobs).toHaveLength(1);
  });
});

describe("dispatchRidges: refused outcome", () => {
  it("passes the wallet's message through untouched and records a refused row", async () => {
    const walletMessage = "refused: this costs $12.00, above your maxUsd of $5.00 — nothing was paid";
    const x402 = vi.fn(async (): Promise<X402Outcome> => ({ kind: "refused", message: walletMessage }));
    const d = deps({ x402, fetchImpl: fakeGet(404) });

    const message = await dispatchRidges(d, { issueUrl: ISSUE_URL });

    expect(message).toBe(walletMessage);
    const jobs = readJobs(dir);
    expect(jobs[0]).toMatchObject({ status: "refused" });
    expect(readMirror().jobs).toHaveLength(1);
  });
});

describe("dispatchRidges: paid outcome", () => {
  it("records a working row keyed by issue_id, with usd/txHash/title, and confirms in the reply", async () => {
    const x402 = vi.fn(async (): Promise<X402Outcome> => ({
      kind: "paid",
      status: 200,
      bodyText: JSON.stringify({ issue_id: "ridges-issue-99" }),
      txHash: "0xabc123",
      usd: 2.5,
    }));
    const d = deps({ x402, fetchImpl: fakeGet(200, JSON.stringify({ title: "Widget is broken" })) });

    const message = await dispatchRidges(d, { issueUrl: ISSUE_URL, maxUsd: 10 });

    expect(message).toBe("ridges: dispatched — the subnet has your issue (paid $2.50, tx 0xabc123)");
    expect(x402).toHaveBeenCalledWith(
      d.x402Deps,
      expect.objectContaining({
        url: "https://product.ridges.ai/v1/issues",
        method: "POST",
        body: JSON.stringify({ github_issue_url: ISSUE_URL }),
        maxUsd: 10,
      })
    );

    const jobs = readJobs(dir);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: "ridges-issue-99",
      status: "working",
      usd: 2.5,
      txHash: "0xabc123",
      title: "Widget is broken",
      repo: "acme/widgets",
      issueNumber: 42,
    });

    expect(readMirror().jobs).toHaveLength(1);
  });

  it("defaults maxUsd to 5 when not given", async () => {
    const x402 = vi.fn(async (): Promise<X402Outcome> => ({
      kind: "paid",
      status: 200,
      bodyText: "{}",
      txHash: "0xdef",
      usd: 1,
    }));
    const d = deps({ x402, fetchImpl: fakeGet(200, "{}") });

    await dispatchRidges(d, { issueUrl: ISSUE_URL });

    expect(x402).toHaveBeenCalledWith(d.x402Deps, expect.objectContaining({ maxUsd: 5 }));
  });

  it("falls back to the timestamp as the job id when issue_id is missing", async () => {
    const x402 = vi.fn(async (): Promise<X402Outcome> => ({ kind: "paid", status: 200, bodyText: "{}", txHash: "0xdef", usd: 1 }));
    const d = deps({ x402, fetchImpl: fakeGet(200, "{}") });

    await dispatchRidges(d, { issueUrl: ISSUE_URL });

    const jobs = readJobs(dir);
    expect(jobs[0].id).toBe("2026-08-30T00:00:00.000Z");
  });

  it("records untitled when the title fetch fails — never blocks the dispatch", async () => {
    const x402 = vi.fn(async (): Promise<X402Outcome> => ({
      kind: "paid",
      status: 200,
      bodyText: JSON.stringify({ issue_id: "ridges-issue-100" }),
      txHash: "0xabc",
      usd: 1,
    }));
    const failingFetch: FetchLike = async () => {
      throw new Error("network down");
    };
    const d = deps({ x402, fetchImpl: failingFetch });

    const message = await dispatchRidges(d, { issueUrl: ISSUE_URL });

    expect(message).toContain("dispatched");
    const jobs = readJobs(dir);
    expect(jobs[0].title).toBeUndefined();
  });
});

describe("dispatchRidges: ambiguous outcome", () => {
  it("records a payment-unclear row and appends the do-not-retry support wording, with the tx hash when present", async () => {
    const walletMessage = "the paid request returned HTTP 500 — it may have settled; do not retry, check receipts and the spend log.";
    const x402 = vi.fn(async (): Promise<X402Outcome> => ({
      kind: "ambiguous",
      message: walletMessage,
      usd: 3,
      txHash: "0xfeed",
    }));
    const d = deps({ x402, fetchImpl: fakeGet(200, JSON.stringify({ title: "Widget is broken" })) });

    const message = await dispatchRidges(d, { issueUrl: ISSUE_URL });

    expect(message).toContain(walletMessage);
    expect(message).toContain("contact Ridges support");
    expect(message).toContain("0xfeed");

    const jobs = readJobs(dir);
    expect(jobs[0]).toMatchObject({ status: "payment-unclear", usd: 3, txHash: "0xfeed" });
    expect(readMirror().jobs).toHaveLength(1);
  });

  it("still names the support recovery path when no tx hash came back", async () => {
    const walletMessage = "a payment was signed but the paid request failed to complete — it may have settled. Do NOT retry.";
    const x402 = vi.fn(async (): Promise<X402Outcome> => ({ kind: "ambiguous", message: walletMessage, usd: 1 }));
    const d = deps({ x402, fetchImpl: fakeGet(200, "{}") });

    const message = await dispatchRidges(d, { issueUrl: ISSUE_URL });

    expect(message).toContain(walletMessage);
    expect(message).toContain("contact Ridges support");

    const jobs = readJobs(dir);
    expect(jobs[0]).toMatchObject({ status: "payment-unclear", usd: 1 });
    expect(jobs[0].txHash).toBeUndefined();
  });
});
