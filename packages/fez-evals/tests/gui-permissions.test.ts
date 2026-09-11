// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { FezClient, type Wire } from "../../fez-client/src/index.js";
import { handlePanelRequest } from "../../fez-desktop/src/IsolatedPanelLauncher";
import { extensionSettingsPanels, guiExtensionStatus, loadGuiExtensions, reloadGuiExtensions, messageDecorators, pageViewsFor, type GuiExtensionApi, type PageViewProps } from "../../fez-desktop/src/gui-extensions";

vi.mock("../../fez-desktop/src/artifact-viewers", () => ({ registerArtifactViewer: vi.fn(), snapshotArtifactViewers: () => () => {} }));
vi.mock("../../fez-desktop/src/notify", () => ({ notifyEvent: vi.fn() }));
vi.mock("../../fez-desktop/src/toast", () => ({ toast: { info: vi.fn() } }));
vi.mock("../../fez-desktop/src/invite-persona", () => ({ invitePersona: vi.fn() }));

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it.each([true, false])("never evaluates the isolated bundle in main; launcher requires ui (granted: %s)", async (hasUi) => {
  const probe = vi.fn();
  vi.stubGlobal("__isolatedProbe", probe);
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke: async (command: string) => {
    if (command === "list_gui_extensions") return [["elevenlabs", "globalThis.__isolatedProbe(); var __fezExt = {default(){}};", "body { color: magenta; }", null, "isolated-settings"]];
    if (command === "read_extension_grants") return JSON.stringify({ elevenlabs: hasUi ? ["ui"] : [] });
    throw new Error(command);
  } });
  const client = new FezClient({ pubkey: "owner" } as Wire);
  expect(await reloadGuiExtensions(client)).toEqual(hasUi ? ["elevenlabs"] : []);
  expect(probe).not.toHaveBeenCalled();
  expect(extensionSettingsPanels().some((panel) => panel.name === "elevenlabs")).toBe(hasUi);
  expect(extensionSettingsPanels().find(panel => panel.name === "elevenlabs")?.source).toBeUndefined();
  expect([...document.querySelectorAll("style")].some((style) => style.textContent?.includes("magenta"))).toBe(false);
});

it("isolates declared extensions and leaves legacy GUI parts running normally", async () => {
  const activated: string[] = [];
  vi.stubGlobal("__selectedProbe", (name: string) => activated.push(name));
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke: async (command: string) => {
    if (command === "list_gui_extensions") return ["elevenlabs", "notes", "regular"].map((name) => [
      name, `var __fezExt = {default() { globalThis.__selectedProbe(${JSON.stringify(name)}); }};`, "", null,
      name === "regular" ? null : "isolated-settings",
    ]);
    if (command === "read_extension_grants") return JSON.stringify({ elevenlabs: ["ui"], notes: ["ui"], regular: ["ui"] });
    throw new Error(command);
  } });
  const client = new FezClient({ pubkey: "owner" } as Wire);
  expect(await reloadGuiExtensions(client)).toEqual(["elevenlabs", "notes", "regular"]);
  expect(activated).toEqual(["regular"]);
  expect(extensionSettingsPanels().map((panel) => panel.name)).toEqual(["elevenlabs", "notes"]);
});

it.each(["isolated-setings", "", "invalid", 7, {}])("refuses an unknown GUI runtime %j without executing the bundle", async runtime => {
  const probe = vi.fn();
  vi.stubGlobal("__runtimeProbe", probe);
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke: async (command: string) => {
    if (command === "list_gui_extensions") return [["future", "globalThis.__runtimeProbe(); var __fezExt = {default(){}};", "", null, runtime]];
    if (command === "read_extension_grants") return JSON.stringify({ future: ["ui"] });
    throw new Error(command);
  } });
  expect(await reloadGuiExtensions(new FezClient({ pubkey: "owner" } as Wire))).toEqual([]);
  expect(probe).not.toHaveBeenCalled();
  expect(guiExtensionStatus()).toContainEqual(expect.objectContaining({ name: "future", ok: false, error: expect.stringContaining("Unsupported GUI runtime") }));
});

