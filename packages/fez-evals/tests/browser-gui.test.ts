import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Element { type: unknown; props: Record<string, unknown>; children: unknown[] }
function panel(permissions = true, failSetup = false) {
  const code = readFileSync(new URL("../../fez-browser/dist/gui.js", import.meta.url), "utf8");
  let render: () => Element;
  let cursor = 0;
  const states: unknown[] = [];
  const calls: unknown[] = [];
  const h = (type: unknown, props: Record<string, unknown>, ...children: unknown[]): Element => ({ type, props: props ?? {}, children });
  const React = {
    createElement: h,
    useState: (initial: unknown) => {
      const slot = cursor++;
      if (states.length <= slot) states.push(initial);
      return [states[slot], (value: unknown) => { states[slot] = value; }];
    },
    // Startup polling is exercised by the browser walkthrough; these cases
    // target permission gating and the setup action's host boundary.
    useEffect: () => {},
  };
  const api = { React, registerSettingsPanel: (_name: string, callback: () => Element) => { render = callback; },
    ...(permissions ? {
      processes: { run: async () => ({ code: 0, stdout: JSON.stringify({ phase: "missing", message: "Set up the browser" }), stderr: "" }) },
      agents: { spawn: async (...args: unknown[]) => { calls.push(args); if (failSetup) throw new Error("Download unavailable"); return 123; }, isRunning: async () => true },
    } : {}),
  };
  new Function(`${code};return __fezExt`)().default(api);
  function draw(): Element { cursor = 0; const root = render(); return (root.type as () => Element)(); }
  function nodes(node: unknown): Element[] {
    if (!node || typeof node !== "object") return [];
    const el = node as Element;
    return [el, ...(el.children ?? []).flatMap(nodes)];
  }
  return { draw, nodes, calls };
}

describe("Browser settings panel", () => {
  it("explains a missing process grant instead of showing a setup button that cannot work", () => {
    const p = panel(false);
    const tree = p.draw();
    expect(JSON.stringify(tree)).toMatch(/permission|grant/i);
    expect(p.nodes(tree).filter(n => n.type === "button")).toHaveLength(0);
  });

  it("runs setup through the package-owned background program and shows failures", async () => {
    const p = panel(true, true);
    const button = p.nodes(p.draw()).find(n => n.type === "button" && n.children.includes("Set up browser"))!;
    expect(button).toBeDefined();
    await (button.props.onClick as () => Promise<void>)();
    expect(p.calls).toEqual([["fez-browser", { name: "fez-browser-setup", env: { FEZ_BROWSER_ACTION: "setup" } }]]);
    expect(JSON.stringify(p.draw())).toContain("Download unavailable");
  });
});
