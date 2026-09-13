// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { activate } from '../../fez-browser/prototype-cef/gui.ts';
import type { GuiExtensionApi } from '../../fez-extension-api/src/gui.js';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren(); });

async function mountBrowser(reply?: (action: Record<string, unknown>) => object | Promise<object>) {
  const actions: Record<string, unknown>[] = [];
  let resized = () => {};
  vi.stubGlobal('SESSION', { endpoint: 'http://localhost:1234', uiToken: 'test' });
  vi.stubGlobal('STYLES', '');
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} });
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const action = JSON.parse(String(init.body)); actions.push(action);
    return { ok: true, json: async () => reply ? reply(action) : ({ mode: 'human', ...(action.type === 'observe' ? {
      data: 'test-image', viewport: { clientWidth: 1000, clientHeight: 700 }, url: 'https://example.com', title: 'Example', navigation: { canGoBack: false, canGoForward: false },
    } : {}) }) };
  });
  const host = document.createElement('div'); document.body.append(host);
  let open!: () => string | Promise<string>;
  activate({
    registerGuiCommand: (_name, run) => { open = () => run(''); },
    openPanel: (_title, render) => { const result = render(host); if (typeof result === 'function') dispose = () => result(); },
  } as GuiExtensionApi);
  await open();
  const image = host.querySelector('img')!;
  image.decode = async () => {};
  await vi.waitFor(() => expect(image.src).toContain('test-image'));
  return { host, image, actions, resize: () => resized() };
}

it('maps clicks within a fitted frame and ignores the blank space below it', async () => {
  const { image, actions } = await mountBrowser();
  image.getBoundingClientRect = () => new DOMRect(10, 20, 500, 400);
  image.dispatchEvent(new MouseEvent('click', { clientX: 110, clientY: 120 }));
  await vi.waitFor(() => expect(actions.find(a => a.type === 'click')).toEqual({ type: 'click', x: 200, y: 200 }));
  const count = actions.filter(a => a.type === 'click').length;
  image.dispatchEvent(new MouseEvent('click', { clientX: 110, clientY: 400 }));
  await Promise.resolve();
  expect(actions.filter(a => a.type === 'click')).toHaveLength(count);
});

it('keeps takeover and Stop available when agent screenshots fail', async () => {
  let mode = 'human';
  const { host, actions } = await mountBrowser(action => {
    if (action.type === 'mode') mode = String(action.value);
    return { mode, ...(action.type === 'observe' ? mode === 'agent' ? { error: 'Screenshot timed out' } : {
      data: 'test-image', viewport: { clientWidth: 1000, clientHeight: 700 },
    } : {}) };
  });
  const control = host.querySelector<HTMLButtonElement>('[data-control]')!;
  control.click();
  await vi.waitFor(() => expect(host.querySelector('[role=status]')!.textContent).toBe('Disconnected'));
  expect(control.textContent).toBe('Take control');
  expect(control.disabled).toBe(false);
  expect(host.querySelector<HTMLButtonElement>('.cef-stop')!.disabled).toBe(false);
  control.click();
  await vi.waitFor(() => expect(actions).toContainEqual({ type: 'mode', value: 'human' }));
});

it('discards a capture overlapping resize and blocks clicks until the next frame', async () => {
  let width = 1000;
  let captureCount = 0;
  let releaseStale: (() => void) | undefined;
  let releaseFresh: (() => void) | undefined;
  const { host, image, actions, resize } = await mountBrowser(async action => {
    if (action.type === 'resize') width = Number(action.width);
    if (action.type !== 'observe') return { mode: 'human' };
    const capturedWidth = width;
    captureCount++;
    if (captureCount === 2) await new Promise<void>(resolve => { releaseStale = resolve; });
    if (captureCount === 3) await new Promise<void>(resolve => { releaseFresh = resolve; });
    return { mode: 'human', data: `test-image-${captureCount}`, viewport: { clientWidth: capturedWidth, clientHeight: 700 } };
  });
  await vi.waitFor(() => expect(releaseStale).toBeTypeOf('function'));
  image.getBoundingClientRect = () => new DOMRect(0, 0, 500, 700);
  host.querySelector<HTMLElement>('.cef-viewport')!.getBoundingClientRect = image.getBoundingClientRect;
  resize();
  await vi.waitFor(() => expect(actions).toContainEqual({ type: 'resize', width: 500, height: 700 }));
  image.dispatchEvent(new MouseEvent('click', { clientX: 200, clientY: 100 }));
  releaseStale!();
  await vi.waitFor(() => expect(releaseFresh).toBeTypeOf('function'));
  expect(actions.some(a => a.type === 'click')).toBe(false);
  expect(image.src).toContain('test-image-1');
  releaseFresh!();
  await vi.waitFor(() => expect(image.src).toContain('test-image-3'));
  image.dispatchEvent(new MouseEvent('click', { clientX: 200, clientY: 100 }));
  await vi.waitFor(() => expect(actions).toContainEqual({ type: 'click', x: 200, y: 100 }));
});

it('invalidates a frame when resize is appended while capture awaits earlier input', async () => {
  vi.useFakeTimers();
  let width = 1000;
  let captureCount = 0;
  let releaseReload: (() => void) | undefined;
  const { host, image, actions, resize } = await mountBrowser(async action => {
    if (action.type === 'reload') await new Promise<void>(resolve => { releaseReload = resolve; });
    if (action.type === 'resize') width = Number(action.width);
    return { mode: 'human', ...(action.type === 'observe' ? {
      data: `test-image-${++captureCount}`, viewport: { clientWidth: width, clientHeight: 700 },
    } : {}) };
  });
  host.querySelector<HTMLButtonElement>('[data-nav=reload]')!.click();
  await vi.waitFor(() => expect(releaseReload).toBeTypeOf('function'));
  await vi.advanceTimersByTimeAsync(300);
  image.getBoundingClientRect = () => new DOMRect(0, 0, 500, 700);
  host.querySelector<HTMLElement>('.cef-viewport')!.getBoundingClientRect = image.getBoundingClientRect;
  resize();
  await vi.advanceTimersByTimeAsync(120);
  releaseReload!();
  await vi.advanceTimersByTimeAsync(0);
  expect(actions.map(a => a.type)).toEqual(['observe', 'reload', 'observe', 'resize']);
  image.dispatchEvent(new MouseEvent('click', { clientX: 200, clientY: 100 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(actions.some(a => a.type === 'click')).toBe(false);
  expect(image.src).toContain('test-image-1');
  await vi.advanceTimersByTimeAsync(300);
  expect(image.src).toContain('test-image-3');
  image.dispatchEvent(new MouseEvent('click', { clientX: 200, clientY: 100 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(actions).toContainEqual({ type: 'click', x: 200, y: 100 });
});
