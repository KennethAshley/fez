import { describe, it, expect } from "vitest";
import { parseConsentRequest, requestStatus, parseReceiveAddress, personaFor, matchSpend, remainingText, extractAddresses, logsFor, panelEndpoint, resolveNetwork, ledgerTime } from "../src/gui-logic.js";
import {
  networkLabel,
  validThreshold,
  mergeThresholds,
  receiptLine,
  isRenderableReceipt,
} from "../src/gui-logic.js";
import type { SpendEntry } from "../src/log.js";

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

  it("still parses when walletSend prepends notes, and hands them back", () => {
    const withNotes = [
      "first payment to this agent",
      "network could not be checked — this address publishes none (you are on test)",
      ...MSG.split("\n"),
    ].join("\n");
    const req = parseConsentRequest(withNotes);
    expect(req?.persona).toBe("scout");
    expect(req?.to).toBe("5E76cpgX…F7G7G4");
    expect(req?.notes).toEqual([
      "first payment to this agent",
      "network could not be checked — this address publishes none (you are on test)",
    ]);
  });

  it("carries no notes key when there is nothing to warn about", () => {
    expect(parseConsentRequest(MSG)).not.toHaveProperty("notes");
  });
});

describe("mergeThresholds", () => {
  it("keeps every per-persona threshold when the panel edits the default", () => {
    expect(mergeThresholds({ default: "0.01", scout: "0.0001" }, "0.5")).toEqual({
      default: "0.5",
      scout: "0.0001",
    });
  });

  it("works from nothing at all", () => {
    expect(mergeThresholds(undefined, "0.5")).toEqual({ default: "0.5" });
  });

  it("never loosens a tighter persona threshold — the direction that costs money", () => {
    const merged = mergeThresholds({ default: "0.01", scout: "0.0001" }, "10");
    expect(merged.scout).toBe("0.0001");
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
    // The panel must not show "approved" for a reaction the wallet would
    // not have spent on: "+" is the generic like, not consent.
    expect(requestStatus([{ content: "+", authorPk: OWNER }], OWNER, 0, 30)).toBe("pending");
    expect(requestStatus([{ content: "-", authorPk: OWNER }], OWNER, 0, 30)).toBe("declined");
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

describe("extractAddresses", () => {
  const A = "5E76cpgXAHSZKM7pRhYcbNnCXcuFpZzVN9F7G7G4abcd";
  const B = "5Dq6YPvfzJ47LDfK4zLqCAkUTgGPBieULCX6wfuAbcdE";
  it("finds a bare address in prose", () => {
    expect(extractAddresses(`send it to ${A} thanks`)).toEqual([A]);
  });
  it("finds an address wrapped in inline backticks", () => {
    expect(extractAddresses(`vault's address is \`${B}\``)).toEqual([B]);
  });
  it("ignores addresses inside fenced code blocks", () => {
    expect(extractAddresses("```\nconst a = \"" + A + "\";\n```")).toEqual([]);
  });
  it("dedupes repeats, keeps first-seen order", () => {
    expect(extractAddresses(`${A} then ${B} then ${A} again`)).toEqual([A, B]);
  });
  it("rejects a 64-char hex pubkey run", () => {
    const hex = "4d9a4f8e4875128d59a44b58365de32cb223b433e72e948e8d61b3cd3342aabb";
    expect(extractAddresses(`pk ${hex}`)).toEqual([]);
  });
  it("rejects short and non-5-prefixed tokens", () => {
    expect(extractAddresses("5TooShort and AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toEqual([]);
  });
  it("caps at five per message", () => {
    const many = Array.from({ length: 6 }, (_, i) => `5${String.fromCharCode(65 + i)}${"x".repeat(44)}`).join(" ");
    expect(extractAddresses(many)).toHaveLength(5);
  });
});

describe("logsFor", () => {
  const testEntry: SpendEntry = {
    ts: "1", persona: "scout", to: "5X", amount: "0.01", asset: "TAO",
    txHash: "0xtest", consent: "auto", network: "test",
  };
  const finneyEntry: SpendEntry = {
    ts: "2", persona: "scout", to: "5X", amount: "1", asset: "TAO",
    txHash: "0xreal", consent: "auto", network: "finney",
  };

  it("returns only the given network's rows", () => {
    const logs = { test: [testEntry], finney: [finneyEntry] };
    expect(logsFor(logs, "test")).toEqual([testEntry]);
    expect(logsFor(logs, "finney")).toEqual([finneyEntry]);
  });

  it("falls back to finney when no network is mirrored yet", () => {
    const logs = { finney: [finneyEntry] };
    expect(logsFor(logs, undefined)).toEqual([finneyEntry]);
  });

  it("reads a missing network as empty, never falling through to another chain's rows", () => {
    const logs = { finney: [finneyEntry] };
    expect(logsFor(logs, "test")).toEqual([]);
  });

  it("reads undefined logs as empty", () => {
    expect(logsFor(undefined, "test")).toEqual([]);
  });
});

describe("wallet panel logic", () => {
  it("marks anything that is not mainnet", () => {
    expect(networkLabel("test")).toMatch(/play money/i);
    expect(networkLabel("finney")).not.toMatch(/play money/i);
  });

  it("accepts a plain decimal threshold", () => {
    expect(validThreshold("0.05")).toBe(true);
    expect(validThreshold("1")).toBe(true);
  });

  it("rejects anything that isn't one", () => {
    expect(validThreshold("")).toBe(false);
    expect(validThreshold("-1")).toBe(false);
    expect(validThreshold("0.0000000001")).toBe(false); // more than 9 decimals
    expect(validThreshold("abc")).toBe(false);
  });
});

describe("receipt rendering", () => {
  const base = { raw: 50_000_000n, symbol: "TAO", payer: "abc123def456", network: "test" as const, chain: "tao" };

  it("shows the amount and who paid", () => {
    expect(receiptLine(base as never, "verified")).toMatch(/0\.05 TAO/);
  });

  it("distinguishes unverifiable from false — they are not the same thing", () => {
    const unver = receiptLine(base as never, "unverifiable");
    const wrong = receiptLine(base as never, "false");
    expect(unver).toMatch(/couldn't check/i);
    expect(wrong).toMatch(/does not match/i);
    expect(unver).not.toEqual(wrong);
  });

  it("does not decorate a verified receipt with a caveat", () => {
    expect(receiptLine(base as never, "verified")).not.toMatch(/couldn't check|does not match/i);
  });

  // The line prints TAO's 9 decimals. A receipt tagged with another chain
  // would be off by nine orders of magnitude, so it is not rendered at all
  // — the panel has no adapter list to ask for the right decimals.
  it("renders nothing for a chain whose decimals it does not know", () => {
    const evm = { ...base, chain: "evm", symbol: "ETH", raw: 1_000_000_000_000_000_000n };
    expect(receiptLine(evm as never, "unverifiable")).toBeUndefined();
    expect(isRenderableReceipt(evm as never)).toBe(false);
    expect(isRenderableReceipt(base as never)).toBe(true);
  });

  it("renders nothing for an unexpected asset on the tao chain", () => {
    expect(receiptLine({ ...base, symbol: "USDC" } as never, "verified")).toBeUndefined();
  });

  // `chain` and `network` are separate tags on a 47040: test and finney
  // are both chain "tao". The panel already refuses to print an amount it
  // cannot get the decimals for — printing play money as though it were
  // real is the same class of lie about the same number.
  it("says so when the payment was play money", () => {
    const play = receiptLine({ ...base, network: "test" } as never, "verified");
    expect(play).toMatch(/test/i);
  });

  it("does not label mainnet — its absence is what means real money", () => {
    const real = receiptLine({ ...base, network: "finney" } as never, "verified");
    expect(real).not.toMatch(/test|play money/i);
  });

  it("never renders a testnet payment identically to a real one", () => {
    const real = receiptLine({ ...base, network: "finney" } as never, "verified");
    const play = receiptLine({ ...base, network: "test" } as never, "verified");
    expect(play).not.toEqual(real);
  });
});

describe("panelEndpoint — which chain the panel dials", () => {
  const FINNEY = "wss://entrypoint-finney.opentensor.ai:443";
  const TEST = "wss://test.finney.opentensor.ai:443";

  it("derives from the selected network, not from what was last mirrored", () => {
    // The bug: selector says test, mirrored endpoint still finney, balances
    // kept reading mainnet until some other process happened to mirror.
    expect(panelEndpoint("test", FINNEY)).toBe(TEST);
    expect(panelEndpoint("finney", TEST)).toBe(FINNEY);
  });

  it("honours a genuine override, exactly as loadConfig does", () => {
    // An unrecognised endpoint is a local node or a fork — the panel must
    // not override it, or it would show a different chain than the wallet.
    expect(panelEndpoint("test", "ws://127.0.0.1:9944")).toBe("ws://127.0.0.1:9944");
    expect(panelEndpoint("finney", "ws://127.0.0.1:9944")).toBe("ws://127.0.0.1:9944");
  });

  it("works before anything has mirrored", () => {
    expect(panelEndpoint("test", undefined)).toBe(TEST);
    expect(panelEndpoint("finney", undefined)).toBe(FINNEY);
  });
});

describe("panelEndpoint — a network it does not know", () => {
  it("returns undefined rather than dialling nowhere", () => {
    // prefs is a file; it can hold a hand-edit, or a value from a newer
    // build. endpointFor would hand back undefined and the panel would
    // construct WsProvider(undefined) — a crash screen, like the one a
    // stale client method already cost us once.
    expect(panelEndpoint("beta" as never, undefined)).toBeUndefined();
  });

  it("still honours a genuine override on an unknown network", () => {
    expect(panelEndpoint("beta" as never, "ws://127.0.0.1:9944")).toBe("ws://127.0.0.1:9944");
  });
});

describe("resolveNetwork — must match loadConfig's precedence exactly", () => {
  it("prefers prefs", () => {
    expect(resolveNetwork("test", "finney")).toBe("test");
    expect(resolveNetwork("finney", "test")).toBe("finney");
  });

  it("falls back to what the wallet last resolved, not straight to the default", () => {
    // The mirrored value is loadConfig's own answer, inference included. A
    // panel that skipped this said "finney (mainnet)" over a legacy wallet
    // whose every payment went out on test.
    expect(resolveNetwork(undefined, "test")).toBe("test");
  });

  it("defaults to finney only when nothing is known", () => {
    expect(resolveNetwork(undefined, undefined)).toBe("finney");
  });

  it("never lets the default override a known answer", () => {
    expect(resolveNetwork(undefined, "finney")).toBe("finney");
  });
});

/**
 * A ledger row printed its timestamp as the raw ISO string the entry was
 * stored with — "2026-08-27T17:01:37.089Z" — which in a table column is
 * both unreadable and wide enough to wrap onto two lines.
 */
describe("ledgerTime", () => {
  it("reads as a date and a time, not an ISO string", () => {
    const out = ledgerTime("2026-08-27T17:01:37.089Z");
    expect(out).not.toContain("T");
    expect(out).not.toContain("Z");
    expect(out).not.toContain(".089");
  });

  it("keeps the day and the minute — the two things you scan a ledger for", () => {
    const out = ledgerTime("2026-08-27T17:01:37.089Z");
    expect(out).toMatch(/27/);
    expect(out).toMatch(/01/);
  });

  it("stays short enough for a table column", () => {
    expect(ledgerTime("2026-08-27T17:01:37.089Z").length).toBeLessThanOrEqual(16);
  });

  // A ledger that silently drops a row it cannot parse is worse than one
  // that shows something odd: the money moved either way.
  it("shows the original when it cannot parse one", () => {
    expect(ledgerTime("not a date")).toBe("not a date");
    expect(ledgerTime("")).toBe("");
  });
});
