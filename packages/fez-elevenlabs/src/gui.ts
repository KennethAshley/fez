import type { El, GuiClient, GuiExtensionApi } from "@fezchat/extension-api/gui";
import { PINNED, voiceFor } from "./voices.js";

/** `agents()` (pk → persona name) isn't in the shared GuiClient slice
 * (extension-api types only what most gui parts need) — reach for it
 * the way fez-wallet reaches under GuiClient for things it needs, typed
 * against what's actually used (fez-client:667). */
interface VoiceClient extends GuiClient {
  agents(): Map<string, string>;
}

/**
 * fez-elevenlabs, GUI part — the voice map.
 *
 * Each agent the workspace knows gets a row: name, its current voice
 * (deterministic default or override), a picker, and ▶ preview when the
 * pinned voice carries a public preview url. Writes go through the
 * prefs seam as one `voices` object; the skill reads the same file.
 * The API key is NOT here — it lives in the skill's env like every
 * other fez skill secret.
 */
export default function activate(api: GuiExtensionApi): void {
  const h = api.React.createElement;
  const { useState, useEffect } = api.React;
  const client = api.client as VoiceClient;

  function Panel(): El {
    const [voices, setVoices] = useState<Record<string, string>>({});
    const [agents, setAgents] = useState<{ name: string; pk: string }[]>([]);

    useEffect(() => {
      void api.prefs.get<Record<string, string>>("voices").then((v) => setVoices(v ?? {}));
      const list = [...client.agents().entries()].map(([pk, name]) => ({ pk, name }));
      setAgents(list.sort((a, b) => a.name.localeCompare(b.name)));
    }, []);

    const set = (agent: string, id: string) => {
      const next = { ...voices };
      if (id) next[agent] = id;
      else delete next[agent];
      setVoices(next);
      void api.prefs.set("voices", next);
    };

    if (agents.length === 0) return h("div", { className: "settings-hint" }, "no agents yet — voices attach to agents.");

    return h(
      "div",
      null,
      h("div", { className: "settings-hint" }, "Each agent speaks with a stable voice — assigned from its identity, overridable here. The API key lives on the skill, in Settings → skills."),
      ...agents.map(({ name, pk }) => {
        const current = voiceFor(pk, voices, name);
        const overridden = !!voices[name];
        return h(
          "div",
          { key: name, className: "set-row" },
          h("span", { className: "set-label" }, `@${name}`),
          h(
            "select",
            {
              className: "manage-select",
              value: overridden ? current.id : "",
              onChange: (e: { target: { value: string } }) => set(name, e.target.value),
            },
            h("option", { value: "" }, `${current.name} (default)`),
            ...PINNED.map((v) => h("option", { key: v.id, value: v.id }, v.name))
          ),
          current.previewUrl &&
            h(
              "button",
              { className: "mini", onClick: () => void new Audio(current.previewUrl).play() },
              "▶"
            )
        );
      })
    );
  }

  api.registerSettingsPanel("ElevenLabs", () => h(Panel, null));
}
