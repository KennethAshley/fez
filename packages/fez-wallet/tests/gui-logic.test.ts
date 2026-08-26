import { describe, it, expect } from "vitest";
import { parseConsentRequest, requestStatus } from "../src/gui-logic.js";

const MSG = [
  "💸 **scout** wants to send **0.05 TAO**",
  "to `5E76cpgX…F7G7G4` — consent take two",
  "react ✅ to approve · ❌ to decline",
].join("\n");

describe("parseConsentRequest", () => {
  it("parses the shipped format", () => {
    expect(parseConsentRequest(MSG)).toEqual({
      persona: "scout",
      amount: "0.05 TAO",
      to: "5E76cpgX…F7G7G4",
      memo: "consent take two",
    });
  });
  it("parses without memo", () => {
    const noMemo = MSG.replace(" — consent take two", "");
    expect(parseConsentRequest(noMemo)?.memo).toBeUndefined();
  });
  it("rejects ordinary messages and near-misses", () => {
    expect(parseConsentRequest("hello 💸 world")).toBeUndefined();
    expect(parseConsentRequest("💸 **scout** wants to send **1 TAO**")).toBeUndefined(); // no footer
  });
});

describe("requestStatus", () => {
  const OWNER = "aa".repeat(32);
  it("owner ✅ approves; stranger ✅ doesn't", () => {
    expect(requestStatus([{ content: "✅", authorPk: OWNER }], OWNER, 0, 30)).toBe("approved");
    expect(requestStatus([{ content: "✅", authorPk: "bb".repeat(32) }], OWNER, 0, 30)).toBe("pending");
  });
  it("owner ❌ declines; stale pending expires", () => {
    expect(requestStatus([{ content: "❌", authorPk: OWNER }], OWNER, 0, 30)).toBe("declined");
    expect(requestStatus([], OWNER, 0, 601)).toBe("expired");
    expect(requestStatus([], OWNER, 0, 599)).toBe("pending");
  });
});