async function load(grants: string[], { code = "globalThis.__guiProbe(api)", bundle = "", prepare, name = "probe" }: {
  code?: string; bundle?: string; name?: string; prepare?: (client: FezClient, wire: Wire) => void;
} = {}) {
  const wire: Wire = {
    pubkey: "owner",
    publish: vi.fn(async (event) => ({ ...event, id: "published", pubkey: "owner", created_at: 1, sig: "sig" })),
    query: vi.fn(async () => []), subscribe: () => () => {},
    encrypt: vi.fn(async () => "encrypted"), decrypt: vi.fn(async () => "decrypted"),
    sendDm: vi.fn(async () => "dm"), unwrapDm: () => undefined,
    httpAuth: vi.fn(async () => "Nostr header"),
  };
  const client = new FezClient(wire);
  client.state.workspace.owner = "owner";
  client.state.workspace.channels.set("channel", { id: "channel", name: "general", createdAt: 1 });
  client.state.workspace.members.set("owner", "owner");
  client.state.scope = { channelId: "channel" };
  prepare?.(client, wire);
  let api: GuiExtensionApi | undefined;
  vi.stubGlobal("__guiProbe", (value: GuiExtensionApi) => { api = value; });
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke: async (command: string) => {
    if (command === "list_gui_extensions") return [[name, bundle || `var __fezExt = { default(api) { ${code} } };`, ""]];
    if (command === "read_extension_grants") return JSON.stringify({ [name]: grants });
    if (command === "has_skill_secret") return true;
    throw new Error(`Unexpected native call: ${command}`);
  } });
  expect(await loadGuiExtensions(client)).toEqual([name]);
  expect(api).toBeDefined();
  return { api: api!, client, wire };
}

function probeBundle(packageName: string): string {
  return readFileSync(resolve(__dirname, `../../${packageName}/dist/gui.js`), "utf8") +
    ";const originalActivate = __fezExt.default; __fezExt = { default: api => { globalThis.__guiProbe(api); originalActivate(api); } };";
}

it("withholds optional capabilities when their grants are absent", async () => {
  const { api } = await load([]);
  expect(api.client).toBeUndefined();
  expect(api.notify).toBeUndefined();
  expect(api.toast).toBeUndefined();
  expect(api.agents).toBeUndefined();
});

it("a read-only extension cannot publish, sign, decrypt config, or reach the raw client", async () => {
  const { api, client, wire } = await load(["read:channels"]);
  expect(api.client).not.toBe(client);
  for (const key of ["wire", "emit", "setScope", "dmConversations", "saveExtensionConfigForSomeoneElse"]) {
    expect(Reflect.get(api.client!, key)).toBeUndefined();
  }
  await expect(api.client!.publishDoc("channel", "unauthorized")).rejects.toThrow(/probe.*publish/);
  await expect(api.client!.ensureChannel({ name: "new" })).rejects.toThrow(/probe.*publish/);
  await expect(api.client!.createChannel("new")).rejects.toThrow(/probe.*publish/);
  await expect(api.client!.sendChannelMessage("unauthorized")).rejects.toThrow(/probe.*publish/);
  await expect(api.client!.toggleReaction("channel", "message", "✅")).rejects.toThrow(/probe.*publish/);
  await expect(api.client!.publishArtifact("channel", { type: "html", content: "html" })).rejects.toThrow(/probe.*publish/);
  await expect(api.client!.publishDocComment("channel", "comment")).rejects.toThrow(/probe.*publish/);
  await expect(api.client!.httpAuthHeader("https://relay.test", "GET")).rejects.toThrow(/probe.*sign/);
  await expect(api.client!.extensionConfig("probe")).rejects.toThrow(/probe.*sign/);
  await expect(api.client!.saveExtensionConfig("probe", {})).rejects.toThrow(/probe.*publish/);
  await expect(api.client!.decryptFrom("peer", "cipher")).rejects.toThrow(/probe.*sign/);
  expect(wire.publish).not.toHaveBeenCalled();
  expect(wire.httpAuth).not.toHaveBeenCalled();
  expect(wire.query).not.toHaveBeenCalled();
  expect(wire.decrypt).not.toHaveBeenCalled();
});

