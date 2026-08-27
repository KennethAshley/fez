import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { walletSend } from "../src/tools.js";
import type { ToolDeps } from "../src/tools.js";
import type { ChainAdapter } from "../src/chains/adapter.js";
import type { ConsentRelay, SignedNostrEvent } from "../src/consent.js";
import { parseReceipt, buildReceipt } from "../src/receipt.js";
import { parseConsentRequest } from "../src/gui-logic.js";
import { hexToBytes } from "nostr-tools/utils";

const ownerSk = generateSecretKey();
const ownerPk = getPublicKey(ownerSk);
const agentNostrKey = bytesToHex(generateSecretKey());
const agentPubkey = getPublicKey(hexToBytes(agentNostrKey));
const pair = { publicKeyHex: "aa", secretKeyHex: "bb", address: "5Agent" };

function fakeAdapter(balanceRao: bigint) {
  const transfers: { to: string; raw: bigint }[] = [];
  const adapter: ChainAdapter = {
    chain: "tao",
    assets: [{ symbol: "TAO", decimals: 9 }],
    address: (p) => p.address,
    balance: async () => ({ raw: balanceRao, decimals: 9, symbol: "TAO" }),
    transfer: async (_p, to, amount) => {
      transfers.push({ to, raw: amount.raw });
      return { txHash: "0xfeed", blockRef: "0xblock" };
    },
  };
  return { adapter, transfers };
}

function autoRelay(decide: (req: SignedNostrEvent) => string | null) {
  let request: SignedNostrEvent | undefined;
  let handler: ((ev: SignedNostrEvent) => void) | undefined;
  const relay: ConsentRelay = {
    publish: async (ev) => {
      request = ev;
      // Simulate the owner reacting right after the request lands.
      queueMicrotask(() => {
        const content = decide(ev);
        if (content && handler)
          handler({ id: "r", kind: 7, pubkey: ownerPk, content, tags: [["e", ev.id]], created_at: 0, sig: "00" });
      });
    },
    subscribe: (_f, on) => {
      handler = on;
      return () => {};
    },
    query: async () => [],
  };
  return { relay, getRequest: () => request };
}

/** The ToolDeps shape every test starts from: persona "scout" on the
 * "test" network, an owner + consent channel wired for the
 * over-threshold path. Callers spread this with an adapter from
 * fakeAdapter() and override whatever the test needs (relay, resolve,
 * signal, ...). */
function baseDeps(adapter: ChainAdapter): ToolDeps {
  return {
    persona: "scout",
    pair,
    adapters: [adapter],
    config: {
      thresholds: { default: "0.01" },
      consentChannel: "chan1",
      personas: {},
      endpoints: { tao: "wss://unused" },
      network: "test",
      knownPayees: [],
    },
    ownerPk,
    agentNostrKey,
    now: () => "2026-08-25T00:00:00Z",
  };
}

beforeEach(() => {
  process.env.FEZ_WALLET_STORE = "file";
  process.env.FEZ_WALLET_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wallet-tools-"));
  process.env.FEZ_EXTENSION_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wallet-ext-"));
});

