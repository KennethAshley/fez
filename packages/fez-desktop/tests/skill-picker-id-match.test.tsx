// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import SkillPicker from "../src/SkillPicker";

/**
 * Regression for the review finding: the skills: section must match
 * installed skills by id OR name, same rule agentSkillHealth and
 * spawn-time resolveAttachedSkills use — matching by name only made a
 * persona declaring the canonical id show as a bogus "missing" row
 * plus a duplicate unchecked installed row.
 */
describe("SkillPicker skills: section — id/name matching", () => {
  afterEach(() => vi.clearAllMocks());

  it("a persona declaring by id shows as installed and checked, not missing", async () => {
    (invoke as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
      switch (cmd) {
        case "list_installed_skills":
          return Promise.resolve(
            JSON.stringify([{ pkg: "gh-x-ponytail", id: "pony", name: "ponytail", description: "lazy senior dev" }])
          );
        case "list_local_extensions":
          return Promise.resolve([]);
        case "read_keymap":
          return Promise.resolve(undefined);
        default:
          return Promise.resolve("{}"); // read_skills, read_extension_grants, read_extension_versions
      }
    });

    const div = document.createElement("div");
    document.body.append(div);
    const root = createRoot(div);
    await act(async () => {
      root.render(
        <SkillPicker value={[]} sources={{}} onChange={() => {}} skillsValue={["pony"]} onSkillsChange={() => {}} />
      );
    });

    // Pack row + its one folded per-skill row — and no third, bogus-missing
    // checkbox for the id-declared skill.
    const checkboxes = [...div.querySelectorAll("input[type=checkbox]")] as HTMLInputElement[];
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes.every((c) => c.checked)).toBe(true);
    expect(div.textContent).toContain("ponytail");
    expect(div.textContent).not.toContain("install it from chat");

    act(() => root.unmount());
    div.remove();
  });
});
