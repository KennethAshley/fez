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
  it("a plain object that is not a React element is not treated as content", () => {
    expect(classifyMountResult({ foo: 1 })).toEqual({});
  });
});
