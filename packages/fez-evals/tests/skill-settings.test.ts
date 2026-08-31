import { describe, it, expect } from "vitest";
import { parseFrontmatter, parseSkillDecls, formatSkillDecls } from "../../../src/identity/personas";
import { parseSkillDecls as clientParse, formatSkillDecls as clientFormat } from "../../fez-client/src/skill-source";

describe("skills: per-attachment settings", () => {
  it("parses name(setting) with and without a source", () => {
    const d = parseSkillDecls(["ponytail(ultra)", "review(k=v)=npm:@x/y", "plain", "sourced=git:github.com/o/r"]);
    expect(d.names).toEqual(["ponytail", "review", "plain", "sourced"]);
    expect(d.settings).toEqual({ ponytail: "ultra", review: "k=v" });
    expect(d.sources).toEqual({ review: "npm:@x/y", sourced: "git:github.com/o/r" });
  });
  it("round-trips through formatSkillDecls", () => {
    const names = ["ponytail", "review", "plain"];
    const sources = { review: "npm:@x/y" };
    const settings = { ponytail: "ultra" };
    const line = formatSkillDecls(names, sources, settings);
    expect(line).toBe("ponytail(ultra), review=npm:@x/y, plain");
    const back = parseSkillDecls(line.split(",").map((s) => s.trim()));
    expect(back).toEqual({ names, sources, settings });
  });
  it("parseFrontmatter carries skillSettings; mcpServers untouched by parens", () => {
    const p = parseFrontmatter("---\nharness: pi\nskills: [ponytail(ultra), review]\nmcpServers: [wallet]\n---\nBody.");
    expect(p.skills).toEqual(["ponytail", "review"]);
    expect(p.skillSettings).toEqual({ ponytail: "ultra" });
    expect(p.mcpServers).toEqual(["wallet"]);
  });
  it("client mirror agrees with core", () => {
    const entries = ["ponytail(ultra)=git:github.com/o/r"];
    expect(clientParse(entries)).toEqual(parseSkillDecls(entries));
    expect(clientFormat(["a"], {}, { a: "x" })).toBe(formatSkillDecls(["a"], {}, { a: "x" }));
  });
});
