import { test, expect } from "@playwright/test";
import { createServer } from "node:net";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { RelayConnection } from "../../../../src/protocol/relay";
import { installMockBridge } from "./helpers/bridge";
import { spawnRelay } from "./helpers/relay";

test("keeps partial history visible and retries without losing or duplicating messages", async ({ page }) => {
  const secret = generateSecretKey(), owner = getPublicKey(secret);
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw Error("missing port");
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const relay = await spawnRelay(address.port, { owner });
  const connection = new RelayConnection({ url: relay.url });
  const publish = (kind: number, tags: string[][], content: string, created_at = Math.floor(Date.now() / 1000)) =>
    connection.publish(finalizeEvent({ kind, tags, content, created_at }, secret));
  let failHistory = true;
  try {
    await connection.connect();
    await publish(47102, [["d", "roster"], ["p", owner, "owner"]], "");
    await publish(47101, [["d", "general"]], JSON.stringify({ name: "general" }));
    for (let i = 1; i <= 40; i++) await publish(47103, [["h", "general"]], `History row ${i}`, Math.floor(Date.now() / 1000) - 50 + i);
    await installMockBridge(page, {
      get_pubkey: () => owner, provider_key_present: () => true, list_personas: () => ["fez", "quill"],
      ensure_local_relay: () => relay.url, list_installed_skills: () => "[]", read_keymap: () => "{}",
      read_media_server: () => "", latest_version: () => "0.1.0", package_info: () => "{}", spawned_agents: () => [],
    }, { identities: { default: Buffer.from(secret).toString("hex") } });
    await page.addInitScript(url => localStorage.setItem("fez-relay", url), relay.url);
    // The real relay supplies signed rows. Replace only completion of a
    // history request; live subscriptions and every other read stay real.
    await page.routeWebSocket(`${relay.url}/`, ws => {
      const server = ws.connectToServer();
      const failed = new Set<string>();
      ws.onMessage(data => {
        const frame = JSON.parse(String(data));
        if (failHistory && frame[0] === "REQ" && frame.slice(2).some((f: { kinds?: number[]; limit?: number }) => f.kinds?.includes(47103) && f.limit === 200)) failed.add(frame[1]);
        server.send(data);
      });
      server.onMessage(data => {
        const frame = JSON.parse(String(data));
        ws.send(frame[0] === "EOSE" && failed.delete(frame[1])
          ? JSON.stringify(["CLOSED", frame[1], "error: history unavailable"])
          : data);
      });
    });
    await page.goto("/");
    await expect(page.locator(".shell")).toBeVisible();
    await page.locator("button.channel").filter({ hasText: "general" }).first().click();
    const warning = page.locator('.history-status[role="alert"]');
    await expect(warning).toContainText("History is incomplete");
    await expect(warning.getByRole("button", { name: "Retry" })).toBeInViewport();
    await expect(page.locator(".timeline").getByText("History row 40", { exact: true })).toBeVisible();
    await expect(page.locator(".timeline").getByText(/^History row \d+$/, { exact: true })).toHaveCount(40);
    await page.screenshot({ path: "/tmp/fez-history-retry-desktop.png" });
    failHistory = false;
    await warning.getByRole("button", { name: "Retry" }).click();
    await expect(warning).toHaveCount(0);
    await expect(page.locator(".history-status")).toHaveCount(0);
    await expect(page.locator(".timeline").getByText(/^History row \d+$/, { exact: true })).toHaveCount(40);
  } finally {
    connection.disconnect();
    relay.kill();
  }
});
