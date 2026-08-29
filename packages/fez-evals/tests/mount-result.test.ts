import { describe, it, expect } from "vitest";
import { classifyMountResult } from "../../fez-desktop/src/mount-result.js";

describe("classifyMountResult", () => {
  it("a function is a disposer (mount form)", () => {
    const fn = () => {};
    expect(classifyMountResult(fn)).toEqual({ dispose: fn });
  });
  it("a React element is legacy content to render", () => {
    const el = { $$typeof: Symbol.for("react.element"), type: "div" };
    expect(classifyMountResult(el)).toEqual({ element: el });
  });
  it("void/undefined is neither", () => {
    expect(classifyMountResult(undefined)).toEqual({});
    expect(classifyMountResult(null)).toEqual({});
  });
  // A legacy `() => ReactNode` callback was always allowed to return a
  // string, number, array, or fragment — not just an element — so the
  // classifier must not silently drop them.
  it("a string is legacy content to render", () => {
    expect(classifyMountResult("hello")).toEqual({ element: "hello" });
  });
  it("a number is legacy content to render", () => {
    expect(classifyMountResult(0)).toEqual({ element: 0 });
  });
  it("an array of elements is legacy content to render", () => {
    const els = [{ $$typeof: Symbol.for("react.element"), type: "span" }];
    expect(classifyMountResult(els)).toEqual({ element: els });
  });
});
