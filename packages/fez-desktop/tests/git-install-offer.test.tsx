// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../src/gui-extensions", () => ({ reloadGuiExtensions: vi.fn().mockResolvedValue(undefined) }));
import { invoke } from "@tauri-apps/api/core";
import { reloadGuiExtensions } from "../src/gui-extensions";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { gitInstallOffers, stripInstallMarkers, GitInstallOffer } from "../src/InstallOffer";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const FILE = "https://github.com/ayghri/i-have-adhd/blob/main/skills/i-have-adhd/SKILL.md";
const TREE = "https://github.com/a/b/tree/feature/skills";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const skill = (id: string) => ({ id, description: `${id} guidance`, path: `skills/${id}/SKILL.md` });
const report = (overrides: object = {}) => ({ kind: "skills", name: "gh-a-b", skills: [skill("ponytail"), skill("scout")],
  agents: [{ id: "critic", description: "Review changes", path: "agents/critic.md" }], ignored: ["README.md"], refused: [],
  unsupported: [], permissions: [], components: ["skills", "personas"], sha: SHA, url: "github.com/a/b", installed: false, ...overrides });
const mounted: Array<{ div: HTMLDivElement; root: ReturnType<typeof createRoot> }> = [];
afterEach(() => {
  for (const { div, root } of mounted.splice(0)) { act(() => root.unmount()); div.remove(); }
  vi.clearAllMocks();
});
function mockCommands(inspect: object = report(), installed = false) {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_local_extensions") return installed ? [["gh-a-b", ["skills"]]] : [];
    if (command === "inspect_git_package") return JSON.stringify(inspect);
    if (command === "install_git_package") return "installed";
    throw new Error(`unexpected command ${command}`);
  });
}
async function mount(url = "github.com/a/b") {
  const div = document.createElement("div"); document.body.append(div);
  const root = createRoot(div); mounted.push({ div, root });
  await act(async () => root.render(<GitInstallOffer url={url} authorName="fez" client={{} as never} />));
  return div;
}
async function click(div: HTMLDivElement, name: string) {
  const button = [...div.querySelectorAll("button")].find(button => button.textContent === name);
  expect(button, `button ${name}`).toBeDefined();
  await act(async () => button!.click());
}

describe("git install markers", () => {
  it("finds GitHub repos and preserves exact file, directory, and ref URLs", () => {
    for (const url of ["github.com/a/b", FILE, TREE, `${FILE}#${SHA}`]) {
      expect(gitInstallOffers(`fez:install git:${url}`)).toEqual([url]);
      expect(stripInstallMarkers(`before\nfez:install git:${url}\nafter`)).toBe("before\n\nafter");
    }
    expect(gitInstallOffers("fez:install git:gitlab.com/a/b")).toEqual([]);
    expect(gitInstallOffers("fez:install git:https://github.com.evil.test/a/b")).toEqual([]);
  });
  it("strips both marker forms", () => {
    expect(stripInstallMarkers("x\nfez:install git:github.com/a/b\nfez:install @fezchat/polls\ny")).toBe("x\n\ny");
  });

});

