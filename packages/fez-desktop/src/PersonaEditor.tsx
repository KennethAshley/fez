import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Persona editor — Buzz's AgentConfigPanel against fez's contract: the
 * MD file IS the agent, so editing is a frontmatter round-trip. Known
 * fields (harness, model, description, aliases, mcpServers) get
 * inputs; any other frontmatter line survives verbatim — an extension
 * key the GUI doesn't know about must not be eaten by a save. The name
 * is deliberately NOT editable: it's the @mention, the routing name,
 * and the key alias — renaming would mint a different agent.
 */

function parsePersona(content: string): { front: string[]; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return { front: [], body: content.trim() };
  return { front: match[1].split(/\r?\n/), body: match[2].trim() };
}

function getField(front: string[], key: string): string {
  for (const line of front) {
    const match = new RegExp(`^${key}:\\s*(.*)$`).exec(line);
    if (match) return match[1].trim();
  }
  return "";
}

function setField(front: string[], key: string, value: string): string[] {
  const index = front.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (!value.trim()) return index === -1 ? front : front.filter((_, i) => i !== index);
  const line = `${key}: ${value.trim()}`;
  if (index === -1) return [...front, line];
  return front.map((existing, i) => (i === index ? line : existing));
}

const listToText = (raw: string) => raw.replace(/^\[|\]$/g, "").trim();
const textToList = (text: string) => {
  const items = text.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? `[${items.join(", ")}]` : "";
};

export default function PersonaEditor({ name, onDone }: { name: string; onDone: (changed: boolean) => void }) {
  const [front, setFront] = useState<string[]>();
  const [body, setBody] = useState("");
  const [state, setState] = useState<"idle" | "saving" | string>("idle");
  const [armedDelete, setArmedDelete] = useState(false);

  useEffect(() => {
    void invoke<string>("read_persona", { name })
      .then((content) => {
        const parsed = parsePersona(content);
        setFront(parsed.front);
        setBody(parsed.body);
      })
      .catch((err) => setState(String(err)));
  }, [name]);

  if (!front) {
    return (
      <div className="pane-body">
        {state === "idle" ? <div className="pane-empty">loading…</div> : <div className="ob-error">{state}</div>}
      </div>
    );
  }

  const save = async () => {
    setState("saving");
    const frontText = front.filter((line) => line.trim()).join("\n");
    const content = frontText ? `---\n${frontText}\n---\n\n${body.trim()}\n` : `${body.trim()}\n`;
    try {
      await invoke("update_persona", { name, content });
      onDone(true);
    } catch (err) {
      setState(String(err));
    }
  };

  const remove = async () => {
    if (!armedDelete) {
      setArmedDelete(true);
      setTimeout(() => setArmedDelete(false), 3500);
      return;
    }
    try {
      await invoke("delete_persona", { name });
      onDone(true);
    } catch (err) {
      setState(String(err));
    }
  };

  const field = (key: string) => getField(front, key);
  const update = (key: string, value: string) => setFront(setField(front, key, value));

  return (
    <div className="pane-body">
      <div className="settings-hint">
        Editing <b>@{name}</b> — changes apply on its next spawn (a running agent finishes its turn on the old
        persona). The name itself can't change: it's the @mention and the agent's key identity.
      </div>
      <div className="settings-field">
        <label>harness</label>
        <select className="manage-select" value={field("harness") || "claude-code"} onChange={(e) => update("harness", e.target.value)}>
          {["claude-code", "pi", ...(field("harness") && !["claude-code", "pi"].includes(field("harness")) ? [field("harness")] : [])].map(
            (option) => (
              <option key={option} value={option}>{option}</option>
            )
          )}
        </select>
      </div>
      <div className="settings-field">
        <label>model (pi reads this; claude-code uses its own default)</label>
        <input className="manage-input" value={field("model")} spellCheck={false} placeholder="(harness default)" onChange={(e) => update("model", e.target.value)} />
      </div>
      <div className="settings-field">
        <label>description (helps @fez route to it)</label>
        <input className="manage-input" value={field("description")} onChange={(e) => update("description", e.target.value)} />
      </div>
      <div className="settings-field">
        <label>aliases (comma-separated)</label>
        <input
          className="manage-input"
          value={listToText(field("aliases"))}
          spellCheck={false}
          onChange={(e) => update("aliases", textToList(e.target.value))}
        />
      </div>
      <div className="settings-field">
        <label>skills / mcpServers (comma-separated)</label>
        <input
          className="manage-input"
          value={listToText(field("mcpServers"))}
          spellCheck={false}
          onChange={(e) => update("mcpServers", textToList(e.target.value))}
        />
      </div>
      <div className="settings-field">
        <label>system prompt</label>
        <textarea className="doc-textarea persona-prompt" value={body} spellCheck={false} onChange={(e) => setBody(e.target.value)} />
      </div>
      {state !== "idle" && state !== "saving" && <div className="ob-error">{state}</div>}
      <div className="agent-actions">
        <button className="agent-action" disabled={state === "saving"} onClick={() => void save()}>
          {state === "saving" ? "saving…" : "save"}
        </button>
        <button className="agent-action" onClick={() => onDone(false)}>cancel</button>
        <button className={armedDelete ? "agent-action armed-delete" : "agent-action"} onClick={() => void remove()}>
          {armedDelete ? "really delete?" : "delete persona"}
        </button>
      </div>
    </div>
  );
}
