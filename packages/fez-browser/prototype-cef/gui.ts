import type { GuiExtensionApi } from '@fezchat/extension-api/gui';
import { openNativeBrowser } from '../src/native-gui';
declare const SESSION: { endpoint: string; uiToken: string };
declare const STYLES: string;

// The browser still runs in a separate CEF process; this is its shared viewport.
export function activate(api: GuiExtensionApi) {
  api.registerGuiCommand('cef', async () => {
    if (api.nativeSurfaces && await api.nativeSurfaces.available()) return openNativeBrowser(api, STYLES);
    if (!api.openPanel) return 'This desktop build does not support browser panels.';
    api.openPanel('Browser', host => {
      if (!host) return;
      host.innerHTML = `<style>${STYLES}</style><section class="cef-browser" aria-label="Shared browser">
        <div class="cef-toolbar">
          <div class="cef-navigation">
            <button type="button" data-nav="back" aria-label="Back" title="Back" disabled>←</button>
            <button type="button" data-nav="forward" aria-label="Forward" title="Forward" disabled>→</button>
            <button type="button" data-nav="reload" aria-label="Reload page" title="Reload page">↻</button>
          </div>
          <form class="cef-address"><input aria-label="Website address" placeholder="Enter a website" autocomplete="off" spellcheck="false"><button type="submit" aria-label="Open address">Go</button></form>
          <button type="button" class="cef-control" data-control>Give agent control</button>
          <button type="button" class="cef-stop" aria-label="Stop browser session" title="Stop browser session">■</button>
        </div>
        <div class="cef-notice" role="alert" hidden></div>
        <div class="cef-viewport">
          <img class="cef-page" tabindex="0" draggable="false" aria-label="Browser page. Click or type to interact.">
          <div class="cef-message"><span>Connecting to browser…</span></div>
        </div>
        <div class="cef-footer"><span class="cef-state" role="status">Connecting…</span><span class="cef-title"></span></div>
      </section>`;
      const root = host.querySelector<HTMLElement>('.cef-browser')!;
      const img = host.querySelector<HTMLImageElement>('img')!;
      const address = host.querySelector<HTMLInputElement>('input')!;
      const viewportBox = host.querySelector<HTMLElement>('.cef-viewport')!;
      const status = host.querySelector<HTMLElement>('[role=status]')!;
      const message = host.querySelector<HTMLElement>('.cef-message')!;
      const notice = host.querySelector<HTMLElement>('.cef-notice')!;
      const control = host.querySelector<HTMLButtonElement>('[data-control]')!;
      const back = host.querySelector<HTMLButtonElement>('[data-nav=back]')!;
      const forward = host.querySelector<HTMLButtonElement>('[data-nav=forward]')!;
      const reload = host.querySelector<HTMLButtonElement>('[data-nav=reload]')!;
      const stop = host.querySelector<HTMLButtonElement>('.cef-stop')!;
      let disposed = false;
      let connected = false;
      let frameReady = false;
      let frameRevision = 0;
      let mode = 'human';
      let currentUrl = '';
      let navigation = { canGoBack: false, canGoForward: false };
      let viewport = { clientWidth: 800, clientHeight: 600 };
      let inputQueue = Promise.resolve();
      let refreshTimer: ReturnType<typeof setTimeout> | undefined;
      let resizeTimer: ReturnType<typeof setTimeout> | undefined;
      let requestedSize = '';

      function controls() {
        const human = connected && mode === 'human';
        root.dataset.mode = mode;
        back.disabled = !human || !navigation.canGoBack;
        forward.disabled = !human || !navigation.canGoForward;
        reload.disabled = !human;
        address.disabled = !human;
        host!.querySelector<HTMLButtonElement>('form button')!.disabled = !human;
        control.disabled = mode === 'stopped' || (!connected && mode !== 'agent');
        control.textContent = mode === 'agent' ? 'Take control' : 'Give agent control';
        stop.disabled = mode === 'stopped';
        status.textContent = mode === 'stopped' ? 'Session ended' : !connected ? 'Disconnected' : mode === 'agent' ? 'Agent has control' : 'You have control';
      }
      function showError(error: unknown) {
        if (disposed) return;
        notice.textContent = error instanceof Error ? error.message : String(error);
        notice.hidden = false;
      }
      async function request(action: object) {
        const response = await fetch(`${SESSION.endpoint}/control`, {
          method: 'POST', headers: { Authorization: `Bearer ${SESSION.uiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(action), signal: AbortSignal.timeout(7000),
        });
        const result = await response.json();
        mode = result.mode ?? mode;
        if (result.error || !response.ok) throw new Error(result.error || 'Browser request failed');
        if (!disposed) { connected = true; controls(); }
        return result;
      }
      function send(action: object) {
        notice.hidden = true;
        inputQueue = inputQueue.then(() => disposed ? undefined : request(action)).then(() => {}, showError);
      }
      host.querySelector('form')!.onsubmit = event => {
        event.preventDefault();
        const value = address.value.trim();
        if (value) send({ type: 'navigate', url: value.includes('://') ? value : `https://${value}` });
        address.blur();
      };
      back.onclick = () => send({ type: 'history', delta: -1 });
      forward.onclick = () => send({ type: 'history', delta: 1 });
      reload.onclick = () => send({ type: 'reload' });
      control.onclick = () => {
        if (mode === 'agent') void request({ type: 'mode', value: 'human' }).catch(showError);
        else send({ type: 'mode', value: 'agent' });
      };
      stop.onclick = () => { void request({ type: 'stop' }).then(() => {
        message.hidden = false; message.textContent = 'Browser session ended.';
      }).catch(showError); };

      // Fit can leave empty space during a resize. Only image pixels are clickable.
      function point(event: MouseEvent) {
        const rect = img.getBoundingClientRect();
        const scale = Math.min(rect.width / viewport.clientWidth, rect.height / viewport.clientHeight);
        const x = (event.clientX - rect.left) / scale, y = (event.clientY - rect.top) / scale;
        return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < viewport.clientWidth && y < viewport.clientHeight ? { x, y } : undefined;
      }
      img.onclick = event => {
        if (!connected || !frameReady || mode !== 'human') return;
        const position = point(event);
        if (!position) return;
        img.focus(); send({ type: 'click', ...position });
      };
      img.addEventListener('wheel', event => {
        if (!connected || !frameReady || mode !== 'human') return;
        event.preventDefault();
        const position = point(event);
        if (!position) return;
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
        const delta = (value: number) => Math.max(-4096, Math.min(4096, value * unit));
        send({ type: 'wheel', ...position, deltaX: delta(event.deltaX), deltaY: delta(event.deltaY) });
      }, { passive: false });
      root.onkeydown = event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l' && mode === 'human') {
          event.preventDefault(); event.stopPropagation(); address.focus(); address.select();
        }
      };
      img.onkeydown = event => {
        if (!connected || !frameReady || mode !== 'human' || event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key.length === 1) { event.preventDefault(); send({ type: 'type', text: event.key }); }
        else if (['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          if (event.key === 'Escape') { img.blur(); return; }
          event.preventDefault(); send({ type: 'key', key: event.key });
        }
      };
      img.onpaste = event => {
        if (!connected || !frameReady || mode !== 'human') return;
        event.preventDefault();
        const text = event.clipboardData?.getData('text/plain');
        if (text) send({ type: 'type', text });
      };
      const resize = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (disposed || mode === 'stopped') return;
          const rect = viewportBox.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          const width = Math.max(200, Math.min(4096, Math.round(rect.width)));
          const height = Math.max(200, Math.min(4096, Math.round(rect.height)));
          const size = `${width}x${height}`;
          if (requestedSize === size) return;
          requestedSize = size;
          frameReady = false;
          frameRevision++;
          send({ type: 'resize', width, height });
        }, 120);
      });
      resize.observe(viewportBox);
      async function refresh() {
        if (disposed || mode === 'stopped') return;
        try {
          const revision = frameRevision;
          await inputQueue;
          if (disposed || mode === 'stopped') return;
          const result = await request({ type: 'observe' });
          if (!disposed && mode !== 'stopped' && revision === frameRevision && result.data) {
            img.src = `data:image/jpeg;base64,${result.data}`;
            await img.decode();
            if (!disposed && mode !== 'stopped' && revision === frameRevision) {
              viewport = result.viewport;
              frameReady = true;
              currentUrl = result.url ?? currentUrl;
              navigation = result.navigation ?? navigation;
              if (document.activeElement !== address) address.value = currentUrl;
              host!.querySelector<HTMLElement>('.cef-title')!.textContent = result.title || '';
              message.hidden = true; controls();
            }
          }
        } catch {
          if (!disposed) {
            connected = false; frameReady = false; controls();
            message.hidden = false; message.textContent = mode === 'stopped' ? 'Browser session ended.' : 'Browser disconnected. Restart the browser session to reconnect.';
          }
        }
        if (!disposed && mode !== 'stopped') refreshTimer = setTimeout(refresh, 300);
      }
      void refresh();
      return () => {
        disposed = true; resize.disconnect(); clearTimeout(resizeTimer); clearTimeout(refreshTimer);
        void request({ type: 'mode', value: 'human' }).catch(() => {}); host.replaceChildren();
      };
    }, { layout: 'workspace' });
    return '';
  });
}
