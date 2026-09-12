// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FezClient, type Wire } from "../../fez-client/src/index.js";
import { registerIsolatedContributions } from "../../fez-desktop/src/IsolatedContributions";
import { messageDecorators } from "../../fez-desktop/src/gui-extensions";

const require = createRequire(resolve(__dirname, "../../fez-desktop/package.json"));
const React = require("react"), { createRoot } = require("react-dom/client");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const code = readFileSync(resolve(__dirname, "../../fez-kanban/dist/gui.js"), "utf8");
const activate = new Function(`${code}; return __fezExt.default;`)();
const worker = "b".repeat(64);

it.each([true, false])("requests host-owned card details and reports a denial without changing the board (editable=%s)", async editable => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let render!: (props: unknown) => unknown;
  const save = vi.fn();
  const showDetails = vi.fn(async () => {});
  activate({ React, showDetails, client: { pkByName: () => undefined },
    registerPageView: (_name: string, _match: unknown, view: typeof render) => { render = view; }, registerBlockRenderer: () => {}, registerMessageDecorator: () => {},
  });
  try {
    await React.act(async () => root.render(render({ channelId: "work", title: "Fez work", editable,
      content: '## Backlog\n\n- [ ] Make relay-watch tests hermetic\n  Pass envRelay:"" so ambient FEZ_RELAY cannot disable the watcher.\n\n## Review\n', save, comment: async () => {} })));
    const card = host.querySelector(".board-card")!;
    const open = card.querySelector("button") ?? card;
    await React.act(async () => (open as HTMLElement).click());
    expect(showDetails).toHaveBeenCalledWith({
      title: "Make relay-watch tests hermetic",
      body: 'Pass envRelay:"" so ambient FEZ_RELAY cannot disable the watcher.',
      context: "Backlog",
    });
    expect(host.querySelector("dialog")).toBeNull();
    showDetails.mockRejectedValueOnce(Error("extension requires ui permission"));
    await React.act(async () => (open as HTMLElement).click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("ui permission");
    expect(save).not.toHaveBeenCalled();
  } finally {
    await React.act(async () => root.unmount()); host.remove();
  }
});

it("shows existing scheduled reviews as a compact summary with the full instructions available", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../fez-kanban/package.json"), "utf8"));
  registerIsolatedContributions("kanban", new FezClient({ pubkey: "owner" } as Wire), manifest.fez.guiContributions);
  const decorators = messageDecorators();
  const content = "Daily Kanban review: Fez work\nBoard page slug: fez-work\nChannel ID: work\n\nReview the open issues and prepare one tested fix.\n\nThis standing job is already authorized. Do not merge or deploy.";
  try {
    const decorator = decorators.find(d => d.match(content));
    expect(decorator, "review should replace the wall of instructions").toBeDefined();
    expect(decorator!.replaceBody).toBe(true);
    expect(decorator!.match("An ordinary message about a daily review")).toBe(false);
    await React.act(async () => root.render(decorator!.render({ content, msgId: "m", channelId: "work", authorName: "You" })));
    const details = host.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(details!.textContent).toContain("Do not merge or deploy.");
    expect(host.querySelector("summary")?.textContent).toContain("instructions");
    const collapsed = host.cloneNode(true) as HTMLElement;
    collapsed.querySelector("details")!.remove();
    expect(collapsed.textContent).toContain("Fez work");
    expect(collapsed.textContent).toContain("Scheduled");
    expect(collapsed.textContent).not.toContain("Channel ID:");
  } finally { await React.act(async () => root.unmount()); host.remove(); }
});

it("saves the daily schedule, pauses/resumes, and removes it without touching another board", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let render: (props: unknown) => unknown;
  const other = { channelId: "other", slug: "other-board", title: "Other board", worker, time: "10:00", timeZone: "UTC", prompt: "Review", enabled: false, enabledAt: 1 };
  let config: { reviews: typeof other[] } = { reviews: [other] };
  const save = vi.fn(async (_name: string, value: typeof config) => { config = value; });
  activate({ React,
    client: { extensionConfig: async () => config, saveExtensionConfig: save, agents: () => new Map([[worker, "fez"]]), pkByName: () => worker },
    registerPageView: (_name: string, _match: unknown, view: typeof render) => { render = view; }, registerBlockRenderer: () => {}, registerMessageDecorator: () => {},
  });
  const click = async (label: string) => {
    const button = [...host.querySelectorAll("button")].find(b => b.textContent === label);
    expect(button, label).toBeDefined();
    await React.act(async () => button!.click());
  };
  try {
    await React.act(async () => root.render(render({ channelId: "work", slug: "fez-work", title: "Fez work", editable: true, content: "## Backlog\n\n## In Progress\n\n## Review\n\n## Done\n", save: async () => {}, comment: async () => {} })));
    await click("Schedule review");
    const timeZone = host.querySelector('input[type="text"]') as HTMLInputElement;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(timeZone, "America/New_York");
      timeZone.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Save schedule");
    expect(config.reviews[0]).toEqual(other);
    expect(config.reviews[1]).toMatchObject({ channelId: "work", slug: "fez-work", worker, time: "09:00", timeZone: "America/New_York", enabled: true });
    expect(host.textContent).toContain("Scheduled");
    expect(host.textContent).toContain("9:00 AM · Eastern Time · @fez");
    save.mockRejectedValueOnce(Error("relay offline"));
    await click("Pause");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("relay offline");
    expect(config.reviews[1].enabled).toBe(true);
    await click("Pause"); expect(config.reviews[1].enabled).toBe(false);
    await click("Resume"); expect(config.reviews[1].enabled).toBe(true);
    await click("Edit schedule"); await click("Remove schedule");
    expect(config.reviews).toEqual([other]);
  } finally { await React.act(async () => root.unmount()); host.remove(); }
});
