import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * /repo means the same thing in every window.
 *
 * The command exists twice on purpose — the headless part serves the
 * TUI and sentinel, the gui part serves the desktop composer — and
 * that duplication already bit once: `branch` and `merge` were taught
 * to one and not the other, so in the desktop they silently fell
 * through to the repo list. Muscle memory should not depend on which
 * surface you typed into; this pins the VERB SETS equal so the next
 * one-sided addition fails here instead of in someone's afternoon.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.resolve(HERE, "../../fez-git/src", file), "utf-8");

const verbsOf = (source: string): string[] =>
  [...source.matchAll(/verb === "([a-z-]+)"/g)].map((m) => m[1]).sort();

describe("/repo verb parity across surfaces", () => {
  it("headless and gui accept exactly the same verbs", () => {
    const headless = verbsOf(read("headless.ts"));
    const gui = verbsOf(read("gui.tsx"));
    // If this fails: add the missing verb to the OTHER surface (or
    // deliberately remove it from both) — never ship it one-sided.
    expect(gui).toEqual(headless);
    // And the set itself is worth seeing when it changes.
    expect(headless.length).toBeGreaterThanOrEqual(4);
  });
});
