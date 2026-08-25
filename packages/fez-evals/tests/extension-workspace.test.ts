import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadExtensions, setNostrBackend, setWorkspaceBackend, type FezExtensionAPI } from "../../../src/extensions/extensions.js";

/**
 * An extension is BUILT before the client connects, and must still see
 * the workspace once it is known.
 *
 * This is a regression test for a bug introduced while removing a hack.
 * The old code guessed `owner = my own pubkey` when it didn't know; the
 * fix removed the guess — and made `api.channels` resolve ONCE, at
 * extension-load time. But extensions are deliberately loaded before
 * `client.start()` so they're listening when its first events land, so
 * "once, at load time" is always too early: every extension in the TUI
 * would have got `channels: undefined` forever. Resolving on access is
 * what makes the seam correct AND late-binding.
 */

const OWNER = "c".repeat(64);
const SELF = "d".repeat(64);
let dir: string;
let captured: FezExtensionAPI;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "fez-ext-"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  // Captures the api object it is handed, exactly as a real extension holds it.
  writeFileSync(
    path.join(dir, "probe.js"),
    "export default function (api) { globalThis.__probeApi = api; }\n"
  );

  setNostrBackend({
    pubkey: OWNER,
    // Annotated because the `as never` below switches off contextual
    // typing for this literal, which would otherwise infer these.
    publish: async (t: { kind: number; tags: string[][]; content: string }) => ({
      ...t,
      id: "",
      pubkey: OWNER,
      created_at: 0,
      sig: "",
    }),
    signEvent: (t: { kind: number; tags: string[][]; content: string }) => ({
      ...t,
      id: "",
      pubkey: OWNER,
      created_at: 0,
      sig: "",
    }),
    subscribe: () => () => {},
    query: async () => [],
    encrypt: () => "",
    decrypt: () => "",
    sendDm: async () => "",
    unwrapDm: () => undefined,
  } as never);

  // The workspace is NOT known yet — this is the real startup ordering.
  await loadExtensions(dir, ["probe"]);
  captured = (globalThis as { __probeApi?: FezExtensionAPI }).__probeApi!;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("an extension loaded before the workspace is known", () => {
  it("is handed an api at all", () => {
    expect(captured).toBeDefined();
  });

  it("sees no channels while the owner is unknown", () => {
    // Not a guess, and not a crash: there is genuinely no answer yet.
    expect(captured.channels).toBeUndefined();
  });

  it("sees channels once the workspace owner arrives", () => {
    // THE REGRESSION. Resolved at load time this stays undefined forever.
    setWorkspaceBackend({ relayUrl: "ws://localhost:7777", owner: OWNER, info: { pubkey: OWNER } });
    expect(captured.channels).toBeDefined();
  });

  it("exposes what the relay advertised, for extensions that need a URL", () => {
    setWorkspaceBackend({
      relayUrl: "ws://localhost:7777",
      owner: OWNER,
      info: { pubkey: OWNER, fez_git: { clone_base: "https://x.dev/git" } },
    });
    expect(captured.workspace?.info?.fez_git).toEqual({ clone_base: "https://x.dev/git" });
    expect(captured.workspace?.relayUrl).toBe("ws://localhost:7777");
  });

  it("goes quiet again if the workspace turns out to be unclaimed", () => {
    // Switching to a relay nobody owns must not leave the previous
    // owner's seam in place — that would write into the wrong workspace.
    setWorkspaceBackend({ relayUrl: "ws://other", owner: undefined, info: {} });
    expect(captured.channels).toBeUndefined();
  });

  it("never falls back to the local key as the owner", () => {
    // The original hack. On a relay owned by someone else this made
    // list() query the wrong author and silently return nothing.
    setWorkspaceBackend({ relayUrl: "ws://other", owner: SELF, info: {} });
    expect(captured.workspace?.owner).toBe(SELF);
    expect(captured.workspace?.owner).not.toBe(OWNER);
  });
});
