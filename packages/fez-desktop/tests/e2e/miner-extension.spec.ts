import { test, expect } from "@playwright/test";
import { createServer } from "node:net";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { installMockBridge } from "./helpers/bridge";
import { spawnRelay } from "./helpers/relay";

test("miner-only adapters appear in installed extensions with removal controls", async ({ page }) => {
  const secret = generateSecretKey();
  const owner = getPublicKey(secret);
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as import("node:net").AddressInfo).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const relay = await spawnRelay(port, { owner });
  try {
    await installMockBridge(page, {
      get_pubkey: () => owner,
      provider_key_present: () => true,
      ensure_local_relay: () => relay.url,
      read_skills: () => "{}",
      list_local_extensions: () => [["numinous", ["miner"]]],
      read_extension_versions: () => '{"numinous":"0.1.0"}',
      read_extension_grants: () => "{}",
      list_installed_skills: () => "[]",
      list_gui_extensions: () => [],
    }, { identities: { default: Buffer.from(secret).toString("hex") } });
    await page.addInitScript(url => localStorage.setItem("fez-relay", url), relay.url);
    await page.goto("/");
    await page.locator(".self-wrap > button").click();
    await page.locator(".self-menu").getByRole("button", { name: /extensions/ }).click();
    await page.getByRole("button", { name: "installed1", exact: true }).click();
    const row = page.locator(".skill-row").filter({ hasText: /numinous/i });
    await expect(row).toBeVisible();
    await expect(row.getByTitle("remove from this machine")).toBeVisible();
    await expect(row.getByRole("button", { name: "give to…" })).toHaveCount(0);
  } finally {
    relay.kill();
  }
});
