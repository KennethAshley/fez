import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateModelProfile } from "../../fez-acp/src/model-profile.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "fez-model-profile-")); homes.push(home);
  const provider = "ext-fixture-provider-mini", model = "test-model", persona = "researcher";
  const directory = join(home, ".fez", "model-profiles", provider, persona);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const save = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value), { mode: 0o600 });
  const binding = { provider, model, persona };
  const settings = { defaultProvider: provider, defaultModel: model, retry: { enabled: false } };
  const models = { providers: { [provider]: { baseUrl: "http://127.0.0.1:19001/v1", apiKey: "private-fixture-token", models: [{ id: model }] } } };
  save("profile.json", binding); save("settings.json", settings); save("models.json", models);
  return { home, directory, provider, model, persona, binding, settings, models, save,
    selection: { id: persona, harness: "pi", extra: { provider, model, modelProfile: provider } } };
}

it("pins an agent to its own model profile without changing other agents or returning credentials", () => {
  const f = fixture();
  const env = { PI_CODING_AGENT_DIR: "/unrelated/cloud-profile" };
  expect(activateModelProfile(f.selection, f.home, env)).toBe(true);
  expect(env.PI_CODING_AGENT_DIR).toBe(f.directory);
  expect(JSON.stringify(env)).not.toContain("private-fixture-token");
  const other: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: "/unrelated/cloud-profile", FEZ_PI_REQUIRED_MODEL: "inherited/stale-model" };
  expect(activateModelProfile({ ...f.selection, extra: { provider: "cloud", model: "cloud-model" } }, f.home, other)).toBe(false);
  expect(other.PI_CODING_AGENT_DIR).toBe("/unrelated/cloud-profile");
  expect(other.FEZ_PI_REQUIRED_MODEL).toBeUndefined();
});

it.each(["other-persona", "other-model", "other-provider", "missing", "retry", "cloud-provider", "traversal"])("refuses %s profiles before touching the environment", fault => {
  const f = fixture();
  if (fault === "other-persona") f.save("profile.json", { ...f.binding, persona: "someone-else" });
  if (fault === "other-model") f.save("settings.json", { ...f.settings, defaultModel: "cloud-model" });
  if (fault === "other-provider") f.selection.extra.provider = "cloud";
  if (fault === "missing") rmSync(join(f.directory, "models.json"));
  if (fault === "retry") f.save("settings.json", { ...f.settings, retry: { enabled: true } });
  if (fault === "cloud-provider") f.save("models.json", { providers: { ...f.models.providers, cloud: { apiKey: "do-not-leak" } } });
  if (fault === "traversal") f.selection.extra.modelProfile = "../../escape";
  const env = { PI_CODING_AGENT_DIR: "/original" };
  expect(() => activateModelProfile(f.selection, f.home, env)).toThrow(/model profile/i);
  expect(env.PI_CODING_AGENT_DIR).toBe("/original");
});
