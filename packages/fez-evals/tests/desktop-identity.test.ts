import { afterEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { FezClient, type Wire } from "../../fez-client/src/index.js";
import { rustSigner } from "../../fez-desktop/src/wire";
import { invitePersona } from "../../fez-desktop/src/invite-persona";

afterEach(() => vi.unstubAllGlobals());

// The keychain host is macOS-only. Run the real Rust creation policy;
// its tests use generated test keys and never touch the user's keychain.
it.skipIf(process.platform !== "darwin")("native identity creation fails closed and preserves existing keys", async () => {
  await promisify(execFile)("cargo", [
    "test", "--manifest-path", fileURLToPath(new URL("../../fez-desktop/src-tauri/Cargo.toml", import.meta.url)),
    "--lib", "identity_key_tests",
  ], { timeout: 110_000, maxBuffer: 1024 * 1024 });
}, 120_000);

it("native signing and every DM operation use the selected account", async () => {
  const invoke = vi.fn(async (_command: string, _args?: unknown) => "{}");
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
  const signer = rustSigner("agent-pubkey", "agent:fez");
  await signer.sign({ kind: 1, tags: [], content: "hello" });
  await signer.encrypt("peer", "plaintext");
  await signer.decrypt("peer", "ciphertext");
  await signer.wrapDm(14, "hello", [], ["peer"]);
  await signer.unwrap({ id: "id", sig: "sig", kind: 1059, pubkey: "peer", created_at: 1, tags: [], content: "wrap" });
  expect(invoke.mock.calls.map(([command, args]) => [command, args])).toEqual([
    ["sign_event", { account: "agent:fez", kind: 1, tags: [], content: "hello", createdAt: undefined }],
    ["nip44_encrypt", { account: "agent:fez", peer: "peer", plaintext: "plaintext" }],
    ["nip44_decrypt", { account: "agent:fez", peer: "peer", ciphertext: "ciphertext" }],
    ["dm_wrap_all", { account: "agent:fez", kind: 14, content: "hello", tags: [], recipients: ["peer"] }],
    ["dm_unwrap", { account: "agent:fez", event: JSON.stringify({ id: "id", sig: "sig", kind: 1059, pubkey: "peer", created_at: 1, tags: [], content: "wrap" }) }],
  ]);
});

it("inviting a local persona needs only its public key", async () => {
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === "list_personas") return ["drift"];
    if (cmd === "get_pubkey") return "agent-pubkey";
    throw new Error(`Private key access forbidden: ${cmd}`);
  });
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
  const client = new FezClient({ pubkey: "owner" } as Wire);
  const invite = vi.spyOn(client, "invite").mockResolvedValue(undefined);
  expect(await invitePersona(client, "@Drift")).toEqual({ kind: "invited", persona: "drift", role: "bot" });
  expect(invite).toHaveBeenCalledWith("agent-pubkey", "bot");
  expect(invoke).toHaveBeenLastCalledWith("get_pubkey", { account: "agent:drift" }, undefined);
});
