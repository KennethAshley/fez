import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The draft lifecycle is a trust boundary: agents can PROPOSE fleet
 * members, only the owner installs them. These tests pin the rules —
 * no silent overwrites in either direction, validation gates approval,
 * draft-meta never leaks into the live persona.
 */
const { writeDraft, listDrafts, approveDraft, rejectDraft } = await import("../../../dist/identity/persona-drafts.js");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "fez-drafts-"));
fs.mkdirSync(path.join(base, ".fez", "personas"), { recursive: true });

const DRAFT = [
  "---",
  "harness: claude-code",
  "description: label and prioritize bugs",
  "proposedBy: researcher",
  "proposedAt: 2026-08-17T00:00:00.000Z",
  "---",
  "",
  "You are triage.",
  "",
].join("\n");

describe("persona drafts (agent-proposed, owner-approved)", () => {
  test("write → list → approve installs cleaned persona and clears the draft", () => {
    writeDraft("triage", DRAFT, base);
    expect(listDrafts(base)).toEqual([
      { id: "triage", proposedBy: "researcher", description: "label and prioritize bugs", proposedAt: "2026-08-17T00:00:00.000Z" },
    ]);
    const { warnings } = approveDraft("triage", ["claude-code"], base);
    expect(warnings).toEqual([]);
    const live = fs.readFileSync(path.join(base, ".fez", "personas", "triage.md"), "utf-8");
    expect(live).toContain("harness: claude-code");
    expect(live).not.toMatch(/proposedBy|proposedAt/); // draft-meta never ships
    expect(listDrafts(base)).toEqual([]);
  });

  test("a second draft under the same name is refused (no silent replace)", () => {
    writeDraft("scout2", DRAFT, base);
    expect(() => writeDraft("scout2", "---\nharness: pi\n---\nhijack", base)).toThrow(/awaiting review/);
    rejectDraft("scout2", base);
    expect(listDrafts(base)).toEqual([]);
  });

  test("drafting over a LIVE persona is refused; approve refuses to clobber too", () => {
    expect(() => writeDraft("triage", DRAFT, base)).toThrow(/already exists/);
    writeDraft("triage2", DRAFT, base);
    fs.writeFileSync(path.join(base, ".fez", "personas", "triage2.md"), "---\nharness: pi\n---\nexisting\n");
    expect(() => approveDraft("triage2", ["claude-code", "pi"], base)).toThrow(/already exists/);
    rejectDraft("triage2", base);
  });

  test("invalid drafts don't get approved", () => {
    writeDraft("broken", "no frontmatter at all", base);
    expect(() => approveDraft("broken", ["claude-code"], base)).toThrow(/invalid/);
    // the draft survives rejection-by-validation for fixing
    expect(listDrafts(base).map((d) => d.id)).toContain("broken");
  });
});
