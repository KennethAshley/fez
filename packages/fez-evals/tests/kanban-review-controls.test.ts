// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(resolve(__dirname, "../../fez-desktop/package.json"));
const React = require("react"), { createRoot } = require("react-dom/client");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const code = readFileSync(resolve(__dirname, "../../fez-kanban/dist/gui.js"), "utf8");
const activate = new Function(`${code}; return __fezExt.default;`)();
const worker = "b".repeat(64);

it("saves the daily schedule, pauses/resumes, and removes it without touching another board", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let render: (props: unknown) => unknown;
  const other = { channelId: "other", slug: "other-board", title: "Other board", worker, time: "10:00", timeZone: "UTC", prompt: "Review", enabled: false, enabledAt: 1 };
  let config: { reviews: typeof other[] } = { reviews: [other] };
  const save = vi.fn(async (_name: string, value: typeof config) => { config = value; });
  activate({ React,
    client: { extensionConfig: async () => config, saveExtensionConfig: save, agents: () => new Map([[worker, "fez"]]), pkByName: () => worker },
    registerPageView: (_name: string, _match: unknown, view: typeof render) => { render = view; }, registerBlockRenderer: () => {},
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
    expect(host.textContent).toContain("Daily review · 09:00 America/New_York");
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