describe("tools", () => {
  it("walletAddress reports the agent address", async () => {
    const { walletAddress } = await import("../src/tools.js");
    const { adapter } = fakeAdapter(2_000_000_000n);
    expect(walletAddress(baseDeps(adapter), {})).toContain("5Agent");
  });

  it("walletBalance formats the balance", async () => {
    const { walletBalance } = await import("../src/tools.js");
    const { adapter } = fakeAdapter(2_000_000_000n);
    expect(await walletBalance(baseDeps(adapter), {})).toContain("2 TAO");
  });

  it("sends under threshold without consent and logs it", async () => {
    const { walletSend, walletHistory } = await import("../src/tools.js");
    const { adapter, transfers } = fakeAdapter(2_000_000_000n);
    const d = baseDeps(adapter);
    const out = await walletSend(d, { to: "5Dest", amount: "0.005", asset: "TAO" });
    expect(out).toContain("0xfeed");
    expect(transfers).toHaveLength(1);
    expect(await walletHistory(d, {})).toContain("5Dest");
  });

  it("blocks over-threshold sends behind consent — approved path executes", async () => {
    const { walletSend } = await import("../src/tools.js");
    const { relay } = autoRelay(() => "✅");
    const { adapter, transfers } = fakeAdapter(2_000_000_000n);
    const d = { ...baseDeps(adapter), relay: async () => relay };
    const out = await walletSend(d, { to: "5Dest", amount: "0.5", asset: "TAO", memo: "chutes" });
    expect(out).toContain("0xfeed");
    expect(transfers).toHaveLength(1);
  });

  it("the consent request carries the full recipient address", async () => {
    const { walletSend } = await import("../src/tools.js");
    const { relay, getRequest } = autoRelay(() => "✅");
    const { adapter } = fakeAdapter(2_000_000_000n);
    const d = { ...baseDeps(adapter), relay: async () => relay };
    const long = "5E76cpgXAHSZKM7pRhYcbNnCXcuFpZzVN9F7G7G4";
    await walletSend(d, { to: long, amount: "0.5", asset: "TAO" });
    expect(getRequest()?.content).toContain(long);
  });

  it("declined consent does not transfer", async () => {
    const { walletSend } = await import("../src/tools.js");
    const { relay } = autoRelay(() => "❌");
    const { adapter, transfers } = fakeAdapter(2_000_000_000n);
    const d = { ...baseDeps(adapter), relay: async () => relay };
    const out = await walletSend(d, { to: "5Dest", amount: "0.5", asset: "TAO" });
    expect(out.toLowerCase()).toContain("declined");
    expect(transfers).toHaveLength(0);
  });

  it("insufficient balance errors before any consent round-trip", async () => {
    const { walletSend } = await import("../src/tools.js");
    const { adapter, transfers } = fakeAdapter(2_000_000_000n);
    const d = baseDeps(adapter);
    await expect(walletSend(d, { to: "5Dest", amount: "3", asset: "TAO" })).rejects.toThrow(/balance/i);
    expect(transfers).toHaveLength(0);
  });

  it("wallet_send to the reserved root name never reads or resolves the mnemonic", async () => {
    const { walletSend } = await import("../src/tools.js");
    process.env.FEZ_WALLET_STORE = "file";
    const { writeRootEntry } = await import("../src/store.js");
    const mnemonic = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
    writeRootEntry(mnemonic); // a root entry exists — the vulnerable path would read it
    const { adapter, transfers } = fakeAdapter(2_000_000_000n);
    const d = baseDeps(adapter);
    const out = await walletSend(d, { to: "root", amount: "0.005", asset: "TAO" });
    // none of the mnemonic's words appear anywhere in the response...
    for (const word of mnemonic.split(" ")) expect(out.toLowerCase()).not.toContain(word);
    // ...and "root" was never resolved through the store — it went out
    // as the literal string, proving readEntry("root") was never called.
    expect(transfers).toHaveLength(1);
    expect(transfers[0].to).toBe("root");
  });

  it("a pre-aborted signal blocks the transfer even when the relay auto-approves", async () => {
    const { walletSend } = await import("../src/tools.js");
    const { relay } = autoRelay(() => "✅");
    const controller = new AbortController();
    controller.abort();
    const { adapter, transfers } = fakeAdapter(2_000_000_000n);
    const d = { ...baseDeps(adapter), relay: async () => relay, signal: controller.signal };
    const out = await walletSend(d, { to: "5Dest", amount: "0.5", asset: "TAO" });
    expect(out.toLowerCase()).toContain("aborted");
    expect(transfers).toHaveLength(0);
  });

  it("resolves a persona name to its derived address", async () => {
    const { walletSend } = await import("../src/tools.js");
    const { adapter, transfers } = fakeAdapter(2_000_000_000n);
    const d = baseDeps(adapter);
    // vault's address comes from the store — write a stored pair for it.
    process.env.FEZ_WALLET_STORE = "file";
    const { writeEntry } = await import("../src/store.js");
    const { deriveAgentPair } = await import("../src/derive.js");
    const vaultPair = deriveAgentPair("legal winner thank year wave sausage worth useful legal winner thank yellow", "vault");
    writeEntry("vault", JSON.stringify(vaultPair));
    await walletSend(d, { to: "vault", amount: "0.005", asset: "TAO" });
    expect(transfers[0].to).toBe(vaultPair.address);
  });
});

