// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { FezClient, type Wire } from "../../fez-client/src/index.js";
import { handlePanelRequest } from "../../fez-desktop/src/IsolatedPanelLauncher";
import { createPageHost } from "../../fez-desktop/src/isolated-page-host";
import { parseGuiContributions, matchPageDocument } from "../../../src/extensions/gui-contributions";
import { isBoard } from "../../fez-kanban/src/board";

afterEach(() => { vi.unstubAllGlobals(); });

it("binds reads, saves and comments to the open document and rejects stale, read-only and closed writes", async () => {
  const save = vi.fn(), comment = vi.fn();
  let page = { content: "## Todo\n- [ ] Keep this", title: "Board", channelId: "one", slug: "board", versionId: "v1", editable: true, save, comment };
  let open = true;
  const host = createPageHost(() => open ? page : undefined);
  const read = await host({ op: "read_page", can_edit: true });
  expect(read).toMatchObject({ content: page.content, versionId: "v1", slug: "board", editable: true });
  expect(read).not.toHaveProperty("save");
  expect(await host({ op: "read_page", can_edit: false })).toMatchObject({ editable: false });
  await host({ op: "save_page", version: "v1", content: "new content" });
  expect(save).toHaveBeenCalledWith("new content", expect.any(Function));
  page = { ...page, versionId: "v2", content: "agent update" };
  await expect(host({ op: "save_page", version: "v1", content: "stale" })).rejects.toThrow(/changed/);
  await host({ op: "comment_page", version: "v2", text: "Assign", anchor: "agent update", mentions: ["fez"] });
  expect(comment).toHaveBeenCalledWith("Assign", "agent update", ["fez"], expect.any(Function));
  page = { ...page, editable: false };
  await expect(host({ op: "comment_page", version: "v2", text: "no", anchor: "", mentions: [] })).rejects.toThrow(/read.only/);
  open = false;
  await expect(host({ op: "read_page", can_edit: true })).rejects.toThrow(/closed/);
  expect(save).toHaveBeenCalledTimes(1);
});

it("refuses concurrent writes and propagates host save errors through the native reply", async () => {
  let finish!: () => void;
  const host = createPageHost(() => ({ content: "old", title: "Board", channelId: "one", versionId: "v1", editable: true,
    save: () => new Promise<void>(resolve => { finish = resolve; }), comment: async () => {} }));
  const first = host({ op: "save_page", version: "v1", content: "first" });
  await expect(host({ op: "save_page", version: "v1", content: "second" })).rejects.toThrow(/saving/);
  finish(); await first;
  const invoke = vi.fn(async (command: string) => {
    if (command === "isolated_panel_host_request") return { op: "save_page", version: "old", content: "stale" };
  });
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  await handlePanelRequest(new FezClient({ pubkey: "owner" } as Wire), 1, undefined, host);
  expect(invoke).toHaveBeenLastCalledWith("isolated_panel_reply", { id: 1, result: { Err: expect.stringContaining("changed") } }, undefined);
});

it.each(["closed", "changed", "revoked"])("rechecks a delayed save before publishing when %s", async reason => {
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const publish = vi.fn();
  let open = true, versionId = "v1", revoked = false;
  const host = createPageHost(() => open ? { content: "old", title: "Board", channelId: "one", versionId, editable: true,
    save: async (_content, beforePublish) => { await wait; await beforePublish?.(); publish(); }, comment: async () => {} } : undefined);
  const invoke = vi.fn(async (command: string) => {
    if (command === "isolated_panel_host_request") return { op: "save_page", version: "v1", content: "new" };
    if (command === "isolated_panel_validate_request" && revoked) throw Error("permission revoked");
  });
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  const pending = handlePanelRequest(new FezClient({ pubkey: "owner" } as Wire), 1, undefined, host);
  await Promise.resolve();
  if (reason === "closed") open = false;
  if (reason === "changed") versionId = "v2";
  if (reason === "revoked") revoked = true;
  finish(); await pending;
  expect(publish).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenLastCalledWith("isolated_panel_reply", { id: 1, result: { Err: expect.stringContaining(reason) } }, undefined);
});

it("refreshes agents only when the native read request grants access", async () => {
  const client = new FezClient({ pubkey: "owner" } as Wire);
  vi.spyOn(client, "agents").mockReturnValue(new Map([["worker", "fez"]]));
  let canReadAgents = false;
  const invoke = vi.fn(async (command: string) => command === "isolated_panel_host_request"
    ? { op: "read_page", can_edit: true, can_read_agents: canReadAgents } : undefined);
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  const host = createPageHost(() => ({ content: "", title: "Board", channelId: "one", versionId: "v1", editable: true, save: async () => {}, comment: async () => {} }));
  await handlePanelRequest(client, 1, undefined, host);
  expect(invoke).toHaveBeenLastCalledWith("isolated_panel_reply", { id: 1, result: { Ok: expect.objectContaining({ agents: null }) } }, undefined);
  canReadAgents = true;
  await handlePanelRequest(client, 2, undefined, host);
  expect(invoke).toHaveBeenLastCalledWith("isolated_panel_reply", { id: 2, result: { Ok: expect.objectContaining({ agents: [["worker", "fez"]] }) } }, undefined);
});

it("validates declarations without executable match rules, and agrees with Kanban detection", () => {
  const rule = { fence: "fez:board", checklistSections: 2 };
  for (const value of [{ page: { name: "Board", match: { regex: "(a+)+$" } } }, { page: { name: "Board", match: { ...rule, checklistSections: 0 } } },
    { page: { name: "Board", match: rule }, messages: [{ linePrefixes: [], label: "x", summary: "x", detailsLabel: "x" }] }]) {
    expect(() => parseGuiContributions(value)).toThrow();
  }
  for (const content of ["```fez:board\ndone: Done\n```", "# Prose\nNothing here", "## A\n- [ ] task\n## B\n", "```\n## A\n- [ ] task\n## B\n```", "~~~\n## A\n~~~\n## B\n- [ ] task", "## A\n- [ ] task"]) {
    expect(matchPageDocument(content, rule)).toBe(isBoard(content));
  }
});
