import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorX402Spend, mirrorEvmAddress, mirrorX402Meta } from "../src/storage-mirror.js";
import { x402Settings, USDC_BASE_SEPOLIA, USDC_BASE_MAINNET, type WalletConfig } from "../src/config.js";
import { erc20BalanceCall, parseUsdcBalance, validUsd, x402TxLink } from "../src/gui-logic.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "x402gui-"));
  process.env.FEZ_EXTENSION_DATA_DIR = dir;
});
afterEach(() => {
  delete process.env.FEZ_EXTENSION_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function mirrorState(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "wallet.json"), "utf8"));
}

const ROW = {
  ts: "2026-08-30T12:00:00.000Z",
  persona: "scout",
  url: "https://api.example.com/pay",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  usd: 0.01,
  status: "signed" as const,
  network: "base-sepolia",
};

describe("x402 mirror — the gui's read-only view", () => {
  it("mirrorX402Spend appends rows the panel can render", async () => {
    await mirrorX402Spend(ROW);
    await mirrorX402Spend({ ...ROW, status: "settled", txHash: "0xabc" });
    const s = mirrorState();
    const log = s.x402Log as (typeof ROW & { txHash?: string })[];
    expect(log).toHaveLength(2);
    expect(log[1].status).toBe("settled");
    expect(log[1].txHash).toBe("0xabc");
  });

  it("mirrorEvmAddress records a persona's fundable address", async () => {
    await mirrorEvmAddress({ name: "scout", address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" });
    const s = mirrorState();
    expect((s.evmAddresses as Record<string, string>).scout).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  it("mirrorX402Meta records the resolved settings snapshot", async () => {
    await mirrorX402Meta({ network: "base-sepolia", rpcUrl: "https://sepolia.base.org", usdcAddress: "0x036C", dailyCapUsd: 25, autoApproveDefault: 0 });
    const s = mirrorState();
    expect((s.x402Meta as { network: string }).network).toBe("base-sepolia");
  });
});

const BASE: WalletConfig = {
  thresholds: { default: "0.01" },
  personas: {},
  endpoints: { tao: "wss://x" },
  network: "finney",
  knownPayees: [],
};

describe("x402Settings — prefs layer wins, and a flip moves the triple together", () => {
  it("no prefs → identical to disk-only resolution", () => {
    const s = x402Settings({ ...BASE, x402: { dailyCapUsd: 10 } }, {});
    expect(s.dailyCapUsd).toBe(10);
    expect(s.chainRef).toBe("eip155:84532");
  });

  it("a prefs network flip derives chainRef+usdcAddress+rpcUrl from the table, IGNORING disk-level chain overrides", () => {
    const cfg: WalletConfig = { ...BASE, x402: { chainRef: "eip155:84532", usdcAddress: "0xDISKOVERRIDE", rpcUrl: "https://disk.example" } };
    const s = x402Settings(cfg, { x402: { network: "base" } });
    expect(s.network).toBe("base");
    expect(s.chainRef).toBe("eip155:8453");
    expect(s.usdcAddress).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(s.rpcUrl).toBe("https://mainnet.base.org");
  });

  it("prefs' own explicit overrides still win over its derived row", () => {
    const s = x402Settings(BASE, { x402: { network: "base", rpcUrl: "https://my.node" } });
    expect(s.rpcUrl).toBe("https://my.node");
    expect(s.usdcAddress).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  // I2: a prefs-level chain-fact override is honored ONLY for an
  // unrecognized network label — for a KNOWN one (here "base-sepolia"),
  // the table wins regardless of which layer named the override, so a
  // mainnet contract can never survive under a testnet label the panel
  // shows as just that label.
  it("a prefs-level usdcAddress override is ignored for a KNOWN network — the table wins, not the override", () => {
    const s = x402Settings(BASE, { x402: { network: "base-sepolia", usdcAddress: USDC_BASE_MAINNET } });
    expect(s.usdcAddress).toBe(USDC_BASE_SEPOLIA);
  });

  it("garbage prefs numbers fail CLOSED to the next layer, never open", () => {
    const cfg: WalletConfig = { ...BASE, x402: { dailyCapUsd: 10 } };
    const s = x402Settings(cfg, { x402: { dailyCapUsd: Number("abc"), autoApproveUnderUsd: { default: Number("nope") } } });
    expect(s.dailyCapUsd).toBe(10); // disk layer, not NaN, not 25
    expect(s.autoApproveUnderUsd.default).toBe(0); // default floor survives
  });

  it("prefs autoApprove merges over disk over defaults", () => {
    const cfg: WalletConfig = { ...BASE, x402: { autoApproveUnderUsd: { scout: 0.5 } } };
    const s = x402Settings(cfg, { x402: { autoApproveUnderUsd: { scout: 1 } } });
    expect(s.autoApproveUnderUsd.scout).toBe(1);
    expect(s.autoApproveUnderUsd.default).toBe(0);
  });
});

describe("gui-logic x402 helpers (pure, browser-safe)", () => {
  it("erc20BalanceCall encodes balanceOf(holder) for eth_call", () => {
    const c = erc20BalanceCall("0x036CbD53842c5426634e7929541eC2318f3dCF7e", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(c.to).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(c.data).toBe("0x70a08231000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  });

  it("parseUsdcBalance renders 6-decimal atomic hex as dollars", () => {
    expect(parseUsdcBalance("0x" + (5_000_000).toString(16))).toBe("5.00");
    expect(parseUsdcBalance("0x0")).toBe("0.00");
    expect(parseUsdcBalance("not-hex")).toBeUndefined();
  });

  it("validUsd accepts money-shaped text only", () => {
    expect(validUsd("25")).toBe(true);
    expect(validUsd("0.5")).toBe(true);
    expect(validUsd("")).toBe(false);
    expect(validUsd("abc")).toBe(false);
    expect(validUsd("-1")).toBe(false);
  });

  it("x402TxLink targets the right basescan by network", () => {
    expect(x402TxLink("base-sepolia", "0xabc")).toBe("https://sepolia.basescan.org/tx/0xabc");
    expect(x402TxLink("base", "0xabc")).toBe("https://basescan.org/tx/0xabc");
  });
});

describe("storage name adoption — the panel and the wallet share ONE file", () => {
  it("off-install writes join whichever home already exists — never a second file", async () => {
    // The forked-mirror bug, from the other direction: an installed app
    // owns wallet.json; a dev-repo run must WRITE THERE rather than mint
    // fez-wallet.json beside it and split the truth in two.
    const { writeFileSync, existsSync } = await import("node:fs");
    writeFileSync(join(dir, "wallet.json"), JSON.stringify({ addresses: { treasury: "5X" } }));
    await mirrorEvmAddress({ name: "scout", address: "0xabc" });
    const s = JSON.parse(readFileSync(join(dir, "wallet.json"), "utf8")) as Record<string, unknown>;
    expect((s.addresses as { treasury: string }).treasury).toBe("5X"); // existing data untouched
    expect((s.evmAddresses as Record<string, string>).scout).toBe("0xabc"); // new write joined it
    expect(existsSync(join(dir, "fez-wallet.json"))).toBe(false); // one home, never two
  });
});
