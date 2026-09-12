import { test, expect, type Page } from "@playwright/test";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";

const code = buildSync({
  entryPoints: [fileURLToPath(new URL("../../../fez-wallet/src/gui.tsx", import.meta.url))],
  bundle: true, format: "iife", globalName: "__fezExt", platform: "browser", jsx: "transform", jsxFactory: "h", write: false,
}).outputFiles[0]!.text;

async function loadWallet(page: Page) {
  await page.addInitScript(({ code }) => {
    // No fixture can connect to a chain, invoke a wallet process, or read real state.
    window.WebSocket = class { constructor() { throw Error("network disabled in wallet fixture"); } } as unknown as typeof WebSocket;
    window.fetch = async () => { throw Error("network disabled in wallet fixture"); };
    window.confirm = () => { throw Error("Wallet must use Fez confirmation"); };
    const prefs: Record<string, unknown> = {
      network: "test", thresholds: { default: "0.01", fixture: "0.07" },
      x402: { network: "base-sepolia", dailyCapUsd: 13, autoApproveUnderUsd: { default: 0.4, fixture: 0.2 }, marker: "keep" },
    };
    const storage: Record<string, unknown> = {};
    const requests: Record<string, unknown>[] = [];
    const state = { prefs, requests, storage, snapshotVersion: 0 };
    Object.assign(window, { walletProbe: state, __TAURI_INTERNALS__: { invoke: async (command: string, { request }: { request: Record<string, unknown> }) => {
      if (command !== "isolated_panel_request") throw Error("native commands disabled in wallet fixture");
      requests.push(request);
      if (request.op === "bootstrap") return { name: "wallet", code, styles: "", client: true, agents: [], custom: { kind: "settings" } };
      if (request.op === "get_preference") return { value: structuredClone(prefs[String(request.key)]) };
      if (request.op === "set_preference") { prefs[String(request.key)] = structuredClone(request.value); return null; }
      if (request.op === "confirm") return new Promise((resolve, reject) => {
        Object.assign(window, { resolveWalletConfirmation: resolve, rejectWalletConfirmation: () => reject(Error("ui permission revoked")) });
      });
      if (request.op === "custom") {
        const args = request.args as Record<string, unknown>;
        if (request.action === "snapshot") return {
          surface: { kind: "settings" }, grants: ["read:channels", "read:agents", "processes"],
          pubkey: "fixture-owner", owner: "fixture-owner", channels: [], workspaces: [], agents: [],
          names: [["fixture-owner", `Fixture ${state.snapshotVersion}`]], pubkeysByName: [], reactions: [], receipts: [],
        };
        if (request.action === "storage_get") return { value: structuredClone(storage[String(args.key)]) };
        if (request.action === "process_run" && args.bin === "fez-wallet" && JSON.stringify(args.args) === JSON.stringify(["init", "--json"])) {
          storage.addresses = { treasury: "fixture-treasury-address" };
          return { code: 0, stdout: JSON.stringify({ mnemonic: "FAKE BACKUP WORDS FOR UI FIXTURE ONLY", treasuryAddress: "fixture-treasury-address" }), stderr: "" };
        }
      }
      throw Error(`unexpected wallet fixture operation: ${JSON.stringify(request)}`);
    } } });
  }, { code });
  await page.goto("/isolated-panel.html");
  await expect(page.getByText("in force: $13 cap · auto-approve under $0.4 (0 = every spend asks you)")).toBeVisible();
}

for (const decision of ["accept", "cancel", "reject"] as const) {
  test(`Wallet mainnet ${decision} preserves the confirmation and existing policy`, async ({ page }) => {
    await loadWallet(page);
    const network = page.locator("select").filter({ has: page.locator('option[value="base"]') });
    await network.selectOption("base");
    await expect.poll(() => page.evaluate(() => Reflect.get(window, "walletProbe").requests.filter((request: { op: string }) => request.op === "confirm"))).toEqual([
      { op: "confirm", title: "Flip x402 payments to Base MAINNET?", body: "Agents will spend REAL USDC — auto-approving up to $0.4 per call, $13/day, without asking you.", context: null },
    ]);
    const writes = () => page.evaluate(() => Reflect.get(window, "walletProbe").requests.filter((request: { op: string }) => request.op === "set_preference"));
    expect(await writes()).toEqual([]);
    // A changing snapshot must preserve the in-flight confirmation ref and drafts.
    await page.evaluate(() => { Reflect.get(window, "walletProbe").snapshotVersion++; window.dispatchEvent(new Event("fez-custom-changed")); });
    await network.selectOption("base");
    expect(await page.evaluate(() => Reflect.get(window, "walletProbe").requests.filter((request: { op: string }) => request.op === "confirm").length)).toBe(1);
    await page.evaluate(decision => {
      if (decision === "reject") Reflect.get(window, "rejectWalletConfirmation")();
      else Reflect.get(window, "resolveWalletConfirmation")(decision === "accept");
    }, decision);
    if (decision === "accept") {
      await expect(network).toHaveValue("base");
      expect(await writes()).toEqual([{ op: "set_preference", key: "x402", value: {
        network: "base", dailyCapUsd: 13, autoApproveUnderUsd: { default: 0.4, fixture: 0.2 }, marker: "keep",
      } }]);
    } else {
      await expect(network).toHaveValue("base-sepolia");
      if (decision === "reject") await expect(page.getByText("✗ not saved: ui permission revoked")).toBeVisible();
      expect(await writes()).toEqual([]);
    }
    expect(await page.evaluate(() => Reflect.get(window, "walletProbe").requests.filter((request: { action?: string }) => request.action === "process_run"))).toEqual([]);
  });
}

test("Wallet keeps a fixture backup phrase visible across snapshots and clears it on acknowledgement", async ({ page }) => {
  await loadWallet(page);
  await page.getByRole("button", { name: "create this workspace's wallet", exact: true }).click();
  const phrase = page.getByText("FAKE BACKUP WORDS FOR UI FIXTURE ONLY", { exact: true });
  await expect(phrase).toBeVisible();
  await expect(page.getByRole("button", { name: "copy words", exact: true })).toBeVisible();
  await page.evaluate(() => { Reflect.get(window, "walletProbe").snapshotVersion++; window.dispatchEvent(new Event("fez-custom-changed")); });
  await expect(phrase).toBeVisible();
  await page.getByRole("button", { name: "I wrote them down", exact: true }).click();
  await expect(phrase).toHaveCount(0);
  await expect(page.getByText("treasury", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "walletProbe").requests.filter((request: { action?: string }) => request.action === "process_run"))).toEqual([
    { op: "custom", action: "process_run", args: { bin: "fez-wallet", args: ["init", "--json"] } },
  ]);
});
