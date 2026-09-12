import { parsePersona, getField, setField } from "./persona-fields";
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { flash } from "./toast";
import type { FezClient } from "@fezchat/client";
import { parseSkillEntries, formatSkillEntries, parseSkillDecls, formatSkillDecls, safeSkillEntries, nearestKnownKey } from "@fezchat/client";
import { ModelPicker } from "./ModelPicker";
import { accessRows } from "./access-rows";
import { listGuests } from "./guest-threads";
import SkillPicker from "./SkillPicker";
import Avatar from "./Avatar";
import { hasFace } from "./agent-face";

/**
 * Persona editor — Buzz's AgentConfigPanel against fez's contract: the
 * MD file IS the agent, so editing is a frontmatter round-trip. Known
 * fields (harness, model, description, aliases, mcpServers) get
 * inputs; any other frontmatter line survives verbatim — an extension
 * key the GUI doesn't know about must not be eaten by a save. The name
 * is deliberately NOT editable: it's the @mention, the routing name,
 * and the key alias — renaming would mint a different agent.
 */

const listToText = (raw: string) => raw.replace(/^\[|\]$/g, "").trim();
const textToList = (text: string) => {
  const items = text.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? `[${items.join(", ")}]` : "";
};
const splitList = (raw: string) =>
  raw.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);