it("read results are snapshots, and agent data and unsupported events stay gated", async () => {
  const { api, client } = await load(["read:channels"]);
  const snapshot = api.client!.state;
  snapshot.workspace.channels.clear();
  snapshot.workspace.members.clear();
  expect(client.state.workspace.channels.size).toBe(1);
  expect(client.state.workspace.members.size).toBe(1);
  expect(Reflect.get(snapshot, "absorb")).toBeUndefined();
  // Method snapshots are tested with a live result as well as state maps.
  const docs = client.docsByChannel();
  expect(api.client!.docsByChannel()).not.toBe(docs);
  expect(() => api.client!.agents()).toThrow(/read:agents/);
  expect(() => api.client!.workingAgents()).toThrow(/read:agents/);
  const on = api.client!.on as (event: string, handler: () => void) => () => void;
  expect(() => on("dmMessage", () => {})).toThrow(/dmMessage/);
  const stop = api.client!.on("channelsChanged", () => {});
  expect(stop).toBeTypeOf("function");
  stop();
});

it("granted agent reads and encrypted config preserve the requested config namespace", async () => {
  const { api, client, wire } = await load(["read:channels", "read:agents", "sign", "publish"]);
  expect(api.client!.agents()).toEqual(client.agents());
  expect(api.client!.workingAgents()).toEqual(client.workingAgents());
  await api.client!.extensionConfig("fez-github");
  expect(wire.query).toHaveBeenCalledOnce();
  expect(wire.query).toHaveBeenCalledWith([{ kinds: [30078], authors: ["owner"], "#d": ["ext:fez-github"], limit: 5 }]);
  await api.client!.saveExtensionConfig("fez-github", { setting: true });
  expect(wire.encrypt).toHaveBeenCalledWith("owner", JSON.stringify({ setting: true }));
  expect(wire.publish).toHaveBeenCalledOnce();
});

it("Loom exports request the grant needed for workflow queries", async () => {
  const { exportFiles } = await import("../../fez-loom/src/export.js");
  const files = exportFiles({ id: "tool", title: "Workflows", type: "html", content: "tool", ts: 1 });
  const grants: string[] = JSON.parse(files.pkgJson).fez.permissions;
  const { api } = await load(grants, { prepare: client => {
    vi.spyOn(client, "workflowRuns").mockReturnValue(new Map([["run", { workflow: "Build", status: "done", ts: 1 }]]));
  } });
  expect(await api.client!.runQuery(api.parseQuery("runs"))).toMatchObject([{ id: "run", title: "Build" }]);
  const restricted = await load(grants.filter(p => p !== "read:agents"));
  await expect(restricted.api.client!.runQuery(api.parseQuery("runs"))).rejects.toThrow(/read:agents/);
});

it("the shipped Polls GUI renders against the current roster, excluding banned voters", async () => {
  await load(["read:channels", "ui"], { bundle: probeBundle("fez-polls"), prepare: client => {
    client.state.workspace.members.set("banned", "member");
    client.state.workspace.banned.set("banned", undefined);
    vi.spyOn(client, "reactions").mockReturnValue(new Map([["1️⃣", new Set(["owner", "banned"])]]));
  } });
  const { formatPoll } = await import("../../fez-polls/src/format.js");
  const content = formatPoll("Choose", ["One", "Two"], Date.now() + 100_000);
  const decorator = messageDecorators().find(d => d.match(content))!;
  const tree = JSON.stringify(decorator.render({ content, msgId: "message", channelId: "channel", authorName: "owner" }));
  expect(tree).toContain("1 vote");
  expect(tree).not.toContain("2 votes");
});

