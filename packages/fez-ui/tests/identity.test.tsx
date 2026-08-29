// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { createRoot } from "react-dom/client";
import { act, type ReactElement } from "react";
import { Avatar, generateSprite } from "../src/index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderInto(node: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return container;
}

const PK = "npub1exampleexampleexampleexampleexampleexampleexampleex";

describe("identity primitives", () => {
  it("generates a deterministic sprite for a pubkey", () => {
    expect(generateSprite(PK)).toEqual(generateSprite(PK));
  });

  it("Avatar renders the .avatar element for a pk", () => {
    const container = renderInto(<Avatar pk={PK} />);
    expect(container.querySelector(".avatar")).toBeTruthy();
  });
});
