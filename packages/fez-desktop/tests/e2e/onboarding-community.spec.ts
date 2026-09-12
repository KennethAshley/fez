import { test, expect } from "@playwright/test";
import { installMockBridge } from "./helpers/bridge";

async function toCommunity(page) {
  await page.goto("/");
  await page.getByRole("button", { name: /get started/i }).click();
  await page.getByRole("button", { name: /explore first/i }).click();
}

test("join door accepts a fez-join code and returns to profile", async ({ page }) => {
  await installMockBridge(page);
  await toCommunity(page);
  await page.getByRole("button", { name: /join a community/i }).click();
  await page.getByPlaceholder(/fez-join/i).fill("fez-join:wss://relay.example#abc123-def");
  await page.getByRole("button", { name: /accept invite/i }).click();
  // InviteStep's onAccept routes straight to "profile" once an identity
  // already exists (Task 9 decision) — there is no relay-display step to
  // land on. The accepted relay shows up as an effect instead: it's
  // unshifted into the relay set and stashed as the pending-invite in
  // localStorage (read by App.tsx's boot to actually join it).
  await expect(page.getByText("Build your profile")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("fez-pending-invite")))
    .toBe("wss://relay.example");
});

test("join door accepts the MODERN invite — no #fragment, the shape ManagePane mints", async ({ page }) => {
  await installMockBridge(page);
  await toCommunity(page);
  await page.getByRole("button", { name: /join a community/i }).click();
  await page.getByPlaceholder(/fez-join/i).fill("fez-join:wss://relay.example");
  await page.getByRole("button", { name: /accept invite/i }).click();
  await expect(page.getByText("Build your profile")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("fez-pending-invite")))
    .toBe("wss://relay.example");
});

test("join door preserves the expected owner for the first workspace boot", async ({ page }) => {
  await installMockBridge(page, { workspace_owner_pin: () => "a".repeat(64) });
  await toCommunity(page);
  await page.evaluate(() => { (window as unknown as { isTauri: boolean }).isTauri = true; });
  await page.getByRole("button", { name: /join a community/i }).click();
  const code = `fez-join:wss://relay.example#owner=${"a".repeat(64)}`;
  await page.getByPlaceholder(/fez-join/i).fill(code);
  await page.getByRole("button", { name: /accept invite/i }).click();
  await expect(page.getByText("Build your profile")).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("fez-pending-invite"))).toBe(code);
});

