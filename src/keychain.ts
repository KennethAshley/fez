/**
 * The one place an extension's secret crosses a process boundary.
 *
 * macOS keeps secrets in the login keychain through `/usr/bin/security`.
 * Linux keeps them in the Secret Service (gnome-keyring, KWallet, …)
 * through `secret-tool`, under the same service/account pair, so both
 * platforms address the same entry by the same name. This mirrors the
 * desktop app's own keychain.rs; the two must stay in step, because they
 * read and write each other's entries.
 *
 * Absence and access failure stay separate: `find` returns undefined only
 * when the store answered and held nothing, and throws when it could not
 * answer at all. Callers that treat "can't read" as "not set" would mint
 * a second credential over an existing one.
 */
import { execFileSync, spawnSync } from "node:child_process";

/** Which backend this platform has, or undefined when it has none. */
export function keychainBackend(): "security" | "secret-tool" | undefined {
  if (process.platform === "darwin") return "security";
  if (process.platform === "linux") return "secret-tool";
  return undefined;
}

function required(): "security" | "secret-tool" {
  const backend = keychainBackend();
  if (!backend) throw new Error(`no keychain backend on ${process.platform}`);
  return backend;
}

function missingTool(error: unknown, tool: string): Error {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") {
    return new Error(
      tool === "secret-tool"
        ? "secret-tool is missing — install libsecret-tools to use your keyring"
        : "the security command is missing"
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** The stored secret, or undefined when the store holds nothing here. */
export function keychainFind(service: string, account: string): string | undefined {
  const tool = required();
  const argv =
    tool === "security"
      ? ["find-generic-password", "-s", service, "-a", account, "-w"]
      : ["lookup", "service", service, "account", account];
  let out;
  try {
    out = spawnSync(tool, argv, { encoding: "utf-8" });
  } catch (error) {
    throw missingTool(error, tool);
  }
  if (out.error) throw missingTool(out.error, tool);
  if (out.status === 0) return out.stdout.trim() || undefined;
  // `security` exits 44 (errSecItemNotFound) for an absent item. libsecret
  // has no exit code for it and simply says nothing, so silence is the
  // absence signal there; anything on stderr is a real failure.
  const absent = tool === "security" ? out.status === 44 || /could not be found/.test(out.stderr ?? "")
                                     : !(out.stderr ?? "").trim();
  if (absent) return undefined;
  throw new Error(`keychain read failed for "${account}": ${(out.stderr ?? "").trim()}`);
}

/** Whether a secret exists. A store that cannot answer throws. */
export function keychainHas(service: string, account: string): boolean {
  return keychainFind(service, account) !== undefined;
}

/** Write a secret, replacing any existing value under the same name. */
export function keychainStore(service: string, account: string, value: string, label?: string): void {
  const tool = required();
  try {
    if (tool === "security") {
      execFileSync(tool, ["add-generic-password", "-U", "-s", service, "-a", account,
                          ...(label ? ["-l", label] : []), "-w", value],
                   { stdio: "ignore" });
      return;
    }
    // secret-tool reads the secret from stdin; no trailing newline, or it
    // becomes part of the stored value.
    const out = spawnSync(tool, ["store", "--label", label ?? `fez: ${service}/${account}`,
                                 "service", service, "account", account],
                          { input: value, encoding: "utf-8" });
    if (out.error) throw out.error;
    if (out.status !== 0) {
      throw new Error(`keychain write failed for "${account}": ${(out.stderr ?? "").trim()}`);
    }
  } catch (error) {
    throw missingTool(error, tool);
  }
}

/** Forget a secret. A missing entry is success: callers use this to
 *  disconnect, which is idempotent. */
export function keychainForget(service: string, account: string): void {
  const tool = keychainBackend();
  if (!tool) return;
  const argv =
    tool === "security"
      ? ["delete-generic-password", "-s", service, "-a", account]
      : ["clear", "service", service, "account", account];
  spawnSync(tool, argv, { stdio: "ignore" });
}
