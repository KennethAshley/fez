import { execFileSync } from "node:child_process";

const SERVICE = "fez-mining";
export const secretAccount = (netuid: number, persona: string, key: string): string =>
  `${netuid}:${persona}:${key}`;

export function setSecret(netuid: number, persona: string, key: string, value: string): void {
  // -U updates if present; -w takes the secret from argv (fine on macOS, the
  // desktop is single-user). Same `security` surface fez-wallet uses.
  execFileSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", secretAccount(netuid, persona, key), "-w", value], { stdio: ["ignore", "ignore", "ignore"] });
}
export function getSecret(netuid: number, persona: string, key: string): string | undefined {
  try {
    return execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", secretAccount(netuid, persona, key), "-w"], { encoding: "utf8" }).replace(/\n$/, "");
  } catch { return undefined; }
}
export const hasSecret = (netuid: number, persona: string, key: string): boolean =>
  getSecret(netuid, persona, key) !== undefined;
export function deleteSecret(netuid: number, persona: string, key: string): void {
  try { execFileSync("security", ["delete-generic-password", "-s", SERVICE, "-a", secretAccount(netuid, persona, key)], { stdio: ["ignore", "ignore", "ignore"] }); } catch { /* absent is fine */ }
}
