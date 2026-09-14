import type { GuiExtensionApi, NativeBrowser } from '@fezchat/extension-api/gui';

/** Uses the host's native surface; browser behavior and presentation stay here. */
export function openNativeBrowser(api: Pick<GuiExtensionApi, 'openPanel' | 'nativeSurfaces'>, styles: string, initialUrl = '') {
  if (!api.openPanel || !api.nativeSurfaces) return 'This Fez build has no native browser surface.';
  const native = api.nativeSurfaces;
  api.openPanel('Browser', host => {
    if (!host) return;
    host.innerHTML = `<style>${styles}</style><section class="cef-browsers" aria-label="Browsers">
      <div class="cef-browsers-toolbar"><span>Browsers</span><button type="button" data-new-browser>New browser</button></div>
      <div class="cef-panes"></div></section>`;
    const panes = host.querySelector<HTMLElement>('.cef-panes')!;
    const add = host.querySelector<HTMLButtonElement>('[data-new-browser]')!;
    const closers = new Set<() => void>();
    let disposed = false, sequence = 0;
    function open(url = '') {
      if (disposed || closers.size === 4) return;
      const pane = document.createElement('section');
      pane.className = 'cef-browser';
      pane.innerHTML = `<div class="cef-pane-heading"><span class="cef-pane-label"></span><button type="button" data-close-browser aria-label="Close browser">×</button></div>
        <div class="cef-toolbar"><div class="cef-navigation"><button data-nav="back" aria-label="Back" disabled>←</button><button data-nav="forward" aria-label="Forward" disabled>→</button><button data-nav="reload" aria-label="Reload page" disabled>↻</button></div>
        <form class="cef-address"><input aria-label="Website address" placeholder="Enter a website" autocomplete="off" spellcheck="false" disabled><button disabled>Go</button></form></div>
        <div class="cef-notice" role="alert" hidden></div><div class="cef-viewport"></div>
        <div class="cef-footer"><span role="status">Opening browser…</span><span class="cef-title"></span></div>`;
      const label = pane.querySelector<HTMLElement>('.cef-pane-label')!;
      label.textContent = `Browser ${++sequence}`;
      pane.setAttribute('aria-label', label.textContent);
      const address = pane.querySelector('input')!;
      const status = pane.querySelector<HTMLElement>('[role=status]')!;
      const title = pane.querySelector<HTMLElement>('.cef-title')!;
      const notice = pane.querySelector<HTMLElement>('[role=alert]')!;
      const back = pane.querySelector<HTMLButtonElement>('[data-nav=back]')!;
      const forward = pane.querySelector<HTMLButtonElement>('[data-nav=forward]')!;
      const reload = pane.querySelector<HTMLButtonElement>('[data-nav=reload]')!;
      let closed = false, surface: NativeBrowser | undefined;
      const failed = (error: unknown) => { if (!closed) { notice.textContent = String(error); notice.hidden = false; } };
      const close = () => {
        if (closed) return;
        closed = true; closers.delete(close); pane.remove(); add.disabled = false;
        void surface?.close().catch(() => {});
      };
      closers.add(close); add.disabled = closers.size === 4; panes.append(pane);
      pane.querySelector<HTMLButtonElement>('[data-close-browser]')!.onclick = close;
      const normalize = (text: string) => text.includes('://') ? text : `https://${text}`;
      const ready = native.mountBrowser(pane.querySelector('.cef-viewport')!, state => {
        if (closed) return;
        pane.dataset.surfaceId = state.id; pane.dataset.mode = state.mode;
        if (state.label) { label.textContent = state.label; pane.setAttribute('aria-label', state.label); }
        if (document.activeElement !== address) address.value = state.url;
        title.textContent = state.title;
        const human = state.mode === 'human';
        address.disabled = reload.disabled = pane.querySelector<HTMLButtonElement>('form button')!.disabled = !human;
        back.disabled = !human || !state.canGoBack; forward.disabled = !human || !state.canGoForward;
        status.textContent = state.mode === 'agent' ? 'Agent has control' : human ? 'You have control' : 'Browser closed';
      }, url ? normalize(url) : undefined).then(async value => {
        surface = value;
        if (closed) await value.close();
        return value;
      });
      void ready.catch(failed);
      const run = (fn: (browser: NativeBrowser) => Promise<void>) => { notice.hidden = true; void ready.then(browser => closed ? undefined : fn(browser)).catch(failed); };
      const navigate = (text: string) => run(browser => browser.navigate(normalize(text)));
      pane.querySelector('form')!.onsubmit = event => {
        event.preventDefault();
        const text = address.value.trim();
        if (text) navigate(text);
        address.blur();
      };
      back.onclick = () => run(browser => browser.history(-1));
      forward.onclick = () => run(browser => browser.history(1));
      reload.onclick = () => run(browser => browser.reload());
    }
    add.onclick = () => open();
    open(initialUrl);
    return () => { disposed = true; for (const close of closers) close(); host.replaceChildren(); };
  }, { layout: 'workspace' });
  return '';
}
