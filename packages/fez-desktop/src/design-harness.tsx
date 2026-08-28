/**
 * DESIGN HARNESS — not shipped. `vite --config vite.config.ts` serves
 * /design.html; this mounts the real PersonaEditor against a mocked
 * Tauri bridge so the pane can be looked at (and screenshotted) without
 * booting the app, onboarding, and minting an agent first.
 */
import { createRoot } from "react-dom/client";
import "./App.css";
import PersonaEditor from "./PersonaEditor";
import { BUILT_IN_DEFAULT } from "./theme-default";

const PERSONA = `---
name: drift
description: researches questions and comes back with sourced answers
aliases: [research, dig]
harness: claude-code
channels: [general, lab]
mcpServers: [web-search, fetch]
---

You are @drift, a careful researcher — just passing through, always finding
things. Dig into questions, compare options, check assumptions, and come back
with clear, sourced answers. When a task belongs to a different agent, say so
and hand it over rather than guessing.

Cite what you read. If you could not verify something, say that plainly
instead of smoothing it over.
`;

const SKILLS: Record<string, unknown> = {
  bittensor: { command: "node", args: ["/Users/ken/.fez/ext/bittensor/server.js"], description: "browse subnets and miners" },
  chutes: { command: "node", args: ["/Users/ken/.fez/ext/chutes/server.js"], description: "run models on Chutes" },
  fetch: { url: "https://mcp.example.com/fetch", description: "fetch a url and read it" },
  "fez-kanban": { command: "node", args: ["/Users/ken/.fez/ext/kanban/server.js"], description: "boards, cards, and columns" },
  "fez-obsidian": { url: "https://mcp.example.com/obsidian", description: "read and write an Obsidian vault" },
  "fez-polls": { command: "node", args: ["/Users/ken/.fez/ext/polls/server.js"], description: "run a poll in a channel" },
  "fez-wallet": { command: "node", args: ["/Users/ken/.fez/ext/wallet/server.js"], description: "send and receive payments" },
  hippius: { command: "node", args: ["/Users/ken/.fez/ext/hippius/server.js"], description: "encrypted object storage" },
  memory: { command: "node", args: ["/Users/ken/.fez/ext/memory/server.js"], description: "remember things across turns" },
  tidy: { url: "https://mcp.example.com/tidy" },
  "web-search": { url: "https://mcp.example.com/search", description: "search the live web" },
};

const state = new URLSearchParams(location.search).get("state");
const persona =
  state === "empty"
    ? PERSONA.replace("mcpServers: [web-search, fetch]\n", "")
    : state === "broken"
      ? PERSONA.replace("[web-search, fetch]", "[web-search, docker, kubernetes]")
      : PERSONA;

const TABLE: Record<string, unknown> = {
  read_persona: persona,
  read_skills: JSON.stringify(SKILLS),
  read_extension_grants: "{}",
  read_extension_versions: "{}",
  list_local_extensions: [],
  read_keymap: undefined,
  detect_harnesses: JSON.stringify({ "claude-code": true, pi: true }),
  wire_chutes_pi: JSON.stringify({ provider: "local-56105ece7a", models: ["deepseek-ai/DeepSeek-V3", "moonshot/Kimi-K2"] }),
  update_persona: null,
  rename_persona: null,
  delete_persona: null,
};

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: (cmd: string) =>
    cmd in TABLE ? Promise.resolve(TABLE[cmd]) : Promise.reject(new Error(`harness: no mock for ${cmd}`)),
  transformCallback: (cb: unknown) => cb,
};

if (new URLSearchParams(location.search).get("theme") === "light") {
  for (const [k, v] of Object.entries(BUILT_IN_DEFAULT.light)) document.documentElement.style.setProperty(k, v);
  document.body.style.color = "var(--fg)";
}

createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100vh", display: "flex", background: "var(--bg0)" }}>
    <div style={{ flex: 1 }} />
    <div className="pane">
      <header className="pane-head">
        <span>@ agents</span>
        <span className="pane-actions"><button className="pane-close">✕</button></span>
      </header>
      <PersonaEditor
        name="drift"
        client={
          {
            knownNames: () =>
              new Map([
                ["a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90", "ken"],
                ["b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1", "quill"],
              ]),
          } as never
        }
        onDone={() => {}}
      />
    </div>
  </div>
);
