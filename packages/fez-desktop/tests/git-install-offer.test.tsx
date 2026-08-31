// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { gitInstallOffers, stripInstallMarkers, gitPackageName, GitInstallOffer } from "../src/InstallOffer";

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
  it("gitPackageName mirrors the Rust gh-<owner>-<repo> normalization", () => {
    expect(gitPackageName("github.com/DietrichGebert/ponytail")).toBe("gh-dietrichgebert-ponytail");
    expect(gitPackageName("https://github.com/A.b/c_d#abc123")).toBe("gh-a-b-c-d");
  });
});

/** Command-keyed invoke mock — the card calls list_local_extensions on
 * mount, then inspect/install on clicks; per-call Once-chains can't say
 * which is which. */
function mockCommands(opts: { installed?: string[]; inspect?: object; install?: string }) {
  (invoke as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
    if (cmd === "list_local_extensions") return Promise.resolve((opts.installed ?? []).map((n) => [n, ["skills"]]));
    if (cmd === "inspect_git_package") return Promise.resolve(JSON.stringify(opts.inspect ?? {}));
    if (cmd === "install_git_package") return Promise.resolve(opts.install ?? "installed");
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  });
}

async function mount(url = "github.com/a/b") {
  const div = document.createElement("div");
  document.body.append(div);
  const root = createRoot(div);
  await act(async () => root.render(<GitInstallOffer url={url} authorName="fez" client={{} as never} />));
  return { div, root };
}

describe("GitInstallOffer", () => {
  afterEach(() => vi.clearAllMocks());

  it("inspect result renders consent; refusal renders no install button", async () => {
    mockCommands({ inspect: { name: "gh-a-b", skills: [], agents: [], ignored: [], refused: ["hooks/evil.js"], sha: "s", url: "u", installed: false } });
    const { div, root } = await mount();
    await act(async () => { div.querySelector("button")!.click(); });
    expect(div.textContent).toContain("evil.js");
    expect([...div.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("install & grant");
    act(() => root.unmount());
    div.remove();
  });

  it("clean report renders consent panel, then install & grant installs and reaches done", async () => {
    mockCommands({
      inspect: {
        name: "gh-a-b",
        skills: [{ id: "ponytail", description: "lazy senior dev" }, { id: "scout", description: "" }],
        agents: [{ id: "critic", description: "harsh reviewer" }],
        ignored: ["README.md"],
        refused: [],
        sha: "abcdef1234567890",
        url: "u",
        installed: false,
      },
      install: "installed gh-a-b@0.0.0-abcdef1: ponytail, scout, critic",
    });
    const { div, root } = await mount();
    await act(async () => { div.querySelector("button")!.click(); }); // review & install
    expect(div.textContent).toContain("ponytail");
    expect(div.textContent).toContain("scout");
    expect(div.textContent).toContain("critic");
    expect(div.textContent).toContain("These are instructions that will steer agents you run");
    expect(div.textContent).toContain("gh-a-b");
    expect(div.textContent).toContain("abcdef1");
    const buttons = () => [...div.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons()).toContain("install & grant");

    const installBtn = [...div.querySelectorAll("button")].find((b) => b.textContent === "install & grant")!;
    await act(async () => { installBtn.click(); });
    // Installs pinned to the sha the user actually reviewed, not a re-resolved ref.
    expect(invoke).toHaveBeenCalledWith("install_git_package", { url: "github.com/a/b#abcdef1234567890" });
    expect(div.textContent).toContain("installed — attach it to an agent in its editor");
    expect(buttons()).not.toContain("install & grant");

    act(() => root.unmount());
    div.remove();
  });

  it("already-installed report shows the kept/edits-survive note", async () => {
    mockCommands({ inspect: { name: "gh-a-b", skills: [{ id: "ponytail", description: "" }], agents: [], ignored: [], refused: [], sha: "s", url: "u", installed: true } });
    const { div, root } = await mount();
    await act(async () => { div.querySelector("button")!.click(); });
    expect(div.textContent).toContain("reinstalling refreshes its skills");
    act(() => root.unmount());
    div.remove();
  });

  it("an installed pack's idle card shows the chip, not review & install", async () => {
    mockCommands({ installed: ["gh-a-b"] });
    const { div, root } = await mount();
    expect(div.textContent).toContain("installed");
    const buttons = [...div.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).not.toContain("review & install");
    expect(buttons).toContain("reinstall…");
    act(() => root.unmount());
    div.remove();
  });
});
