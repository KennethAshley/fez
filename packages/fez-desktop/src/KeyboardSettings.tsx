import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_KEYMAP, ACTION_LABELS, loadKeymap, eventToBinding, type ActionId } from "./keymap";

const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent);

/** "mod+shift+h" → "⌘⇧H" on mac, "Ctrl+Shift+H" elsewhere — display only. */
function pretty(binding: string): string {
  const glyph: Record<string, string> = {
    mod: IS_MAC ? "⌘" : "Ctrl",
    alt: IS_MAC ? "⌥" : "Alt",
    shift: IS_MAC ? "⇧" : "Shift",
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
    esc: "Esc",
    space: "Space",
  };
  const parts = binding.split("+").map((raw) => {
    const t = raw.trim().toLowerCase();
    return glyph[t] ?? (t.length === 1 ? t.toUpperCase() : t);
  });
  return parts.join(IS_MAC ? "" : "+");
}

/**
 * The Keyboard panel — the friendly door onto ~/.fez/keymap.json. Click a
 * shortcut, press the keys you want, and it writes the file; hand-editors
 * use the same file. A "fez-keymap-changed" event lets the running app
 * re-read it so a rebind takes effect immediately, not on relaunch.
 */
export function KeyboardSettings({ onNotice }: { onNotice: (text: string) => void }) {
  const [map, setMap] = useState<Record<ActionId, string>>(() => ({ ...DEFAULT_KEYMAP }));
  const [recording, setRecording] = useState<ActionId | undefined>();

  useEffect(() => {
    invoke<string>("read_keymap").then((json) => setMap(loadKeymap(json))).catch(() => {});
  }, []);

  // While recording, capture the next chord before anything else sees it —
  // capture phase + stopPropagation keeps the global dispatcher from firing
  // the very shortcut you're trying to rebind.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(undefined);
        return;
      }
      const binding = eventToBinding(e, IS_MAC);
      if (!binding) return; // a lone modifier — keep waiting for the real key
      void persist({ ...map, [recording]: binding });
      setRecording(undefined);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, map]);

  const persist = async (next: Record<ActionId, string>) => {
    setMap(next);
    try {
      await invoke("write_keymap", { json: JSON.stringify(next, null, 2) });
      window.dispatchEvent(new CustomEvent("fez-keymap-changed"));
      onNotice("✓ shortcut saved");
    } catch (err) {
      onNotice(`✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const reset = (id: ActionId) => void persist({ ...map, [id]: DEFAULT_KEYMAP[id] });

  const ids = [...new Set([...Object.keys(DEFAULT_KEYMAP), ...Object.keys(map)])];

  return (
    <>
      {/* The page's own head names this section and says how to rebind;
          repeating either here gave the page two titles. What survives
          is the part the head cannot say — where the bindings live. */}
      <div className="manage-section">shortcuts</div>
      <div className="keymap-table">
        {ids.map((id) => (
          <div key={id} className="keymap-row">
            <span className="keymap-label">{ACTION_LABELS[id] ?? id}</span>
            <button
              className={recording === id ? "keymap-key recording" : "keymap-key"}
              onClick={() => setRecording((r) => (r === id ? undefined : id))}
            >
              {recording === id ? "press keys…" : map[id] ? pretty(map[id]) : "unbound"}
            </button>
            {DEFAULT_KEYMAP[id] !== undefined && map[id] !== DEFAULT_KEYMAP[id] && (
              <button className="keymap-reset" title="reset to default" onClick={() => reset(id)}>
                ↺
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="set-diag">stored in ~/.fez/keymap.json — editable by hand</div>
    </>
  );
}