it("GitHub watch and triage buttons surface denied saves without changing their state", async () => {
  const { wire } = await load(["read:channels", "sign", "ui"], {
    name: "github", bundle: probeBundle("fez-github"),
    prepare: (_client, wire) => {
      vi.mocked(wire.query).mockResolvedValue([{ id: "config", pubkey: "owner", kind: 30078, tags: [], created_at: 1, sig: "sig", content: "cipher" }]);
      vi.mocked(wire.decrypt).mockResolvedValue(JSON.stringify({ repos: ["org/repo"], channelIds: { "org/repo": "channel" }, available: [{ repo: "org/repo", private: false }] }));
    },
  });
  const hostRequire = createRequire(resolve(__dirname, "../../fez-desktop/package.json"));
  const { act } = hostRequire("react");
  const { createRoot } = hostRequire("react-dom/client");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(extensionSettingsPanels().find(p => p.name === "github")!.render()));
    for (const label of ["Stop watching", "triage off"]) {
      const button = [...host.querySelectorAll("button")].find(b => b.textContent === label)!;
      expect(button).toBeDefined();
      await act(async () => button.click());
      expect(host.textContent).toMatch(/github.*publish/);
      expect(button.textContent).toBe(label);
    }
    expect(wire.publish).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it.each(["sign", "publish"])("%s authorizes signing without giving away the client", async (grant) => {
  const { api, client, wire } = await load(["read:channels", grant]);
  expect(api.client).not.toBe(client);
  expect(await api.client!.httpAuthHeader("https://relay.test", "GET")).toBe("Nostr header");
  if (grant === "publish") {
    await api.client!.publishDoc("channel", "allowed");
    expect(wire.publish).toHaveBeenCalledOnce();
  } else {
    await expect(api.client!.publishDoc("channel", "denied")).rejects.toThrow(/publish/);
    expect(wire.publish).not.toHaveBeenCalled();
  }
});

it.each([false, true])("page save/comment callbacks enforce publish (granted: %s)", async (publish) => {
  let props: PageViewProps | undefined;
  vi.stubGlobal("__pageProbe", (value: PageViewProps) => { props = value; });
  const name = `page-${publish}`;
  await load(["ui", ...(publish ? ["publish"] : [])], {
    code: `globalThis.__guiProbe(api); api.registerPageView('${name}', () => true, (props) => { globalThis.__pageProbe(props); });`,
  });
  const save = vi.fn(async () => {}), comment = vi.fn(async () => {});
  pageViewsFor("").views.find(v => v.name === name)!.render({
    content: "", title: "", channelId: "channel", editable: true, save, comment,
  });
  expect(props!.editable).toBe(publish);
  if (publish) {
    await props!.save("next");
    await props!.comment("hi", "anchor", []);
    expect(save).toHaveBeenCalledWith("next");
    expect(comment).toHaveBeenCalledWith("hi", "anchor", []);
  } else {
    await expect(props!.save("next")).rejects.toThrow(/publish/);
    await expect(props!.comment("hi", "anchor", [])).rejects.toThrow(/publish/);
    expect(save).not.toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
  }
});


it("the isolated main host uses FezClient config semantics and never reads a secret value", async () => {
  const { client, wire } = await load(["read:channels", "sign", "publish"]);
  const config = { repos: ["fixture/project"] };
  vi.mocked(wire.query).mockResolvedValue([{ id: "config", pubkey: "owner", kind: 30078, created_at: 1, tags: [], content: "cipher", sig: "sig" }]);
  vi.mocked(wire.decrypt).mockResolvedValue(JSON.stringify(config));
  const operations = [
    { op: "get_config", scope: "fez-github" },
    { op: "set_config", scope: "fez-github", value: config },
    { op: "has_secret", scope: "fez-github", key: "token" },
    { op: "set_secret", scope: "fez-github", key: "token", value: "test-token" },
    { op: "list_channels" },
    { op: "create_channel", name: "Engineering" },
  ];
  const calls: [string, Record<string, unknown>][] = [];
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke: async (command: string, args: Record<string, unknown>) => {
    calls.push([command, args]);
    if (command === "isolated_panel_host_request") return operations[Number(args.id)];
    if (command === "isolated_panel_reply" || command === "set_skill_secret") return null;
    if (command === "has_skill_secret") return true;
    throw new Error(`Unexpected host command: ${command}`);
  } });
  for (let id = 0; id < operations.length; id++) await handlePanelRequest(client, id);
  expect(wire.query).toHaveBeenCalledWith([{ kinds: [30078], authors: ["owner"], "#d": ["ext:fez-github"], limit: 5 }]);
  expect(wire.decrypt).toHaveBeenCalledWith("owner", "cipher");
  expect(wire.encrypt).toHaveBeenCalledWith("owner", JSON.stringify(config));
  expect(wire.publish).toHaveBeenCalledWith({ kind: 30078, tags: [["d", "ext:fez-github"]], content: "encrypted" });
  expect(calls).toContainEqual(["isolated_panel_reply", { id: 0, result: { Ok: { value: config } } }]);
  expect(calls).toContainEqual(["has_skill_secret", { skill: "fez-github", key: "token" }]);
  expect(calls).toContainEqual(["set_skill_secret", { skill: "fez-github", key: "token", value: "test-token" }]);
  expect(calls).toContainEqual(["isolated_panel_reply", { id: 4, result: { Ok: [{ id: "channel", name: "general", source: undefined, meta: undefined }] } }]);
  const created = client.state.findChannelByName("Engineering");
  expect(created).toBeDefined();
  expect(calls).toContainEqual(["isolated_panel_reply", { id: 5, result: { Ok: created!.id } }]);
  vi.mocked(wire.publish).mockRejectedValueOnce(new Error("relay write failed"));
  await handlePanelRequest(client, 1);
  expect(calls.at(-1)).toEqual(["isolated_panel_reply", { id: 1, result: { Err: "Error: relay write failed" } }]);
});


