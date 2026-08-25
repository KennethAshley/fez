import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scaffold } from "../../../src/extensions/scaffold.js";
import { FEZ_VERSION } from "../../../src/extensions/host-compat.js";

/**
 * A scaffolded package carries the compat contract from birth: the
 * fez that generated it is the oldest fez it promises to work on.
 */
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "fez-scaffold-compat-"));

afterAll(() => fs.rmSync(WORK, { recursive: true, force: true }));

describe("scaffold compat stamp", () => {
  it("stamps minFezVersion with the generating host's version", () => {
    const dir = path.join(WORK, "stamped");
    scaffold({ name: "stamped", dir, surfaces: ["headless"], apiVersion: "^0.1.0" });
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
    expect(pkg.fez.minFezVersion).toBe(FEZ_VERSION);
  });
});
