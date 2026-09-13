import type { GuiExtensionApi } from '@fezchat/extension-api/gui';
declare const SESSION: { endpoint: string; uiToken: string };

// Throwaway streamed CEF view; deliberately not a native NSView embedding.
export function activate(api: GuiExtensionApi) {
  api.registerGuiCommand('cef', () => {
    if (!api.openPanel) return 'This desktop build does not support extension side panes.';
    api.openPanel('Chromium prototype', host => {
      if (!host) return;
      host.innerHTML = `<div style="padding:12px;display:flex;flex-direction:column;gap:10px;height:100%">
        <strong>CEF prototype · temporary session</strong>
        <form style="display:flex;gap:8px"><input aria-label="Website URL" placeholder="https://example.com" style="flex:1;min-width:0;color:black"><button>Go</button></form>
        <div><button data-mode="human">Take control</button> <button data-mode="agent">Give agent control</button> <button id="stop">Stop session</button></div>
        <p role="status">Connecting…</p>
        <img tabindex="0" aria-label="Live browser. Click to focus; type to interact. Use Tab and Enter to navigate the page." style="width:100%;outline:1px solid #555;object-fit:contain;object-position:top;cursor:crosshair">
        <small>Live screenshots from a separate Chromium process. Closing this pane revokes agent control. Stop closes the browser and deletes this temporary profile.</small>
      </div>`;
      const img = host.querySelector('img')!;
      const status = host.querySelector('[role=status]')!;
      let disposed = false;
      let mode = 'human';
      let viewport = { clientWidth: 800, clientHeight: 600 };
      let inputQueue = Promise.resolve();
      async function request(action: object) {
        const response = await fetch(`${SESSION.endpoint}/control`, {
          method: 'POST', headers: { Authorization: `Bearer ${SESSION.uiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(action), signal: AbortSignal.timeout(7000),
        });
        const result = await response.json();
        mode = result.mode;
        if (result.error) throw new Error(result.error);
        if (!disposed) status.textContent = `Control: ${mode}`;
        return result;
      }
      function send(action: object) {
        inputQueue = inputQueue.then(() => request(action)).then(() => {}, error => { if (!disposed) status.textContent = error.message; });
      }
      host.querySelector('form')!.onsubmit = event => { event.preventDefault(); send({ type: 'navigate', url: host.querySelector('input')!.value }); };
      host.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.onclick = () => send({ type: 'mode', value: button.dataset.mode }));
      host.querySelector<HTMLButtonElement>('#stop')!.onclick = () => { void request({ type: 'stop' }).catch(error => { status.textContent = error.message; }); };
      img.onclick = event => {
        if (mode !== 'human') return;
        img.focus();
        const rect = img.getBoundingClientRect();
        send({ type: 'click', x: (event.clientX - rect.left) * viewport.clientWidth / rect.width, y: (event.clientY - rect.top) * viewport.clientHeight / rect.height });
      };
      img.onkeydown = event => {
        if (mode !== 'human' || event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key.length === 1) { event.preventDefault(); send({ type: 'type', text: event.key }); }
        else if (['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          if (event.key === 'Escape') { img.blur(); return; }
          event.preventDefault(); send({ type: 'key', key: event.key });
        }
      };
      async function refresh() {
        if (disposed || mode === 'stopped') return;
        try { const result = await request({ type: 'observe' }); if (!disposed && result.data) { img.src = `data:image/jpeg;base64,${result.data}`; viewport = result.viewport; } }
        catch (error) { if (!disposed) status.textContent = error instanceof Error ? error.message : String(error); }
        if (!disposed && mode !== 'stopped') setTimeout(refresh, 300);
      }
      void refresh();
      return () => { disposed = true; void request({ type: 'mode', value: 'human' }).catch(() => {}); host.replaceChildren(); };
    });
    return '';
  });
}
