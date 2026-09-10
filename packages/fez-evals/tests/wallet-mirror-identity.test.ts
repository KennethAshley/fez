import { expect, test, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mirrorAddresses } from "../../fez-wallet/src/storage-mirror.js";

test("a fresh linked wallet writes the state read by the canonical wallet GUI", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wallet-identity-"));
  vi.stubEnv("FEZ_EXTENSION_DATA_DIR", dir);
  try {
    await mirrorAddresses({ treasury: "5Treasury" });
    expect(fs.readdirSync(dir)).toEqual(["wallet.json"]);
    const state = JSON.parse(fs.readFileSync(path.join(dir, "wallet.json"), "utf8"));
    expect(state.addresses.treasury).toBe("5Treasury");
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing legacy wallet keeps its data until the owner migrates that installation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wallet-identity-"));
  vi.stubEnv("FEZ_EXTENSION_DATA_DIR", dir);
  try {
    fs.writeFileSync(path.join(dir, "fez-wallet.json"), JSON.stringify({ prefs: { network: "test" } }));
    await mirrorAddresses({ treasury: "5Treasury" });
    expect(fs.readdirSync(dir)).toEqual(["fez-wallet.json"]);
    const state = JSON.parse(fs.readFileSync(path.join(dir, "fez-wallet.json"), "utf8"));
    expect(state.prefs.network).toBe("test");
    expect(state.addresses.treasury).toBe("5Treasury");
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
