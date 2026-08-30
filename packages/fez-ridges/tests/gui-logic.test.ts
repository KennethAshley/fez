import { describe, it, expect } from "vitest";
import { paneFacts, statusText, relTime, issueLabel } from "../src/gui-logic.js";
import type { RidgesJob } from "../src/store.js";

function job(overrides: Partial<RidgesJob>): RidgesJob {
  return {
    id: "id",
    ts: "2026-08-23T00:00:00.000Z",
    persona: "scout",
    issueUrl: "https://github.com/fez/fez/issues/212",
    repo: "fez/fez",
    issueNumber: 212,
    status: "working",
    updatedAt: "2026-08-23T00:00:00.000Z",
    ...overrides,
  };
}

const NOW = new Date("2026-08-30T00:00:00.000Z"); // exactly 7 days after the fixture ts above

describe("paneFacts", () => {
  it("counts live (working + pr-open) and merged, and sums usd within the last 7 days", () => {
    const jobs: RidgesJob[] = [
      job({ id: "1", status: "working" }),
      job({ id: "2", status: "pr-open" }),
      job({ id: "3", status: "merged", usd: 1.5, ts: "2026-08-29T00:00:00.000Z" }),
      job({ id: "4", status: "merged", usd: 2.25, ts: "2026-08-28T00:00:00.000Z" }),
      job({ id: "5", status: "closed" }),
      job({ id: "6", status: "refused" }),
    ];
    expect(paneFacts(jobs, NOW)).toEqual({ live: 2, merged: 2, weekUsd: 3.75 });
  });

  it("excludes a row exactly at the 7-day boundary, includes one a moment inside it", () => {
    const jobs: RidgesJob[] = [
      job({ id: "at-boundary", status: "merged", usd: 5, ts: "2026-08-23T00:00:00.000Z" }), // exactly 7d ago
      job({ id: "inside", status: "merged", usd: 1, ts: "2026-08-23T00:00:00.001Z" }), // 1ms inside 7d
    ];
    expect(paneFacts(jobs, NOW).weekUsd).toBe(1);
  });

  it("ignores rows with no usd (refused, or a row still pending)", () => {
    const jobs: RidgesJob[] = [job({ status: "refused", usd: undefined, ts: NOW.toISOString() })];
    expect(paneFacts(jobs, NOW).weekUsd).toBe(0);
  });
});

describe("statusText — exact mock vocabulary", () => {
  it("working", () => {
    expect(statusText(job({ status: "working" }), NOW)).toBe("working — the subnet has your issue");
  });
  it("pr-open", () => {
    expect(statusText(job({ status: "pr-open" }), NOW)).toBe("PR open — ready for your review");
  });
  it("merged includes relative time", () => {
    expect(statusText(job({ status: "merged", updatedAt: "2026-08-28T00:00:00.000Z" }), NOW)).toBe("✓ merged — 2 days ago");
  });
  it("closed includes relative time", () => {
    expect(statusText(job({ status: "closed", updatedAt: "2026-08-27T00:00:00.000Z" }), NOW)).toBe("✕ closed unmerged — 3 days ago");
  });
  it("payment-unclear", () => {
    expect(statusText(job({ status: "payment-unclear" }), NOW)).toBe(
      "⚠ payment unclear — may have settled; check the receipt before retrying"
    );
  });
  it("refused", () => {
    expect(statusText(job({ status: "refused" }), NOW)).toBe("refused");
  });
});

describe("relTime", () => {
  it("minutes", () => {
    expect(relTime("2026-08-29T23:56:00.000Z", NOW)).toBe("4m ago");
  });
  it("hours", () => {
    expect(relTime("2026-08-29T23:00:00.000Z", NOW)).toBe("1h ago");
  });
  it("days, pluralized", () => {
    expect(relTime("2026-08-28T00:00:00.000Z", NOW)).toBe("2 days ago");
  });
  it("singular day", () => {
    expect(relTime("2026-08-29T00:00:00.000Z", NOW)).toBe("1 day ago");
  });
});

describe("issueLabel", () => {
  it("repo#N for a normal row", () => {
    expect(issueLabel(job({ repo: "fez/fez", issueNumber: 212 }))).toBe("fez/fez#212");
  });
  it("falls back to the hostname-trimmed issue URL for a refused row (repo/issueNumber unset)", () => {
    expect(
      issueLabel(job({ repo: "", issueNumber: 0, issueUrl: "https://github.com/acme/widgets/issues/42" }))
    ).toBe("acme/widgets/issues/42");
  });
});