describe("GitInstallOffer", () => {
  it("inspects before claiming a native or scoped package is already installed", async () => {
    mockCommands(report(), true);
    const div = await mount();
    expect(div.textContent).not.toContain("installed");
    await click(div, "review & install");
    expect(invoke).toHaveBeenCalledWith("inspect_git_package", { url: "github.com/a/b" });
  });
  it("keeps refused content out of every installation path", async () => {
    mockCommands(report({ refused: ["unsafe linked path"] }));
    const div = await mount(); await click(div, "review & install");
    expect(div.textContent).toContain("unsafe linked path");
    expect(div.querySelectorAll("button")).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalledWith("install_git_package", expect.anything());
  });
  it("requires a selection and sends only selected skill/persona paths with explicit skills-only consent", async () => {
    mockCommands(report({ url: TREE, unsupported: ["Claude lifecycle hooks", "Pi extension"] }));
    const div = await mount(TREE); await click(div, "review & install");
    expect(div.textContent).toContain("Skills-only import");
    expect(div.textContent).toContain("Claude lifecycle hooks");
    expect(div.textContent).toContain("Pi extension");
    expect(div.textContent).toContain("not included");
    const boxes = [...div.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes).toHaveLength(3);
    for (const box of boxes) await act(async () => box.click());
    const install = [...div.querySelectorAll("button")].find(button => button.textContent === "Import selected instructions")!;
    expect(install.disabled).toBe(true);
    await act(async () => boxes[2].click());
    await click(div, "Import selected instructions");
    expect(invoke).toHaveBeenCalledWith("install_git_package", { url: `${TREE}#${SHA}`, selectedPaths: ["agents/critic.md"], allowSkillsOnly: true });
    expect(reloadGuiExtensions).not.toHaveBeenCalled();
    expect(div.textContent).toContain("Choose an agent in Tools");
  });
  it("pins an exact SKILL.md URL without broadening its path", async () => {
    mockCommands(report({ url: FILE, skills: [skill("i-have-adhd")], agents: [] }));
    const div = await mount(`${FILE}#old-ref`); await click(div, "review & install");
    expect(div.textContent).toContain("skills/i-have-adhd/SKILL.md");
    expect(div.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    await click(div, "Import selected instructions");
    expect(invoke).toHaveBeenCalledWith("install_git_package", { url: `${FILE}#${SHA}`, selectedPaths: ["skills/i-have-adhd/SKILL.md"], allowSkillsOnly: true });
  });
  it("pins the canonical inspected ref/path boundary, not the ambiguous entered URL", async () => {
    const canonical = "https://github.com/a/b/tree/feature%2Fbranch/skills/scout";
    mockCommands(report({ url: canonical, skills: [skill("scout")], agents: [] }));
    const div = await mount("https://github.com/a/b/tree/feature/branch/skills/scout");
    await click(div, "review & install");
    await click(div, "Import selected instructions");
    expect(invoke).toHaveBeenCalledWith("install_git_package", { url: `${canonical}#${SHA}`, selectedPaths: ["skills/scout/SKILL.md"], allowSkillsOnly: true });
  });
  it("reviews and installs native Fez components and grants without a skills-only downgrade", async () => {
    mockCommands(report({ kind: "fez-package", name: "@example/native", permissions: ["read:agents", "processes"], components: ["gui", "skills"] }));
    const div = await mount(); await click(div, "review & install");
    expect(div.textContent).toContain("Native Fez package");
    expect(div.textContent).toContain("read:agents");
    expect(div.textContent).toContain("processes");
    expect(div.textContent).toContain("gui");
    expect(div.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    await click(div, "Install & grant");
    expect(invoke).toHaveBeenCalledWith("install_git_package", { url: `github.com/a/b#${SHA}` });
    expect(reloadGuiExtensions).toHaveBeenCalledTimes(1);
  });
  it("lets a failed read-only inspection retry without an install", async () => {
    mockCommands();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("inspection unavailable"));
    const div = await mount(); await click(div, "review & install");
    expect(div.textContent).toContain("inspection unavailable");
    await click(div, "Try inspection again");
    expect(div.textContent).toContain("Skills-only import");
    expect(invoke).not.toHaveBeenCalledWith("install_git_package", expect.anything());
  });
  it("uses inspected installed state and keeps the edit-preservation disclosure", async () => {
    mockCommands(report({ installed: true }));
    const div = await mount(); await click(div, "review & install");
    expect(div.textContent).toContain("already installed");
    expect(div.textContent).toContain("persona files you've edited are kept");
  });
  it("blocks older inspect contracts instead of importing an unreviewed whole repository", async () => {
    const old = report(); delete (old as Partial<typeof old>).kind;
    mockCommands(old);
    const div = await mount(); await click(div, "review & install");
    expect(div.textContent).toContain("Update Fez");
    expect(div.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalledWith("install_git_package", expect.anything());
  });
});
