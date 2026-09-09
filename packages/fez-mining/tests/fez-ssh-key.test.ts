import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureFezSshKey } from "../src/fez-ssh-key.js";

describe("fez ssh identity", () => {
  it("generates once, returns the same key after, public half is ed25519", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fez-sshkey-"));
    const a = await ensureFezSshKey(home);
    expect(a.publicKey).toMatch(/^ssh-ed25519 /);
    expect(fs.statSync(a.keyPath).mode & 0o777).toBe(0o600);
    const b = await ensureFezSshKey(home);
    expect(b.publicKey).toBe(a.publicKey);
  });
});
