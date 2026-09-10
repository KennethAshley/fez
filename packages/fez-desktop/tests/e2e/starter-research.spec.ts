import { test, expect } from "@playwright/test";
import { createServer } from "node:net";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { installMockBridge } from "./helpers/bridge";
import { spawnRelay } from "./helpers/relay";
import { BrowserWire } from "../../src/wire";
import { WELCOME_CHANNEL_ID } from "../../src/welcome-core";

test("welcome research: setup, consent, handoff and sourced answer stay in one thread", async ({ page }) => {
  test.setTimeout(90_000);
  const keys = Object.fromEntries(["default", "agent:fez", "agent:drift", "agent:quill"].map((name) => [name, generateSecretKey()]));
  const identities = Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, Buffer.from(key).toString("hex")]));
  const owner = getPublicKey(keys.default);
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const relay = await spawnRelay(port, { owner });
  const ownerWire = new BrowserWire([relay.url], identities.default);
  const driftWire = new BrowserWire([relay.url], identities["agent:drift"]);
  const quillWire = new BrowserWire([relay.url], identities["agent:quill"]);
  let authed = false;
  let installed = false;
  let restartFails = true;
  let spawnDeferred = true;
  let running = true;
  let replacement = false;
  const original = "---\nharness: pi\nprovider: local\nmodel: test\nmcpServers: [wallet]\ncustom: keep-me\n---\nResearch carefully.\n";
  let drift = original;
  const base = "---\nharness: pi\nprovider: local\nmodel: test\n---\n";
  try {
    await installMockBridge(page, {
      get_pubkey: () => owner,
      list_personas: () => ["fez", "drift", "quill"],
      read_persona: () => base,
      ensure_local_relay: () => relay.url,
      list_installed_skills: () => "[]",
      read_keymap: () => "{}",
      read_media_server: () => "",
      list_gui_extensions: () => [],
      spawned_agents: () => [],
    }, { identities });
    const nativeCommands = ["get_pubkey", "nip44_decrypt", "provider_key_present", "read_persona", "read_skills", "list_local_extensions", "read_extension_grants", "read_extension_versions", "install_package", "update_persona", "agent_alive", "kill_agent", "spawned_agents", "spawn_agent"];
    await page.exposeFunction("researchNative", async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "nip44_decrypt") return ownerWire.decrypt(String(args.peer), String(args.ciphertext));
      if (cmd === "get_pubkey") return getPublicKey(keys[String(args.account ?? "default")]);
      if (cmd === "provider_key_present") return authed && args.provider === "gm";
      if (cmd === "read_persona") return args.name === "drift" ? drift : base;
      if (cmd === "read_skills") return JSON.stringify(installed ? { web: { command: "node", args: ["/web/mcp.js"], package: "@fezchat/web" } } : {});
      if (cmd === "list_local_extensions") return installed ? [["web", ["skill"]]] : [];
      if (cmd === "read_extension_grants") return JSON.stringify(installed ? { web: ["network:*"] } : {});
      if (cmd === "read_extension_versions") return JSON.stringify(installed ? { web: "0.1.0" } : {});
      if (cmd === "install_package") { expect(args.name).toBe("@fezchat/web"); installed = true; return "installed"; }
      if (cmd === "update_persona") { expect(args.name).toBe("drift"); drift = String(args.content); return null; }
      if (cmd === "spawned_agents") return running ? [{ persona: "drift", channels: [WELCOME_CHANNEL_ID, "bootstrap-general"], ...(replacement ? {} : { repo: "demo-repo", line: "main" }) }] : [];
      if (cmd === "agent_alive") return running;
      if (cmd === "kill_agent") { expect(args.bin).toBe("fez-agent"); if (restartFails) return false; running = false; return true; }
      if (cmd === "spawn_agent") {
        expect(args.channels).toEqual([WELCOME_CHANNEL_ID, "bootstrap-general"]);
        expect(args.repo).toBe("demo-repo"); expect(args.baseBranch).toBe("main");
        if (spawnDeferred) return 0;
        running = true; return 123;
      }
      throw new Error(`Unexpected native command ${cmd}`);
    });
    await page.addInitScript(({ nativeCommands, url }) => {
      localStorage.setItem("fez-relay", url);
      const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }; researchNative: (cmd: string, args: unknown) => Promise<unknown> };
      const originalInvoke = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = (cmd, args) => nativeCommands.includes(cmd) ? w.researchNative(cmd, args ?? {}) : originalInvoke(cmd, args);
    }, { nativeCommands, url: relay.url });
    await page.goto("/");
    const card = page.getByRole("region", { name: "Try your team" });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.getByLabel("What would you like to understand?").fill("Local and cloud AI");
    await expect(card.getByRole("button", { name: "Start my brief" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Open Agents" })).toBeVisible();

    authed = true;
    await page.reload();
    await expect(card.getByLabel("What would you like to understand?")).toHaveValue("Local and cloud AI");
    await card.getByRole("button", { name: "review & install" }).click();
    expect(installed).toBe(false);
    expect(drift).toBe(original);
    await card.getByRole("button", { name: "install & grant" }).click();
    await card.getByRole("button", { name: "Give Web to Drift" }).click();
    await expect(card.getByRole("alert")).toContainText("Drift couldn't be stopped");
    await expect(card.getByRole("button", { name: "Start my brief" })).toBeDisabled();
    restartFails = false;
    await card.getByRole("button", { name: "Restart Drift" }).click();
    await expect(card.getByRole("alert")).toContainText("background runner must restart Drift");
    await expect(card.getByRole("button", { name: "Start my brief" })).toBeDisabled();
    // Welcome may recreate Drift with default scope while a restart is pending.
    running = true; replacement = true;
    await page.reload();
    spawnDeferred = false;
    await card.getByRole("button", { name: "Restart Drift" }).click();
    await expect(card.getByRole("button", { name: "Start my brief" })).toBeEnabled();
    expect(drift).toContain("custom: keep-me");
    expect(drift).toContain("wallet");
    expect(drift).toContain("web=npm:@fezchat/web");
    await page.screenshot({ path: test.info().outputPath("research-ready.png"), fullPage: true });
    await card.getByRole("button", { name: "Start my brief" }).click();
    await expect(page.getByRole("button", { name: "← back to channel" })).toBeVisible();
    const requests = await ownerWire.query([{ kinds: [47103], authors: [owner], "#h": [WELCOME_CHANNEL_ID] }]);
    const roots = requests.filter((event) => event.content.startsWith("Research brief:"));
    expect(roots).toHaveLength(1);
    const root = roots[0].id;
    const trigger = requests.find((event) => event.content.startsWith("@drift Research this topic:"))!;
    expect(trigger.tags).toContainEqual(["e", root, "", "reply"]);
    for (const [wire, name] of [[driftWire, "drift"], [quillWire, "quill"]] as const) {
      await wire.publish({ kind: 47000, tags: [], content: JSON.stringify({ name, supportedTasks: [] }) });
    }

    // Native/model boundaries are simulated; signatures, relay transport,
    // encrypted activity, thread filtering and rendering are real.
    await driftWire.publish({ kind: 20004, tags: [["p", owner], ["agent", "drift"]], content: await driftWire.encrypt(owner, JSON.stringify({ type: "turn", status: "started", root })) });
    await driftWire.publish({ kind: 20004, tags: [["p", owner], ["agent", "drift"]], content: await driftWire.encrypt(owner, JSON.stringify({ type: "tool", title: "Reading three sources" })) });
    await expect(page.locator(".timeline .live-turn").filter({ hasText: "Reading three sources" })).toBeVisible();
    await quillWire.publish({ kind: 20004, tags: [["p", owner], ["agent", "quill"]], content: await quillWire.encrypt(owner, JSON.stringify({ type: "turn", status: "started", root: "a".repeat(64) })) });
    await quillWire.publish({ kind: 20004, tags: [["p", owner], ["agent", "quill"]], content: await quillWire.encrypt(owner, JSON.stringify({ type: "tool", title: "Unrelated work elsewhere" })) });
    await expect(page.locator(".timeline").getByText("Unrelated work elsewhere")).toHaveCount(0);

    const tags = [["h", WELCOME_CHANNEL_ID], ["e", root, "", "root"], ["e", trigger.id, "", "reply"]];
    await driftWire.publish({ kind: 20003, tags, content: "I found three relevant sources." });
    await expect(page.locator(".timeline .live-turn").filter({ hasText: "I found three relevant sources." })).toHaveCount(1);
    await expect(page.locator(".timeline .live-turn").filter({ hasText: "Reading three sources" })).toHaveCount(0);
    const handoff = await driftWire.publish({ kind: 47103, tags, content: "Verified findings with sources.\n\n@quill Please write the sourced brief here." });
    await driftWire.publish({ kind: 20004, tags: [["p", owner], ["agent", "drift"]], content: await driftWire.encrypt(owner, JSON.stringify({ type: "turn", status: "completed" })) });
    await quillWire.publish({ kind: 47103, tags: [["h", WELCOME_CHANNEL_ID], ["e", root, "", "root"], ["e", handoff.id, "", "reply"]], content: "Local models keep inference on your device. Cloud models use a remote service. [Source](https://example.com/verified-source)" });
    await expect(page.locator(".timeline").getByRole("link", { name: "Source", exact: true })).toHaveAttribute("href", "https://example.com/verified-source");
    await expect(page.locator(".timeline .live-turn").filter({ hasText: "drift" })).toHaveCount(0);
    await expect(card).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("research-thread.png"), fullPage: true });
  } finally {
    ownerWire.close(); driftWire.close(); quillWire.close(); relay.kill();
  }
});
