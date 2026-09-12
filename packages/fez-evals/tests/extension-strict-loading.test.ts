import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadExtensions } from "../../../src/extensions/extensions.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
function directory() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "fez-strict-extensions-")); roots.push(root); return root; }

it("strict loading refuses missing selected extensions, including a missing extension directory", async () => {
  const dir = directory();
  await expect(loadExtensions(dir, ["missing"], { strict: true })).rejects.toThrow(/missing/);
  await expect(loadExtensions(path.join(dir, "absent"), ["missing"], { strict: true })).rejects.toThrow(/missing/);
  await expect(loadExtensions(dir, ["missing"])).resolves.toBeUndefined();
});

it("strict loading propagates activation errors and invalid exports without loading unselected extensions", async () => {
  const dir = directory();
  fs.writeFileSync(path.join(dir, "good.mjs"), "export default function () {}\n");
  fs.writeFileSync(path.join(dir, "broken.mjs"), "export default function () { throw new Error('activation failed'); }\n");
  fs.writeFileSync(path.join(dir, "invalid.mjs"), "export default 42;\n");
  await expect(loadExtensions(dir, ["good"], { strict: true })).resolves.toBeUndefined();
  await expect(loadExtensions(dir, ["broken"], { strict: true })).rejects.toThrow(/activation failed/);
  await expect(loadExtensions(dir, ["invalid"], { strict: true })).rejects.toThrow(/default export/);
  vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(loadExtensions(dir, ["broken"])).resolves.toBeUndefined();
});