describe("cross-owner sends", () => {
  it("sends to the resolved address, not the typed name", async () => {
    const { adapter, transfers } = fakeAdapter(1_000_000_000n);
    await walletSend(
      { ...baseDeps(adapter), resolve: async () => ({ address: "5Chip", network: "test", via: "agent" }) },
      { to: "@chip", amount: "0.001", asset: "TAO" }
    );
    expect(transfers[0].to).toBe("5Chip");
  });

  it("refuses a network mismatch before signing anything", async () => {
    const { adapter, transfers } = fakeAdapter(1_000_000_000n);
    await expect(
      walletSend(
        { ...baseDeps(adapter), resolve: async () => ({ address: "5Real", network: "finney", via: "agent" }) },
        { to: "@chip", amount: "0.001", asset: "TAO" }
      )
    ).rejects.toThrow(/you're on test.*chip is on finney/i);
    expect(transfers).toHaveLength(0);
  });

  it("allows a raw address, which carries no network to check", async () => {
    const { adapter, transfers } = fakeAdapter(1_000_000_000n);
    await walletSend(
      { ...baseDeps(adapter), resolve: async () => ({ address: "5Raw", via: "raw" }) },
      { to: "5Raw", amount: "0.001", asset: "TAO" }
    );
    expect(transfers[0].to).toBe("5Raw");
  });
});

describe("new payee consent", () => {
  it("asks the first time, even under the threshold", async () => {
    const { adapter, transfers } = fakeAdapter(1_000_000_000n);
    let asked = false;
    const relay = autoRelay((ev) => { asked = true; return "✅"; });
    await walletSend(
      {
        ...baseDeps(adapter),
        ownerPk,
        agentNostrKey,
        relay: () => Promise.resolve(relay.relay),
        resolve: async () => ({ address: "5Chip", network: "test", via: "agent", payeePubkey: "chippk" }),
      },
      { to: "@chip", amount: "0.0001", asset: "TAO" } // well under the 0.01 threshold
    );
    expect(asked).toBe(true);
    expect(transfers).toHaveLength(1);
  });

  it("does not ask again once that payee is known", async () => {
    const { adapter } = fakeAdapter(1_000_000_000n);
    let asks = 0;
    const relay = autoRelay(() => { asks++; return "✅"; });
    const deps: ToolDeps = {
      ...baseDeps(adapter),
      ownerPk,
      agentNostrKey,
      relay: () => Promise.resolve(relay.relay),
      resolve: async () => ({ address: "5Chip", network: "test", via: "agent", payeePubkey: "chippk" }),
    };
    const args = { to: "@chip", amount: "0.0001", asset: "TAO" };
    await walletSend(deps, args);
    await walletSend(deps, args);
    expect(asks).toBe(1);
  });

  it("keys on the pubkey, not the name — a name is not an identity", async () => {
    const { adapter } = fakeAdapter(1_000_000_000n);
    let asks = 0;
    const relay = autoRelay(() => { asks++; return "✅"; });
    const base = { ...baseDeps(adapter), ownerPk, agentNostrKey, relay: () => Promise.resolve(relay.relay) };
    await walletSend(
      { ...base, resolve: async () => ({ address: "5A", network: "test", via: "agent", payeePubkey: "pkA" }) },
      { to: "@chip", amount: "0.0001", asset: "TAO" }
    );
    await walletSend(
      { ...base, resolve: async () => ({ address: "5B", network: "test", via: "agent", payeePubkey: "pkB" }) },
      { to: "@chip", amount: "0.0001", asset: "TAO" }
    );
    expect(asks).toBe(2);
  });
});

describe("an unknowable network is said out loud (spec §8)", () => {
  it("the consent card says the network could not be checked for a raw address", async () => {
    const { relay, getRequest } = autoRelay(() => "✅");
    const { adapter, transfers } = fakeAdapter(2_000_000_000n);
    await walletSend(
      {
        ...baseDeps(adapter),
        relay: async () => relay,
        resolve: async () => ({ address: "5Raw", via: "raw" }),
      },
      { to: "5Raw", amount: "0.5", asset: "TAO" } // over the 0.01 threshold
    );
    expect(getRequest()?.content).toContain("network could not be checked");
    expect(getRequest()?.content).toContain("test"); // which network you ARE on
    expect(transfers).toHaveLength(1);
    // ...and the card still parses, with the warning carried as a note.
    const parsed = parseConsentRequest(getRequest()!.content)!;
    expect(parsed.to).toBe("5Raw");
    expect(parsed.notes).toEqual([expect.stringContaining("network could not be checked")]);
  });

  it("says nothing of the sort when the payee published a network", async () => {
    const { relay, getRequest } = autoRelay(() => "✅");
    const { adapter } = fakeAdapter(2_000_000_000n);
    await walletSend(
      {
        ...baseDeps(adapter),
        relay: async () => relay,
        resolve: async () => ({ address: "5Chip", network: "test", via: "agent" }),
      },
      { to: "@chip", amount: "0.5", asset: "TAO" }
    );
    expect(getRequest()?.content).not.toContain("network could not be checked");
  });
});

describe("a payee is remembered only once money has moved", () => {
  function throwingAdapter(): ChainAdapter {
    return {
      ...fakeAdapter(2_000_000_000n).adapter,
      transfer: async () => {
        throw new Error("chain rejected the extrinsic");
      },
    };
  }

  it("a thrown transfer leaves knownPayees empty, so the next payment still asks", async () => {
    const relay = autoRelay(() => "✅");
    const d: ToolDeps = {
      ...baseDeps(throwingAdapter()),
      ownerPk,
      agentNostrKey,
      relay: () => Promise.resolve(relay.relay),
      resolve: async () => ({ address: "5Chip", network: "test", via: "agent", payeePubkey: "chippk" }),
    };
    await expect(walletSend(d, { to: "@chip", amount: "0.0001", asset: "TAO" })).rejects.toThrow(/chain rejected/);
    expect(d.config.knownPayees).toEqual([]);
    const file = path.join(process.env.FEZ_WALLET_HOME!, "wallet.json");
    const onDisk = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    expect(onDisk).not.toContain("chippk");
  });

  it("a completed transfer does remember the payee", async () => {
    const relay = autoRelay(() => "✅");
    const { adapter } = fakeAdapter(2_000_000_000n);
    const d: ToolDeps = {
      ...baseDeps(adapter),
      ownerPk,
      agentNostrKey,
      relay: () => Promise.resolve(relay.relay),
      resolve: async () => ({ address: "5Chip", network: "test", via: "agent", payeePubkey: "chippk" }),
    };
    await walletSend(d, { to: "@chip", amount: "0.0001", asset: "TAO" });
    expect(d.config.knownPayees).toEqual(["chippk"]);
  });
});

describe("receipts", () => {
  function relayCapturing(published: SignedNostrEvent[]) {
    const relay: ConsentRelay = {
      publish: async (ev) => { published.push(ev); },
      subscribe: () => () => {},
      query: async () => [],
    };
    return () => Promise.resolve(relay);
  }

  it("publishes a receipt e-tagged to the paid-for message", async () => {
    const { adapter } = fakeAdapter(1_000_000_000n);
    const published: SignedNostrEvent[] = [];
    await walletSend(
      {
        ...baseDeps(adapter),
        agentNostrKey,
        relay: relayCapturing(published),
        resolve: async () => ({ address: "5Chip", network: "test", via: "agent" }),
      },
      { to: "@chip", amount: "0.001", asset: "TAO", for: "msg1" }
    );
    const r = published.map(parseReceipt).find(Boolean)!;
    expect(r.forEvent).toBe("msg1");
    expect(r.raw).toBe(1_000_000n);
    expect(r.txHash).toBe("0xfeed");
    expect(r.blockRef).toBe("0xblock");
  });

  it("publishes no receipt when no message was named", async () => {
    const { adapter } = fakeAdapter(1_000_000_000n);
    const published: SignedNostrEvent[] = [];
    await walletSend(
      { ...baseDeps(adapter), agentNostrKey, relay: relayCapturing(published), resolve: async () => ({ address: "5Raw", via: "raw" }) },
      { to: "5Raw", amount: "0.001", asset: "TAO" }
    );
    expect(published.map(parseReceipt).filter(Boolean)).toHaveLength(0);
  });

  it("keeps the transfer when the receipt fails to publish, and says so", async () => {
    const { adapter, transfers } = fakeAdapter(1_000_000_000n);
    const failing: ConsentRelay = {
      publish: async () => { throw new Error("relay down"); },
      subscribe: () => () => {},
      query: async () => [],
    };
    const out = await walletSend(
      {
        ...baseDeps(adapter),
        agentNostrKey,
        relay: () => Promise.resolve(failing),
        resolve: async () => ({ address: "5Chip", network: "test", via: "agent" }),
      },
      { to: "@chip", amount: "0.001", asset: "TAO", for: "msg1" }
    );
    expect(transfers).toHaveLength(1);
    expect(out).toMatch(/receipt/i);
  });
});

describe("wallet_history", () => {
  it("shows inbound receipts p-tagging me, marked unverified until checked", async () => {
    const { walletHistory } = await import("../src/tools.js");
    const { adapter } = fakeAdapter(0n);
    const incoming = buildReceipt({
      agentSecretHex: bytesToHex(generateSecretKey()),
      forEvent: "msg1",
      payeePubkey: agentPubkey, // baseDeps' agent nostr pubkey
      amount: { raw: 50_000_000n, decimals: 9, symbol: "TAO" },
      chain: "tao",
      network: "test",
      txHash: "0xin",
    });
    const relay: ConsentRelay = {
      publish: async () => {},
      subscribe: () => () => {},
      query: async () => [incoming],
    };
    const out = await walletHistory(
      { ...baseDeps(adapter), agentNostrKey, relay: () => Promise.resolve(relay) },
      { limit: 10 }
    );
    expect(out).toMatch(/0\.05 TAO/);
    expect(out).toMatch(/unverified/i);
  });

  it("still works with no relay at all", async () => {
    const { walletHistory } = await import("../src/tools.js");
    const { adapter } = fakeAdapter(0n);
    expect(await walletHistory({ ...baseDeps(adapter) }, { limit: 10 })).toEqual(expect.any(String));
  });

  it("filters out inbound receipts from a different network", async () => {
    const { walletHistory } = await import("../src/tools.js");
    const { adapter } = fakeAdapter(0n);
    const onTest = buildReceipt({
      agentSecretHex: bytesToHex(generateSecretKey()),
      payeePubkey: agentPubkey,
      amount: { raw: 11_000_000n, decimals: 9, symbol: "TAO" },
      chain: "tao",
      network: "test",
      txHash: "0xtest",
    });
    const onFinney = buildReceipt({
      agentSecretHex: bytesToHex(generateSecretKey()),
      payeePubkey: agentPubkey,
      amount: { raw: 99_000_000n, decimals: 9, symbol: "TAO" },
      chain: "tao",
      network: "finney",
      txHash: "0xfinney",
    });
    const relay: ConsentRelay = {
      publish: async () => {},
      subscribe: () => () => {},
      query: async () => [onTest, onFinney],
    };
    const out = await walletHistory(
      { ...baseDeps(adapter), agentNostrKey, relay: () => Promise.resolve(relay) },
      { limit: 10 }
    );
    expect(out).toMatch(/0\.011 TAO/);
    expect(out).not.toMatch(/0\.099 TAO/);
    expect(out).not.toContain("0xfinney");
  });

  it("still returns local rows when the relay throws", async () => {
    const { walletSend, walletHistory } = await import("../src/tools.js");
    const { adapter, transfers } = fakeAdapter(2_000_000_000n);
    const d = baseDeps(adapter);
    await walletSend(d, { to: "5Dest", amount: "0.005", asset: "TAO" });
    expect(transfers).toHaveLength(1);
    const throwing: ConsentRelay = {
      publish: async () => {},
      subscribe: () => () => {},
      query: async () => {
        throw new Error("relay unreachable");
      },
    };
    const out = await walletHistory({ ...d, relay: () => Promise.resolve(throwing) }, { limit: 10 });
    expect(out).toContain("5Dest");
  });
});
