import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeStorage, removeStorage } from "../../../src/extensions/extension-storage.js";

/**
 * The storage seam's promise: an extension keeps state between runs
 * without inventing its own file convention, and can only ever see its
 * OWN namespace. Everything here drives the real files — a mocked fs
 * would prove nothing about the durability the seam exists to provide.
 */
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "fez-ext-storage-"));

afterAll(() => fs.rmSync(WORK, { recursive: true, force: true }));

describe("extension storage", () => {
  it("round-trips a value and survives a new instance (persistence)", async () => {
    const a = makeStorage("polls", WORK);
    await a.set("last-sync", { at: 123, ok: true });
    expect(await a.get("last-sync")).toEqual({ at: 123, ok: true });

    // a fresh instance — as after a restart — sees the same data
    const b = makeStorage("polls", WORK);
    expect(await b.get("last-sync")).toEqual({ at: 123, ok: true });
  });

  it("returns undefined for a missing key and an empty keys() before any write", async () => {
    const s = makeStorage("fresh", WORK);
    expect(await s.get("nope")).toBeUndefined();
    expect(await s.keys()).toEqual([]);
  });

  it("namespaces by extension name — one extension never sees another's data", async () => {
    const mine = makeStorage("mine", WORK);
    const theirs = makeStorage("theirs", WORK);
    await mine.set("secret", "abc");
    expect(await theirs.get("secret")).toBeUndefined();
    expect(await theirs.keys()).toEqual([]);
  });

  it("delete removes the key; keys() lists what remains", async () => {
    const s = makeStorage("deleter", WORK);
    await s.set("a", 1);
    await s.set("b", 2);
    await s.delete("a");
    expect(await s.get("a")).toBeUndefined();
    expect(await s.keys()).toEqual(["b"]);
  });

  it("treats a corrupt file as empty instead of crashing", async () => {
    fs.writeFileSync(path.join(WORK, "corrupt.json"), "{not json");
    const s = makeStorage("corrupt", WORK);
    expect(await s.get("anything")).toBeUndefined();
    // and it can still write afterwards
    await s.set("recovered", true);
    expect(await s.get("recovered")).toBe(true);
  });

  it("removeStorage drops the namespace (fez remove's cleanup), leaving others intact", async () => {
    const doomed = makeStorage("doomed", WORK);
    const kept = makeStorage("kept", WORK);
    await doomed.set("x", 1);
    await kept.set("y", 2);
    await removeStorage("doomed", WORK);
    expect(await makeStorage("doomed", WORK).keys()).toEqual([]);
    expect(await kept.get("y")).toBe(2);
    // removing a namespace that never wrote anything is not an error
    await removeStorage("never-existed", WORK);
  });

  it("serializes concurrent writes — the last value wins, nothing is lost", async () => {
    const s = makeStorage("racer", WORK);
    await Promise.all([s.set("a", 1), s.set("b", 2), s.set("c", 3)]);
    const fresh = makeStorage("racer", WORK);
    expect(await fresh.get("a")).toBe(1);
    expect(await fresh.get("b")).toBe(2);
    expect(await fresh.get("c")).toBe(3);
  });
});

// Native preference behavior is exercised through real Tauri IPC by
// isolated-panel.test.ts (including namespace, preservation and corrupt data).
// Keep the inventory tripwire focused on the one shared implementation.
describe("native extension-data write inventory", () => {
  const lib = fs.readFileSync(path.join(__dirname, "../../fez-desktop/src-tauri/src/lib.rs"), "utf8");
  const panel = fs.readFileSync(path.join(__dirname, "../../fez-desktop/src-tauri/src/isolated_panel.rs"), "utf8").split("#[cfg(test)]")[0];

  it("routes the legacy command through the same preference writer as the isolated broker", () => {
    const command = lib.split("fn extension_storage_write")[1].split("#[tauri::command]")[0];
    expect(command).toContain("isolated_panel::write_preference");
    const broker = panel.split("fn isolated_panel_request")[1].split("\nfn allowed_url")[0];
    expect(broker).toContain("write_preference(");
    expect(lib).not.toContain('"extension-data"');
    expect((panel.match(/"extension-data"/g) ?? []).length).toBe(1);
  });
});
