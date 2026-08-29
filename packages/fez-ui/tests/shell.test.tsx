// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { createRoot } from "react-dom/client";
import { act, type ReactElement } from "react";
import { Page, PageHeader, EmptyState } from "../src/index.js";

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

describe("shell primitives render the app's own classes", () => {
  it("PageHeader carries title, subtitle and the rule", () => {
    const container = renderInto(<PageHeader title="agents" subtitle="one line" fact="3 agents" />);
    expect(container.querySelector(".page-head .page-title")?.textContent).toBe("agents");
    expect(container.querySelector(".page-sub")?.textContent).toBe("one line");
    expect(container.querySelector(".page-rule .page-fact")?.textContent).toContain("3 agents");
  });

  it("Page fills to the pane via the main wrapper", () => {
    const container = renderInto(
      <Page wide>
        <span>x</span>
      </Page>
    );
    expect(container.querySelector("main.main .fez-page.wide")).toBeTruthy();
  });

  it("EmptyState speaks in two lines", () => {
    const container = renderInto(<EmptyState line="No agents yet." how="Make one." />);
    expect(container.querySelector(".page-empty .page-empty-line")?.textContent).toBe("No agents yet.");
    expect(container.querySelector(".page-empty-how")?.textContent).toBe("Make one.");
  });
});
