// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { injectExtensionStyles } from "../src/gui-extensions.js";

afterEach(() => { document.head.querySelectorAll("style[data-fez-ext]").forEach((n) => n.remove()); });

describe("gui extension css injection", () => {
  it("injects a scoped style node and removes it on dispose", () => {
    const dispose = injectExtensionStyles("loom", ".loom-x{color:red}");
    const node = document.head.querySelector('style[data-fez-ext="loom"]');
    expect(node?.textContent).toContain(".loom-x");
    dispose();
    expect(document.head.querySelector('style[data-fez-ext="loom"]')).toBeNull();
  });
  it("replaces rather than duplicates for the same extension", () => {
    injectExtensionStyles("loom", ".a{}");
    injectExtensionStyles("loom", ".b{}");
    const nodes = document.head.querySelectorAll('style[data-fez-ext="loom"]');
    expect(nodes.length).toBe(1);
    expect(nodes[0].textContent).toContain(".b");
  });
});
