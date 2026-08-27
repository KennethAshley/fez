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

/**
 * Inventory heuristic, after Buzz's egress guard. What this DOES catch:
 * a future command whose own body names the literal "extension-data"
 * path segment and calls one of the write patterns below directly — a
 * copy-pasted path-join plus a direct write, which is how this class of
 * command has always been written in this file so far (both existing
 * ones look exactly like that). What it does NOT catch: a write reached
 * entirely through indirection — e.g. a shared helper that builds the
 * path once and is called from several commands, none of which mentions
 * "extension-data" or a write syscall themselves. The second assertion
 * below closes part of that gap (a helper is still text in this file, so
 * a *new* occurrence of the literal is visible even if it moves into a
 * fn neither test currently names) but a helper that computes the path
 * without the literal string ("extension-data") would still slip past
 * both. This is a tripwire, not a proof of exhaustiveness.
 */
describe("extension-data write inventory", () => {
  const libRs = fs.readFileSync(
    path.join(__dirname, "../../fez-desktop/src-tauri/src/lib.rs"),
    "utf-8"
  );
  // Widened past fs::write to the other direct-write idioms Rust code
  // actually uses for "serialize a json::Value to a file": File::create
  // (often paired with to_writer/to_writer_pretty) and write_all/OpenOptions
  // for anything that opens a handle explicitly.
  const WRITE_PATTERN = /fs::write|write_all|OpenOptions|File::create|to_writer/;
  const KNOWN_FNS = ["extension_storage_read", "extension_storage_write"];

  it("has exactly one command writing extension-data", () => {
    // Commands that name the directory AND write it.
    const writers = libRs
      .split("#[tauri::command]")
      .slice(1)
      .filter((body) => body.includes("extension-data") && WRITE_PATTERN.test(body))
      .map((body) => /fn\s+(\w+)/.exec(body)?.[1]);
    expect(writers).toEqual(["extension_storage_write"]);
  });

  it("scopes that command to the prefs subtree", () => {
    const body = libRs.split("fn extension_storage_write")[1].split("#[tauri::command]")[0];
    expect(body).toContain("\"prefs\"");
  });

  it("accounts for every occurrence of the extension-data literal in one of the two known functions", () => {
    // Closes the shared-helper hole in the first assertion: a future fn
    // that builds its path through a helper wouldn't show up there, but
    // if that helper (or the new fn itself) names "extension-data"
    // anywhere in this file, that occurrence has to live inside
    // extension_storage_read or extension_storage_write — the only two
    // places that literal is allowed to appear today. A third site
    // (helper or otherwise) fails this even though the first assertion
    // would miss it.
    const totalOccurrences = (libRs.match(/"extension-data"/g) || []).length;
    expect(totalOccurrences).toBe(2); // today's count — read+write, one each

    const coveredOccurrences = KNOWN_FNS.reduce((sum, fnName) => {
      const body = libRs.split(`fn ${fnName}`)[1].split("#[tauri::command]")[0];
      return sum + (body.match(/"extension-data"/g) || []).length;
    }, 0);
    expect(coveredOccurrences).toBe(totalOccurrences);
  });
});
