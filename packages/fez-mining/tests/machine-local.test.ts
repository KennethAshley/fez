import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { localMachine } from "../src/machine-local.js";

describe("localMachine", () => {
  it("execs a shell command with env and cwd", async () => {
    const m = localMachine();
    const dir = mkdtempSync(path.join(tmpdir(), "fm-"));
    const r = await m.exec("printf '%s' \"$FOO\" > out.txt && pwd", { env: { FOO: "bar" }, cwd: dir });
    expect(r.code).toBe(0);
    expect(readFileSync(path.join(dir, "out.txt"), "utf8")).toBe("bar");
  });
  it("reports nonzero exit codes without throwing", async () => {
    const r = await localMachine().exec("exit 3");
    expect(r.code).toBe(3);
  });
  it("copies a file", async () => {
    const m = localMachine();
    const dir = mkdtempSync(path.join(tmpdir(), "fm-"));
    const src = path.join(dir, "a"); writeFileSync(src, "x");
    await m.copy(src, path.join(dir, "b"));
    expect(readFileSync(path.join(dir, "b"), "utf8")).toBe("x");
  });
  it("has no ports and kind local", () => {
    const m = localMachine();
    expect(m.kind).toBe("local");
    expect(m.ports).toEqual([]);
  });
});
