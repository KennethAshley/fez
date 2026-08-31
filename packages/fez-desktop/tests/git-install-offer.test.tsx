// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { gitInstallOffers, stripInstallMarkers, GitInstallOffer } from "../src/InstallOffer";

describe("git install markers", () => {
  it("finds github urls and nothing else", () => {
    expect(gitInstallOffers("hi\nfez:install git:github.com/a/b\n")).toEqual(["github.com/a/b"]);
    expect(gitInstallOffers("fez:install git:gitlab.com/a/b")).toEqual([]);
    expect(gitInstallOffers("fez:install @fezchat/polls")).toEqual([]);
  });
  it("strips both marker forms", () => {
    const s = stripInstallMarkers("x\nfez:install git:github.com/a/b\nfez:install @fezchat/polls\ny");
    expect(s).not.toContain("fez:install");
    expect(s).toContain("x");
  });
});

describe("GitInstallOffer", () => {
  afterEach(() => vi.clearAllMocks());
  it("inspect result renders consent; refusal renders no install button", async () => {
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(JSON.stringify({
      name: "gh-a-b", personas: [], ignored: [], refused: ["hooks/evil.js"], sha: "s", url: "u", installed: false,
    }));
    const div = document.createElement("div");
    document.body.append(div);
    const root = createRoot(div);
    await act(async () => root.render(<GitInstallOffer url="github.com/a/b" authorName="fez" client={{} as never} />));
    await act(async () => { div.querySelector("button")!.click(); });
    expect(div.textContent).toContain("evil.js");
    expect([...div.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("install & grant");
    act(() => root.unmount());
    div.remove();
  });
});
