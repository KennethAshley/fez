import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "./toast";

/** Native close hides the window; only an explicit, confirmed Quit stops work. */
export default function QuitDialog() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [requested, setRequested] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("fez-quit-requested", () => { if (!disposed) setRequested(true); })
      .then((off) => { if (disposed) off(); else unlisten = off; })
      .catch((err) => { if (!disposed) toast.error(`Couldn't prepare Quit confirmation: ${String(err)}`); });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => { if (requested) dialog.current?.showModal(); }, [requested]);

  const cancel = () => {
    if (quitting) return;
    setError(undefined);
    setRequested(false);
  };
  const quit = async () => {
    setQuitting(true);
    setError(undefined);
    try {
      await invoke("confirm_desktop_quit");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setQuitting(false);
    }
  };

  if (!requested) return null;
  return <dialog ref={dialog} className="ob-card ai-setup-dialog" aria-labelledby="desktop-quit-title" aria-describedby="desktop-quit-details"
    onCancel={(event) => { event.preventDefault(); cancel(); }}>
    <h2 id="desktop-quit-title">Quit Fez?</h2>
    <p id="desktop-quit-details" className="ob-lede">Quitting stops local agents and integrations. Their active work will stop. Close the window to keep Fez running in the background.</p>
    {error && <p role="alert" className="ob-error">{error}</p>}
    {quitting && <p role="status">Stopping local work…</p>}
    <button className="ob-secondary" autoFocus disabled={quitting} onClick={cancel}>Keep running</button>
    <button className="ob-primary" disabled={quitting} onClick={() => void quit()}>Quit and stop local work</button>
  </dialog>;
}
