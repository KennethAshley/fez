import { describe, expect, test } from "vitest";
import { moderationControls } from "../src/manage-guard.js";

describe("moderationControls guard rail", () => {
  test("admin sees kick/ban on a plain member, but cannot promote", () => {
    expect(moderationControls("admin", "member", false)).toMatchObject({ kick: true, ban: true, promote: false });
  });

  test("admin cannot act on another admin", () => {
    expect(moderationControls("admin", "admin", false)).toMatchObject({ kick: false, ban: false });
  });

  test("nobody can kick the owner", () => {
    expect(moderationControls("admin", "owner", false).kick).toBe(false);
    expect(moderationControls("owner", "owner", true).kick).toBe(false);
  });

  test("owner can act on an admin and demote them", () => {
    expect(moderationControls("owner", "admin", true)).toMatchObject({ kick: true, ban: true, demote: true });
  });

  test("owner promotes a member", () => {
    expect(moderationControls("owner", "member", true).promote).toBe(true);
  });

  test("a plain member sees no controls", () => {
    expect(moderationControls("member", "member", false)).toMatchObject({ kick: false, ban: false, promote: false, demote: false });
  });
});