it.each(["github", "fez-github"])("isolated %s settings leave navigation to ordinary Fez channels", async (name) => {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../fez-github/package.json"), "utf8"));
  expect(manifest.fez.guiRuntime).toBe("isolated-settings");
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke: async (command: string) => {
    if (command === "list_gui_extensions") return [[name, "throw Error('must not evaluate in main')", "", manifest.fez.settingsSource, manifest.fez.guiRuntime]];
    if (command === "read_extension_grants") return JSON.stringify({ [name]: ["ui"] });
    throw new Error(command);
  } });
  expect(await reloadGuiExtensions(new FezClient({ pubkey: "owner" } as Wire))).toEqual([name]);
  expect(extensionSettingsPanels().find(panel => panel.name === name)?.source).toBeUndefined();
});

it("channel picking returns active snapshots and creating never retags a matching name", async () => {
  const { api, client, wire } = await load(["read:channels", "publish"]);
  client.state.workspace.channels.set("archived", { id: "archived", name: "old", createdAt: 1, archived: true });
  const channels = await api.client!.listChannels();
  expect(channels.map(channel => channel.id)).toEqual(["channel"]);
  channels[0].name = "changed snapshot";
  const id = await api.client!.createChannel("general");
  expect(id).not.toBe("channel");
  expect(client.state.workspace.channels.get("channel")?.name).toBe("general");
  expect(wire.publish).toHaveBeenCalledWith(expect.objectContaining({ kind: 47101, content: JSON.stringify({ name: "general", visibility: "open" }) }));
});


it("Wallet keeps its settings visible when an older install lacks read:agents", async () => {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../fez-wallet/package.json"), "utf8"));
  expect(manifest.fez.permissions).toContain("read:agents");
  const { api } = await load(["read:channels", "ui", "processes"], { name: "wallet", bundle: probeBundle("fez-wallet") });
  api.storage.get = async <T,>(key: string) => (key === "addresses" ? { treasury: "fixture-address", personas: {} } : undefined) as T | undefined;
  api.processes!.run = async () => ({ code: 0, stdout: "{}", stderr: "" });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network disabled in fixture"); }));
  const hostRequire = createRequire(resolve(__dirname, "../../fez-desktop/package.json"));
  const { act } = hostRequire("react");
  const { createRoot } = hostRequire("react-dom/client");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(extensionSettingsPanels().find(panel => panel.name === "wallet")!.render()));
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/wallet.*read:agents/);
    expect(host.textContent).toContain("treasury");
  } finally { await act(async () => root.unmount()); }
});
