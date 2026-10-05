import { keychainFind, keychainForget, keychainStore } from "@fezchat/protocol";

const SERVICE = "fez-mining";
export const secretAccount = (netuid: number, persona: string, key: string): string =>
  `${netuid}:${persona}:${key}`;

export function setSecret(netuid: number, persona: string, key: string, value: string): void {
  // -U updates if present; -w takes the secret from argv (fine on macOS, the
  // desktop is single-user). Same `security` surface fez-wallet uses.
  keychainStore(SERVICE, secretAccount(netuid, persona, key), value);
}
export function getSecret(netuid: number, persona: string, key: string): string | undefined {
  try {
    return keychainFind(SERVICE, secretAccount(netuid, persona, key));
  } catch { return undefined; }
}
export const hasSecret = (netuid: number, persona: string, key: string): boolean =>
  getSecret(netuid, persona, key) !== undefined;
export function deleteSecret(netuid: number, persona: string, key: string): void {
  keychainForget(SERVICE, secretAccount(netuid, persona, key));
}
