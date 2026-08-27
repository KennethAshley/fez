import type { WalletPair } from "../derive.js";

export interface Amount {
  raw: bigint;
  decimals: number;
  symbol: string;
}

export interface ChainAdapter {
  chain: string;
  assets: { symbol: string; decimals: number }[];
  address(pair: WalletPair): string;
  balance(address: string, asset: string): Promise<Amount>;
  /** `blockRef` is the block the transfer landed in — a plain block hash
   * on substrate. Carried so a receipt can be verified without an
   * indexer: substrate cannot look an extrinsic up by hash alone. */
  transfer(pair: WalletPair, to: string, amount: Amount): Promise<{ txHash: string; blockRef?: string }>;
  /** Undefined when the chain (or the retained history) can't answer.
   * Undefined means UNVERIFIABLE, never "invalid" — see spec §4. */
  getTransfer?(blockRef: string, txHash: string): Promise<{ from: string; to: string; raw: bigint } | undefined>;
}

export function parseAmount(text: string, decimals: number, symbol: string): Amount {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`bad amount "${text}" — expected e.g. "0.5"`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`"${text}" has more than ${decimals} decimal places`);
  const raw = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  return { raw, decimals, symbol };
}

export function formatAmount(a: Amount): string {
  const base = 10n ** BigInt(a.decimals);
  const whole = a.raw / base;
  const frac = (a.raw % base).toString().padStart(a.decimals, "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} ${a.symbol}`;
}
