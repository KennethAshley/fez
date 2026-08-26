import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import type { ChainAdapter } from "../src/chains/adapter.js";
import type { ConsentRelay, SignedNostrEvent } from "../src/consent.js";

const ownerSk = generateSecretKey();
const ownerPk = getPublicKey(ownerSk);
const agentNostrKey = bytesToHex(generateSecretKey());
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
      return { txHash: "0xfeed" };
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
  };
  return { relay, getRequest: () => request };
}

function deps(over: Partial<import("../src/tools.js").ToolDeps> = {}) {
  const { adapter, transfers } = fakeAdapter(2_000_000_000n); // 2 TAO
  return {
    transfers,
    d: {
      persona: "scout",
      pair,
      adapters: [adapter],
      config: {
        thresholds: { default: "0.01" },
        consentChannel: "chan1",
        personas: {},
        endpoints: { tao: "wss://unused" },
      },
      ownerPk,
      agentNostrKey,
      now: () => "2026-08-25T00:00:00Z",
      ...over,
    },
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
    expect(walletAddress(deps().d, {})).toContain("5Agent");
  });

  it("walletBalance formats the balance", async () => {
    const { walletBalance } = await import("../src/tools.js");
    expect(await walletBalance(deps().d, {})).toContain("2 TAO");
  });

  it("sends under threshold without consent and logs it", async () => {
    const { walletSend, walletHistory } = await import("../src/tools.js");
    const { d, transfers } = deps();
    const out = await walletSend(d, { to: "5Dest", amount: "0.005", asset: "TAO" });
    expect(out).toContain("0xfeed");
    expect(transfers).toHaveLength(1);
    expect(walletHistory(d, {})).toContain("5Dest");
  });

  it("blocks over-threshold sends behind consent — approved path executes", async () => {
    const { walletSend } = await import("../src/tools.js");
    const { relay } = autoRelay(() => "✅");
    const { d, transfers } = deps({ relay: async () => relay });
    const out = await walletSend(d, { to: "5Dest", amount: "0.5", asset: "TAO", memo: "chutes" });
    expect(out).toContain("0xfeed");
    expect(transfers).toHaveLength(1);
  });

  it("the consent request carries the full recipient address", async () => {
    const { walletSend } = await import("../src/tools.js");
    const { relay, getRequest } = autoRelay(() => "✅");
    const { d } = deps({ relay: async () => relay });
    const long = "5E76cpgXAHSZKM7pRhYcbNnCXcuFpZzVN9F7G7G4";
    await walletSend(d, { to: long, amount: "0.5", asset: "TAO" });
    expect(getRequest()?.content).toContain(long);
  });

  it("declined consent does not transfer", async () => {
    const { walletSend } = await import("../src/tools.js");
    const { relay } = autoRelay(() => "❌");
    const { d, transfers } = deps({ relay: async () => relay });
    const out = await walletSend(d, { to: "5Dest", amount: "0.5", asset: "TAO" });
    expect(out.toLowerCase()).toContain("declined");
    expect(transfers).toHaveLength(0);
  });

  it("insufficient balance errors before any consent round-trip", async () => {
    const { walletSend } = await import("../src/tools.js");
    const { d, transfers } = deps();
    await expect(walletSend(d, { to: "5Dest", amount: "3", asset: "TAO" })).rejects.toThrow(/balance/i);
    expect(transfers).toHaveLength(0);
  });

  it("wallet_send to the reserved root name never reads or resolves the mnemonic", async () => {
    const { walletSend } = await import("../src/tools.js");
    process.env.FEZ_WALLET_STORE = "file";
    const { writeRootEntry } = await import("../src/store.js");
    const mnemonic = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
    writeRootEntry(mnemonic); // a root entry exists — the vulnerable path would read it
    const { d, transfers } = deps();
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
    const { d, transfers } = deps({ relay: async () => relay, signal: controller.signal });
    const out = await walletSend(d, { to: "5Dest", amount: "0.5", asset: "TAO" });
    expect(out.toLowerCase()).toContain("aborted");
    expect(transfers).toHaveLength(0);
  });

  it("resolves a persona name to its derived address", async () => {
    const { walletSend } = await import("../src/tools.js");
    const { d, transfers } = deps();
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