test("join door rejects a fez-join code whose body is not a relay URL", async ({ page }) => {
  // fez-join:hello#abc used to parse, poisoning the relay set into the
  // "reconnecting…" strand — the body must be a wss:// URL.
  await installMockBridge(page);
  await toCommunity(page);
  await page.getByRole("button", { name: /join a community/i }).click();
  await page.getByPlaceholder(/fez-join/i).fill("fez-join:hello#abc123-def");
  await page.getByRole("button", { name: /accept invite/i }).click();
  await expect(page.getByText(/doesn't name a relay/i)).toBeVisible();
});

test("join door rejects garbage with the honest error", async ({ page }) => {
  await installMockBridge(page);
  await toCommunity(page);
  await page.getByRole("button", { name: /join a community/i }).click();
  await page.getByPlaceholder(/fez-join/i).fill("not-an-invite");
  await page.getByRole("button", { name: /accept invite/i }).click();
  await expect(page.getByText(/doesn't look like an invite/i)).toBeVisible();
});

test("reconnect door adds a relay and continues to profile", async ({ page }) => {
  await installMockBridge(page);
  await toCommunity(page);
  await page.getByRole("button", { name: /reconnect an existing workspace/i }).click();
  await page.getByPlaceholder(/wss:\/\//).fill("wss://team.example");
  await page.getByRole("button", { name: /^add$/i }).click();
  await expect(page.getByText("✓ wss://team.example")).toBeVisible();
  await page.getByRole("button", { name: /continue/i }).click();
  await expect(page.getByText("Build your profile")).toBeVisible();
});

test("create door claims the local relay then reaches profile", async ({ page }) => {
  const bridge = await installMockBridge(page);
  await toCommunity(page);
  await page.getByRole("button", { name: /start a workspace for me/i }).click();
  await expect(page.getByText("Build your profile")).toBeVisible();
  expect(bridge.calls.some((c) => c.cmd === "ensure_local_relay")).toBe(true);
});

test("avatar over 256KB is refused with the sprite consolation", async ({ page }) => {
  await installMockBridge(page);
  await toCommunity(page);
  await page.getByRole("button", { name: /start a workspace for me/i }).click();
  const big = Buffer.alloc(300 * 1024, 7);
  await page.locator('input[type="file"]').setInputFiles({ name: "big.png", mimeType: "image/png", buffer: big });
  await expect(page.getByText(/over 256KB/i)).toBeVisible();
});

test("accepted owner is durable before onboarding exposes the relay to the sentinel", async ({ page }) => {
  const bridge = await installMockBridge(page);
  await toCommunity(page);
  await page.getByRole("button", { name: /join a community/i }).click();
  const before = await page.evaluate(() => localStorage.getItem("fez-relay"));
  await page.evaluate(() => {
    const host = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: { value?: string }) => Promise<unknown> };
      __releaseOwnerPin?: () => void;
      isTauri: boolean;
    };
    host.isTauri = true;
    const invoke = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd !== "workspace_owner_pin") return invoke(cmd, args);
      if (!args?.value) return Promise.resolve(null);
      return new Promise(resolve => { host.__releaseOwnerPin = () => resolve(args.value); });
    };
  });
  const code = `fez-join:wss://relay.example#owner=${"a".repeat(64)}`;
  await page.getByPlaceholder(/fez-join/i).fill(code);
  await page.getByRole("button", { name: /accept invite/i }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __releaseOwnerPin?: unknown }).__releaseOwnerPin)).toBe("function");
  expect(await page.evaluate(() => localStorage.getItem("fez-relay"))).toBe(before);
  expect(bridge.calls.some(call => call.cmd === "write_relays" && JSON.stringify(call.args).includes("relay.example"))).toBe(false);
  await page.evaluate(() => (window as unknown as { __releaseOwnerPin: () => void }).__releaseOwnerPin());
  await expect(page.getByText("Build your profile")).toBeVisible();
  await expect.poll(() => bridge.calls.some(call => call.cmd === "write_relays" && JSON.stringify(call.args).includes("relay.example"))).toBe(true);
});

test("native invitation pin failure preserves the current relay and the pasted invite", async ({ page }) => {
  await installMockBridge(page, { workspace_owner_pin: () => { throw "workspace trust unavailable"; } });
  await toCommunity(page);
  await page.evaluate(() => { (window as unknown as { isTauri: boolean }).isTauri = true; });
  await page.getByRole("button", { name: /join a community/i }).click();
  const before = await page.evaluate(() => localStorage.getItem("fez-relay"));
  const code = `fez-join:wss://relay.example#owner=${"a".repeat(64)}`;
  await page.getByPlaceholder(/fez-join/i).fill(code);
  await page.getByRole("button", { name: /accept invite/i }).click();
  await expect(page.getByText("workspace trust unavailable")).toBeVisible();
  await expect(page.getByPlaceholder(/fez-join/i)).toHaveValue(code);
  expect(await page.evaluate(() => localStorage.getItem("fez-relay"))).toBe(before);
  expect(await page.evaluate(() => localStorage.getItem("fez-pending-invite"))).toBeNull();
});

test("onboarding rejects an invitation conflicting with the existing client pin", async ({ page }) => {
  await installMockBridge(page);
  await toCommunity(page);
  await page.evaluate(owner => localStorage.setItem("fez-state", JSON.stringify({ workspaces: [{ relay: "wss://relay.example", owner }] })), "b".repeat(64));
  await page.getByRole("button", { name: /join a community/i }).click();
  const before = await page.evaluate(() => localStorage.getItem("fez-relay"));
  const code = `fez-join:wss://relay.example#owner=${"a".repeat(64)}`;
  await page.getByPlaceholder(/fez-join/i).fill(code);
  await page.getByRole("button", { name: /accept invite/i }).click();
  await expect(page.getByText(/workspace owner mismatch/i)).toBeVisible();
  await expect(page.getByPlaceholder(/fez-join/i)).toHaveValue(code);
  expect(await page.evaluate(() => localStorage.getItem("fez-relay"))).toBe(before);
});
