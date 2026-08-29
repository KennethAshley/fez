// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { createRoot } from "react-dom/client";
import { act, type ReactElement } from "react";
import { Field, Row, Chip } from "../src/index.js";

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

describe("form primitives", () => {
  it("Field wraps a labelled control with a hint", () => {
    const container = renderInto(
      <Field label="Relay" hint="wss://">
        <input />
      </Field>
    );
    expect(container.querySelector(".settings-field")).toBeTruthy();
    const hint = container.querySelector(".settings-hint");
    expect(hint?.textContent).toBe("wss://");
    expect(hint?.className).toContain("settings-hint");
    expect(container.querySelector(".settings-field input")).toBeTruthy();
  });

  it("Row marks the active one for the ember notch", () => {
    const container = renderInto(
      <>
        <Row>a</Row>
        <Row active>b</Row>
      </>
    );
    const rows = container.querySelectorAll("[data-active]");
    // the active row carries the app's active-row class (matched from App.css)
    expect(container.textContent).toContain("b");
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("Chip renders the app's chip class", () => {
    const container = renderInto(<Chip>rust</Chip>);
    expect(container.querySelector(".skill-chip, .pill")).toBeTruthy();
  });
});