export default function PersonaEditor({
  name,
  client,
  onDone,
}: {
  name: string;
  client?: FezClient;
  onDone: (changed: boolean) => void;
}) {
  const [front, setFront] = useState<string[]>();
  const [body, setBody] = useState("");
  const [state, setState] = useState<"idle" | "saving" | string>("idle");
  const [armedDelete, setArmedDelete] = useState(false);
  // What was on disk. The commit bar is sticky now, so it is always in
  // view whether or not there is anything to commit — which makes "is
  // there anything to commit" a thing the bar has to be able to say.
  const [saved, setSaved] = useState<{ front: string; body: string }>();

  useEffect(() => {
    void invoke<string>("read_persona", { name })
      .then((content) => {
        const parsed = parsePersona(content);
        setFront(parsed.front);
        setBody(parsed.body);
        setSaved({ front: parsed.front.join("\n"), body: parsed.body });
      })
      .catch((err) => setState(String(err)));
  }, [name]);

  // Advisory only — a near-miss key (`mcpServer` for `mcpServers`) is
  // called out but never blocks the save; extensions own keys fez has
  // never heard of, same rule the CLI's validatePersonaFile follows.
  const keyWarnings = useMemo(
    () =>
      (front ?? [])
        .map((line) => /^([\w-]+):/.exec(line)?.[1])
        .filter((k): k is string => !!k)
        .map((k) => ({ key: k, near: nearestKnownKey(k) }))
        .filter((w): w is { key: string; near: string } => !!w.near),
    [front]
  );

  if (!front) {
    return (
      <div className="pane-body">
        {state === "idle" ? <div className="pane-empty">loading…</div> : <div className="ob-error">{state}</div>}
      </div>
    );
  }

  // Launch configuration changes apply on an explicit restart; saving
  // must not interrupt the work already running with the old configuration.
  const SPAWN_KEYS = ["mcpServers", "skills", "harness", "provider", "model", "effort", "repo", "scope"];

  const save = async () => {
    setState("saving");
    const frontText = front.filter((line) => line.trim()).join("\n");
    const content = frontText ? `---\n${frontText}\n---\n\n${body.trim()}\n` : `${body.trim()}\n`;
    const savedFront = (saved?.front ?? "").split("\n");
    const fieldOf = (lines: string[], key: string) => lines.find((l) => l.startsWith(key + ":"))?.slice(key.length + 1).trim();
    const spawnChanged = SPAWN_KEYS.some((k) => fieldOf(savedFront, k) !== fieldOf(front, k));
    try {
      await invoke("update_persona", { name, content });
      if (spawnChanged) {
        const alive = await invoke<boolean>("agent_alive", { persona: name, bin: "fez-agent" }).catch(() => false);
        if (alive) {
          flash(`@${name} saved — restart from its profile to apply these changes. Current work keeps running.`);
        }
      }
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
  // The brain is one control (model). It writes harness/provider/model at
  // once — pi is invisible plumbing, so it's set here without ever being
  // named in the UI.
  const setBrain = (s: { harness: string; provider: string; model: string }) =>
    setFront(setField(setField(setField(front, "harness", s.harness), "provider", s.provider), "model", s.model));

  const dirty = !saved || saved.front !== front.join("\n") || saved.body !== body;
  const skillNames = parseSkillEntries(splitList(field("mcpServers"))).names;
  const skillMdDecls = parseSkillDecls(splitList(field("skills")));
  const promptWords = body.trim() ? body.trim().split(/\s+/).length : 0;

  return (
    <>
      <div className="pane-body edit-body">
        {/* The character sheet opens on the character: the same portrait
            stage the profile view uses, except here the name and epithet
            ARE the inputs — you edit the being, not fields about it. */}
        <div className="edit-stage">
          <span className="portrait-slot">
            {hasFace(name) ? (
              <Avatar pk="" title={name} size={88} />
            ) : (
              <span className="agent-egg" aria-hidden>◌</span>
            )}
          </span>
          {/* The name is READ-ONLY: it is this agent's primary key — the
              keychain entry, the persona file, and the wallet's `//<name>`
              derivation all hang off it, so "renaming" would fork a new
              identity and orphan the old key, wallet, stake, and record.
              A stable-id/displayName split is the real relabel path (spec
              2026-09-03-agent-identity); until then the name is fixed at
              creation. */}
          <span className="stage-name" title="an agent's name is its identity — create a new agent to use a different one">
            {name}
          </span>
          <input
            className="stage-epithet"
            value={field("description")}
            placeholder="what it does — @fez routes on this, verb phrases route best"
            aria-label="agent description"
            onChange={(e) => update("description", e.target.value)}
          />
        </div>

        {/* Wiring on the left, capabilities on the right; the instructions
            canvas below spans both. One column again under 880px. */}
        <div className="edit-col">
        <div className="manage-section">runtime</div>
        <div className="settings-field">
          <label>channels it serves</label>
          <input
            className="manage-input"
            value={listToText(field("channels"))}
            placeholder="general, lab"
            onChange={(e) => update("channels", textToList(e.target.value))}
          />
        </div>
        {field("harness") !== "router" && (
          <ModelPicker
            value={{ harness: field("harness"), provider: field("provider"), model: field("model") }}
            onChange={setBrain}
          />
        )}
        {field("harness") === "router" && (
          <>
            <div className="manage-section">router — @fez&apos;s brain</div>
            <div className="settings-field">
              <label>endpoint url</label>
              <input
                className="manage-input"
                value={field("url")}
                spellCheck={false}
                placeholder="https://your-router/v1"
                onChange={(e) => update("url", e.target.value)}
              />
              <div className="field-note">
                Any OpenAI-compatible endpoint: a hosted router, ollama, llama.cpp, or a cloud model.
              </div>
            </div>
            <div className="settings-field">
              <label>bearer key</label>
              <div className="field-note">
                The endpoint&apos;s key is a secret — set <code>FEZ_ORCHESTRATOR_KEY</code> in Settings → Skills &amp;
                Secrets (or <code>~/.fez/.env</code> for the CLI). Keys live in one place, never in the persona.
              </div>
            </div>
            <div className="settings-field">
              <label>request shape</label>
              <select className="manage-select" value={field("profile") || "tools"} onChange={(e) => update("profile", e.target.value)}>
                <option value="tools">tools — any capable model (default)</option>
                <option value="minimal">minimal — a restricted tiny router</option>
              </select>
            </div>
            <div className="settings-field">
              <label>fallback guide</label>
              <input
                className="manage-input"
                value={field("fallback") || "fez-guide"}
                spellCheck={false}
                placeholder="fez-guide"
                onChange={(e) => update("fallback", e.target.value)}
              />
              <div className="field-note">Answers when no specialist fits.</div>
            </div>
          </>
        )}
        <div className="settings-field">
          <label>access</label>
          <AccessPicker client={client} value={field("respondTo")} onChange={(value) => update("respondTo", value)} />
        </div>
        <div className="settings-field">
          <label>also answers to</label>
          <input
            className="manage-input"
            value={listToText(field("aliases"))}
            spellCheck={false}
            placeholder="comma-separated nicknames"
            onChange={(e) => update("aliases", textToList(e.target.value))}
          />
        </div>
        {/* Hire rate: the agent's own price for a lease on the bazaar. Blank =
            not for lease. Pay-to isn't asked for — it's the agent's wallet
            address, filled in automatically when it's sent to the bazaar. */}
        <div className="settings-field">
          <label>hire rate</label>
          <div className="rate-row">
            <input
              className="manage-input rate-input"
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={field("rate")}
              placeholder="0"
              onChange={(e) => update("rate", e.target.value)}
            />
            <span className="rate-unit">tτ / hour</span>
          </div>
          <div className="field-note">
            What a lease costs on the bazaar. Leave blank if this agent isn&apos;t for hire. Payments go to
            its own wallet.
          </div>
        </div>

        </div>

        <div className="edit-col">
        {/* The picker draws its own skills/tools divider heads with a
            whisper each — a second bare "skills" head above it just said
            the same word with less information. */}
        <SkillPicker
          value={skillNames}
          sources={parseSkillEntries(splitList(field("mcpServers"))).sources}
          onChange={(names, sources) => {
            // Same refusal as skill-attach's writers: a name or source
            // carrying the line's own structure (`]`, `,`, a newline)
            // would splice real frontmatter keys into this persona, so a
            // poisoned entry makes the whole toggle a no-op rather than
            // a write. The picker only offers installed catalog entries,
            // so a refusal here means settings.json itself is carrying a
            // stranger's string.
            if (!safeSkillEntries(names, sources)) return;
            update("mcpServers", names.length ? `[${formatSkillEntries(names, sources)}]` : "");
          }}
          skillsValue={skillMdDecls.names}
          skillSettings={skillMdDecls.settings}
          onSkillsChange={(names, settings) => {
            // Same guard, same reason — sources for the `skills:` key
            // survive by carry-over (packs are matched by name); the
            // per-attachment settings ride the parens. A setting can't
            // carry the line's own structure either.
            if (!safeSkillEntries(names, {})) return;
            if (Object.values(settings).some((s) => /[(),[\]\n=]/.test(s))) return;
            const sources = Object.fromEntries(names.filter((n) => skillMdDecls.sources[n]).map((n) => [n, skillMdDecls.sources[n]]));
            update("skills", names.length ? `[${formatSkillDecls(names, sources, settings)}]` : "");
          }}
        />

        </div>

        <div className="edit-col edit-col-prompt">
        <div className="manage-section">
          instructions
          {promptWords > 0 && <span className="section-fact">{promptWords} words</span>}
        </div>
        <div className="field-note">This is the agent — everything above is wiring. Written as plain instructions to it.</div>
        <textarea
          className="doc-textarea persona-prompt"
          value={body}
          spellCheck={false}
          placeholder="Tell it who it is, what it is for, and when to hand a task to someone else."
          onChange={(e) => setBody(e.target.value)}
        />

        {keyWarnings.length > 0 && (
          <div className="settings-hint">
            {keyWarnings.map((w) => (
              <div key={w.key}>⚠ &quot;{w.key}&quot; — did you mean &quot;{w.near}&quot;? As written, nothing reads it.</div>
            ))}
          </div>
        )}
        </div>

        {/* The floor of the page, spanning both columns: destruction sits
            alone, last, where it can't be mistaken for configuration. */}
        <div className="edit-danger">
          <button className={armedDelete ? "agent-action armed-delete" : "agent-action danger"} onClick={() => void remove()}>
            {armedDelete ? "really delete @" + name + "?" : "delete agent"}
          </button>
        </div>
      </div>

      {/* The commit row was the last thing in a 1100px scroll: you edited
          the name at the top and then had to go looking for save. It is
          the pane's floor now, always in view, and it says whether there
          is anything to commit rather than sitting bright and idle. */}
      <div className="edit-foot">
        {state !== "idle" && state !== "saving" && <div className="ob-error">{state}</div>}
        <div className="edit-foot-row">
          <button className="agent-action primary" disabled={!dirty || state === "saving"} onClick={() => void save()}>
            {state === "saving" ? "saving…" : "save"}
          </button>
          <button className="agent-action" onClick={() => onDone(false)}>
            {dirty ? "discard" : "close"}
          </button>
          {dirty && <span className="edit-dirty">unsaved</span>}
        </div>
        {dirty && (
          <div className="field-note">
            Applies on the next start. Restart a running agent from its profile when you're ready.
          </div>
        )}
      </div>
    </>
  );
}

/**
 * respondTo, self-serve: the "who may use this agent" policy that was
 * spawn-config with hand-typed hex. owner = you + your attested
 * agents; anyone = every channel member; allowlist = exactly the
 * pubkeys picked here (channel members offered by NAME, hex accepted).
 */
function AccessPicker({
  client,
  value,
  onChange,
}: {
  client?: FezClient;
  value: string;
  onChange: (value: string) => void;
}) {
  const mode = value.startsWith("allowlist:") ? "allowlist" : value === "anyone" ? "anyone" : "owner";
  const pks = mode === "allowlist" ? value.slice("allowlist:".length).split(",").map((s) => s.trim()).filter(Boolean) : [];
  // This machine's own agents are hidden from the list — owner mode
  // already admits them, so their checkbox would grant nothing.
  const [ownAgents, setOwnAgents] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let live = true;
    void invoke<string[]>("list_personas")
      .then((names) => {
        if (!live || !client) return;
        const mine = new Set(names.map((n) => n.toLowerCase()));
        // The viewer is the owner — always admitted, same dead checkbox.
        setOwnAgents(new Set([client.pubkey, ...[...client.agents().entries()].filter(([, n]) => mine.has(n.toLowerCase())).map(([pk]) => pk)]));
      })
      .catch(() => {});
    return () => { live = false; };
  }, [client]);
  const rows = accessRows(client ? [...client.knownNames().entries()] : [], listGuests(), pks, ownAgents);

  const setMode = (next: string) => {
    if (next === "allowlist") onChange(pks.length ? `allowlist:${pks.join(",")}` : "allowlist:");
    else if (next === "anyone") onChange("anyone");
    else onChange(""); // absent = owner (the default)
  };
  const toggle = (pk: string) => {
    const next = pks.includes(pk) ? pks.filter((p) => p !== pk) : [...pks, pk];
    onChange(`allowlist:${next.join(",")}`);
  };

  // The option text used to carry the explanation ("owner — you + your
  // attested agents (default)") and a 340px pane clipped it mid-word. The
  // options name the modes; the note underneath explains the one you
  // picked, which is the only one you needed explained.
  const explain =
    mode === "anyone"
      ? "Every member of the channels it serves can trigger it."
      : mode === "allowlist"
        ? "The people ticked below can trigger it — on top of you and your own agents, who always can. Ticking your own agents changes nothing."
        : "You and your attested agents can trigger it. This is the default.";

  return (
    <>
      <select className="manage-select" value={mode} onChange={(e) => setMode(e.target.value)}>
        <option value="owner">owner</option>
        <option value="anyone">anyone in the channel</option>
        <option value="allowlist">allowlist</option>
      </select>
      <div className="field-note">{explain}</div>
      {mode === "allowlist" && (
        <div className="access-picker">
          {rows.length === 0 && <span className="settings-hint">no known names — edit the frontmatter respondTo directly with pubkeys</span>}
          {rows.map((row) => (
            <label key={row.pk} className="settings-check access-row">
              <input type="checkbox" checked={pks.includes(row.pk)} onChange={() => toggle(row.pk)} />
              {row.name} {row.guest && <span className="mention-key">guest</span>}{" "}
              <code className="access-pk">{row.pk.slice(0, 12)}…</code>
            </label>
          ))}
        </div>
      )}
    </>
  );
}
