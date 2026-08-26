import { describe, it, expect } from "vitest";
import { parseConsentRequest, requestStatus, parseReceiveAddress, personaFor, matchSpend, remainingText } from "../src/gui-logic.js";

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

describe("parseReceiveAddress", () => {
  const ADDR = "5E76cpgXAHSZKM7pRhYcbNnCXcuFpZzVN9F7G7G4abcd";
  it("parses the wallet_address tool line", () => {
    expect(parseReceiveAddress(`scout receive address (tao): ${ADDR}`)).toEqual({ chain: "tao", address: ADDR });
  });
  it("parses an agent's paraphrase — prose, backticks, multi-line (found live)", () => {
    expect(parseReceiveAddress(`My TAO receive address: \`${ADDR}\``)).toEqual({ chain: "tao", address: ADDR });
    expect(parseReceiveAddress(`Sure!\nTAO receive address: ${ADDR}\nanything else?`)).toEqual({
      chain: "tao",
      address: ADDR,
    });
  });
  it("defaults the chain when the line names none", () => {
    expect(parseReceiveAddress(`receive address: ${ADDR}`)).toEqual({ chain: "tao", address: ADDR });
  });
  it("rejects messages without an address-shaped token or the phrase", () => {
    expect(parseReceiveAddress("here is my receive address: soon")).toBeUndefined();
    expect(parseReceiveAddress(`no wallet here, but ${ADDR} is a nice string`)).toBeUndefined();
    expect(parseReceiveAddress("scout receive address (tao):")).toBeUndefined();
  });
});

describe("personaFor", () => {
  const BOOK = { treasury: "5Treasury", personas: { scout: "5Scout", loom: "5Loom" } };
  it("names a persona by full address", () => {
    expect(personaFor("5Scout", BOOK)).toBe("scout");
  });
  it("names the treasury", () => {
    expect(personaFor("5Treasury", BOOK)).toBe("treasury");
  });
  it("matches a truncated head…tail display form", () => {
    const long = { personas: { vault: "5E76cpgXAHSZKM7pRhYcbNnCXcuFpZzVN9F7G7G4" } };
    expect(personaFor("5E76cpgX…F7G7G4", long)).toBe("vault");
    expect(personaFor("5E76cpgX…ZZZZZZ", long)).toBeUndefined();
  });
  it("returns undefined for strangers", () => {
    expect(personaFor("5Nobody", BOOK)).toBeUndefined();
  });
});

describe("matchSpend", () => {
  const REQ = { persona: "scout", amount: "0.05 TAO", to: "5Dest" };
  const entry = (over: object) => ({
    ts: "2026-08-26T21:00:00.000Z",
    persona: "scout",
    to: "5Dest",
    amount: "0.05",
    asset: "TAO",
    txHash: "0xabc",
    consent: "approved" as const,
    ...over,
  });
  const msgTs = Date.parse("2026-08-26T20:59:00.000Z") / 1000;
  it("finds the ledger entry the request produced", () => {
    expect(matchSpend(REQ, msgTs, [entry({})])?.txHash).toBe("0xabc");
  });
  it("ignores entries from before the request", () => {
    expect(matchSpend(REQ, msgTs, [entry({ ts: "2026-08-26T20:00:00.000Z" })])).toBeUndefined();
  });
  it("ignores other personas and other recipients", () => {
    expect(matchSpend(REQ, msgTs, [entry({ persona: "loom" })])).toBeUndefined();
    expect(matchSpend(REQ, msgTs, [entry({ to: "5Other" })])).toBeUndefined();
  });
  it("matches a request whose to was the truncated display form", () => {
    const req = { persona: "scout", amount: "0.05 TAO", to: "5E76cpgX…F7G7G4" };
    expect(matchSpend(req, msgTs, [entry({ to: "5E76cpgXAHSZKM7pRhYcbNnCXcuFpZzVN9F7G7G4" })])?.txHash).toBe("0xabc");
  });
  it("prefers the newest match", () => {
    const rows = [entry({ txHash: "0xold" }), entry({ txHash: "0xnew", ts: "2026-08-26T21:05:00.000Z" })];
    expect(matchSpend(REQ, msgTs, rows)?.txHash).toBe("0xnew");
  });
  it("amount comparison is numeric, not textual", () => {
    expect(matchSpend({ ...REQ, amount: "0.050 TAO" }, msgTs, [entry({})])?.txHash).toBe("0xabc");
  });
});

describe("remainingText", () => {
  it("counts down whole minutes", () => {
    expect(remainingText(0, 60)).toBe("expires in 9m");
    expect(remainingText(0, 540)).toBe("expires in 1m");
  });
  it("shows <1m at the wire", () => {
    expect(remainingText(0, 599)).toBe("expires in <1m");
  });
  it("is undefined once expired", () => {
    expect(remainingText(0, 601)).toBeUndefined();
  });
});
