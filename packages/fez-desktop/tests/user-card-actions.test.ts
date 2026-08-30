import { describe, expect, test } from "vitest";
import { cardActions } from "../src/user-card-actions.js";

describe("cardActions — which user-card actions show", () => {
  test("admin on a member: moderator actions except promote, plus mute", () => {
    expect(cardActions("admin", "member", false, false)).toEqual({
      makeAdmin: false, removeAdmin: false, timeout: true, kick: true, ban: true, mute: true,
    });
  });

  test("admin cannot act on another admin (mute still allowed)", () => {
    expect(cardActions("admin", "admin", false, false)).toMatchObject({
      timeout: false, kick: false, ban: false, mute: true,
    });
  });

  test("owner promotes a member and outranks an admin", () => {
    expect(cardActions("owner", "member", true, false).makeAdmin).toBe(true);
    expect(cardActions("owner", "admin", true, false)).toMatchObject({
      removeAdmin: true, kick: true, ban: true, timeout: true,
    });
  });

  test("no action on yourself, not even mute", () => {
    expect(cardActions("owner", "owner", true, true)).toEqual({
      makeAdmin: false, removeAdmin: false, timeout: false, kick: false, ban: false, mute: false,
    });
  });

  test("a plain member can only mute", () => {
    expect(cardActions("member", "member", false, false)).toEqual({
      makeAdmin: false, removeAdmin: false, timeout: false, kick: false, ban: false, mute: true,
    });
  });
});
