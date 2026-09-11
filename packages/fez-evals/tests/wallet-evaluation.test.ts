import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdFund, cmdNetwork, cmdRegister, derivePersona, exportRemoteHotkey,
  initWallet, payFromTreasury, payoutPersona, registerPersona,
} from "../../fez-wallet/src/cli-commands.js";
import { stakePersona, unstakePersona, escrowOpen, escrowApprove } from "../../fez-wallet/src/stake.js";
import { rentAgent, payAddress } from "../../fez-wallet/src/rent.js";
import { burnRun } from "../../fez-wallet/src/fees.js";
import { makeX402Deps, walletAddress, walletBalance, walletHistory, walletSend, x402FetchRaw, type ToolDeps, type X402ToolDeps } from "../../fez-wallet/src/tools.js";
import type { ChainAdapter } from "../../fez-wallet/src/chains/adapter.js";

// Removing an entry-point guard must fail before any real key or network access.
vi.mock("../../fez-wallet/src/store.js", () => {
  const unexpected = () => { throw new Error("unexpected key access"); };
  return Object.fromEntries([
    "readEntry", "writeEntry", "readRootEntry", "writeRootEntry",
    "readRemoteHotkeyEntry", "writeRemoteHotkeyEntry", "readAgentNostrKey",
  ].map(name => [name, unexpected]));
});
vi.mock("../../fez-wallet/src/chains/subtensor.js", async (original) => ({
  ...await original<typeof import("../../fez-wallet/src/chains/subtensor.js")>(),
  connectSubtensor: async () => { throw new Error("unexpected chain connection"); },
}));

const blocked = /disabled during agent evaluation/;
const io = { print: (_line: string) => {} };
const adapter: ChainAdapter = {
  chain: "tao", assets: [{ symbol: "TAO", decimals: 9 }],
  address: pair => pair.address,
  balance: async () => ({ raw: 1_000_000_000n, decimals: 9, symbol: "TAO" }),
  transfer: async () => { throw new Error("unexpected transfer"); },
};
const deps: ToolDeps = {
  persona: "scout", pair: { publicKeyHex: "aa", secretKeyHex: "bb", address: "5Scout" },
  adapters: [adapter],
  config: { thresholds: { default: "1" }, personas: {}, endpoints: { tao: "wss://unused" }, network: "test", knownPayees: [] },
  resolve: async () => { throw new Error("unexpected recipient lookup"); },
};
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wallet-evaluation-"));
  vi.stubEnv("FEZ_EVALUATION_ACTIVE", "1");
  vi.stubEnv("FEZ_WALLET_HOME", dir);
  vi.stubEnv("FEZ_EXTENSION_DATA_DIR", join(dir, "extension-data"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("evaluation wallet cannot mutate money, keys or network selection", () => {
  const mutations: [string, () => Promise<unknown>][] = [
    ["init", () => initWallet()],
    ["derive", () => derivePersona("scout")],
    ["fund", () => cmdFund(io, adapter, "scout", "0.1")],
    ["register", () => registerPersona("scout")],
    ["register prose", () => cmdRegister(io, "scout")],
    ["export hotkey", () => exportRemoteHotkey("scout")],
    ["export existing hotkey", () => exportRemoteHotkey("scout", { existing: true })],
    ["stake", () => stakePersona("scout", "0.1")],
    ["unstake", () => unstakePersona("scout", "0.1")],
    ["rent", () => rentAgent("scout", "a".repeat(64), 1)],
    ["pay", () => payAddress("scout", "5".repeat(48), "0.1")],
    ["treasury pay", () => payFromTreasury(adapter, "5".repeat(48), "0.1")],
    ["payout", () => payoutPersona("scout")],
    ["escrow open", () => escrowOpen("scout", "worker", "arbiter", "0.1")],
    ["escrow release", () => escrowApprove("scout", "poster", "worker", "arbiter", "0.1", "worker")],
    ["escrow refund", () => escrowApprove("scout", "poster", "worker", "arbiter", "0.1", "poster")],
    ["burn run", () => burnRun("0.1")],
    ["network switch", () => cmdNetwork(io, "test")],
    ["wallet send", () => walletSend(deps, { to: "5Destination", amount: "0.1", asset: "TAO" })],
    ["x402 setup", () => makeX402Deps("scout")],
    ["x402 direct", () => {
      const x402: X402ToolDeps = {
        persona: "scout", evmPair: { addressHex: "0x00", privateKeyHex: "0x00" },
        adapter, config: deps.config, dir,
        fetchImpl: async () => { throw new Error("unexpected paid HTTP request"); },
      };
      return x402FetchRaw(x402, { url: "https://unused.example/paid", maxUsd: 1 });
    }],
  ];
  it.each(mutations)("blocks %s before wallet/provider access", async (_name, mutate) => {
    await expect(mutate()).rejects.toThrow(blocked);
  });

  it("keeps wallet address, balance, history and network reads usable", async () => {
    expect(walletAddress(deps, {})).toContain("5Scout");
    expect(await walletBalance(deps, {})).toContain("1 TAO");
    expect(await walletHistory(deps, {})).toBe("no transfers recorded.");
    const lines: string[] = [];
    await cmdNetwork({ print: line => lines.push(line) });
    expect(lines.join("\n")).toContain("network: finney");
  });

  it("keeps ordinary owner wallet operations available outside evaluation", async () => {
    vi.stubEnv("FEZ_EVALUATION_ACTIVE", "0");
    const lines: string[] = [];
    await cmdNetwork({ print: line => lines.push(line) }, "test");
    expect(lines.join("\n")).toContain("network: test");
  });
});
