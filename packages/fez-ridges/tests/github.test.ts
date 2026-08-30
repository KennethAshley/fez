import { describe, it, expect } from "vitest";
import { parseIssueUrl, matchPr } from "../src/github.js";

describe("parseIssueUrl", () => {
  it("accepts the canonical form", () => {
    expect(parseIssueUrl("https://github.com/foo/bar/issues/12")).toEqual({
      owner: "foo",
      repo: "bar",
      issueNumber: 12,
    });
  });

  it("tolerates a trailing query string", () => {
    expect(parseIssueUrl("https://github.com/foo/bar/issues/12?tab=comments")).toEqual({
      owner: "foo",
      repo: "bar",
      issueNumber: 12,
    });
  });

  it("tolerates a trailing fragment", () => {
    expect(parseIssueUrl("https://github.com/foo/bar/issues/12#issuecomment-1")).toEqual({
      owner: "foo",
      repo: "bar",
      issueNumber: 12,
    });
  });

  it("accepts owner/repo charset with dots, dashes, underscores", () => {
    expect(parseIssueUrl("https://github.com/foo-bar/baz_qux.js/issues/3")).toEqual({
      owner: "foo-bar",
      repo: "baz_qux.js",
      issueNumber: 3,
    });
  });

  it("rejects a pull request URL", () => {
    expect(parseIssueUrl("https://github.com/foo/bar/pull/12")).toBeUndefined();
  });

  it("rejects extra path segments", () => {
    expect(parseIssueUrl("https://github.com/foo/bar/issues/12/comments")).toBeUndefined();
  });

  it("rejects a trailing slash", () => {
    expect(parseIssueUrl("https://github.com/foo/bar/issues/12/")).toBeUndefined();
  });

  it("rejects a non-github host", () => {
    expect(parseIssueUrl("https://gitlab.com/foo/bar/issues/12")).toBeUndefined();
  });

  it("rejects a subdomain host", () => {
    expect(parseIssueUrl("https://gist.github.com/foo/bar/issues/12")).toBeUndefined();
  });

  it("rejects http:", () => {
    expect(parseIssueUrl("http://github.com/foo/bar/issues/12")).toBeUndefined();
  });

  it("rejects a non-numeric issue number", () => {
    expect(parseIssueUrl("https://github.com/foo/bar/issues/abc")).toBeUndefined();
  });

  it("rejects issue number 0", () => {
    expect(parseIssueUrl("https://github.com/foo/bar/issues/0")).toBeUndefined();
  });

  it("rejects a missing issue number", () => {
    expect(parseIssueUrl("https://github.com/foo/bar/issues/")).toBeUndefined();
  });

  it("rejects garbage input", () => {
    expect(parseIssueUrl("not a url")).toBeUndefined();
  });

  it("rejects a repo root URL", () => {
    expect(parseIssueUrl("https://github.com/foo/bar")).toBeUndefined();
  });

  // M6
  it("rejects userinfo in the URL", () => {
    expect(parseIssueUrl("https://user:pass@github.com/foo/bar/issues/12")).toBeUndefined();
  });

  it("rejects a non-default port", () => {
    expect(parseIssueUrl("https://github.com:8443/foo/bar/issues/12")).toBeUndefined();
  });
});

describe("matchPr", () => {
  const base = { title: "", body: "", headRef: "main" };

  it("matches 'fixes #N' in the body", () => {
    expect(matchPr(12, { ...base, body: "fixes #12" })).toBe(true);
  });

  it("matches 'Closes #N.' with trailing punctuation, case-insensitive", () => {
    expect(matchPr(12, { ...base, body: "Closes #12." })).toBe(true);
  });

  it("matches 'resolves #N' in the title", () => {
    expect(matchPr(12, { ...base, title: "resolves #12" })).toBe(true);
  });

  it("matches a bare parenthesized reference", () => {
    expect(matchPr(12, { ...base, body: "see (#12) for context" })).toBe(true);
  });

  it("matches a head branch containing issue-N", () => {
    expect(matchPr(12, { ...base, headRef: "issue-12-fix" })).toBe(true);
  });

  it("matches a head branch starting with N-", () => {
    expect(matchPr(12, { ...base, headRef: "12-onboarding" })).toBe(true);
  });

  it("does NOT match a bare #123 against issue 12 (word boundary)", () => {
    expect(matchPr(12, { ...base, body: "#123" })).toBe(false);
  });

  it("does NOT match 'fixes #121' against issue 12", () => {
    expect(matchPr(12, { ...base, body: "fixes #121" })).toBe(false);
  });

  it("does NOT match branch 123-fix against issue 12", () => {
    expect(matchPr(12, { ...base, headRef: "123-fix" })).toBe(false);
  });

  it("does NOT match branch issue-123 against issue 12", () => {
    expect(matchPr(12, { ...base, headRef: "issue-123-fix" })).toBe(false);
  });

  it("does NOT match unrelated title/body/branch", () => {
    expect(matchPr(12, { title: "unrelated change", body: "nothing to see here", headRef: "feature/thing" })).toBe(false);
  });

  it("does NOT match a plain #12 with no keyword or parens", () => {
    expect(matchPr(12, { ...base, body: "see #12 for details" })).toBe(false);
  });
});
