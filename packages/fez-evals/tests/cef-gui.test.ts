// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { activate } from '../../fez-browser/prototype-cef/gui.ts';
import type { GuiExtensionApi } from '../../fez-extension-api/src/gui.js';

let dispose: (() => void) | undefined;
// jsdom has no canvas renderer. Color resolution is covered by tauri-cef.test;
// these tests exercise mounting, bounds and visibility through the real host API.
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '', fillRect: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray([29,32,33,255]) }),
  } as CanvasRenderingContext2D);
});
afterEach(() => { dispose?.(); dispose = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren(); Reflect.deleteProperty(document, 'elementFromPoint'); });

it('keeps native content visible beside the overlapping panel resize handle', async () => {
  const { nativeSlotVisible } = await import('../../fez-desktop/src/native-visibility');
  const slot = document.createElement('div'), handle = document.createElement('div');
  document.body.append(handle, slot);
  slot.getBoundingClientRect = () => new DOMRect(100, 100, 600, 500);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: (x: number) => x < 103 ? handle : slot });
  expect(nativeSlotVisible(slot)).toBe(true);
});

it('corrects native bounds when the extension moves during mounting', async () => {
  const { nativeSurfaces } = await import('../../fez-desktop/src/native-surfaces');
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  let finish!: (value: object) => void, resize = () => {};
  vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: () => 1,
    invoke: (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return command === 'native_surface_open' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(1);
    },
  });
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() { resize(); } disconnect() {} });
  const slot = document.createElement('div'); document.body.append(slot);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => slot });
  let rect = new DOMRect(0, 100, 1000, 600);
  slot.getBoundingClientRect = () => rect;
  const mounting = nativeSurfaces.mountBrowser(slot, () => {}, 'https://example.org/');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(calls.find(call => call.command === 'native_surface_open')?.args?.initialUrl).toBe('https://example.org/');
  rect = new DOMRect(0, 150, 800, 400);
  finish({ id: 'native', mode: 'human', url: '', title: '', canGoBack: false, canGoForward: false });
  const browser = await mounting;
  try {
    await vi.waitFor(() => expect(calls).toContainEqual({ command: 'native_surface_action', args: { id: 'native', action: { op: 'bounds', bounds: { x: 0, y: 150, width: 800, height: 400 }, visible: true } } }));
  } finally { await browser.close(); }
});

it('hides and revokes a native browser when a host overlay covers it without resizing', async () => {
  const { nativeSurfaces } = await import('../../fez-desktop/src/native-surfaces');
  const actions: Record<string, unknown>[] = [];
  vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: () => 1,
    invoke: async (command: string, args?: { action?: Record<string, unknown> }) => {
      if (command === 'native_surface_action') actions.push(args!.action!);
      return command === 'native_surface_open' ? { id: 'native', mode: 'human', url: '', title: '', canGoBack: false, canGoForward: false } : 1;
    },
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const slot = document.createElement('div'); document.body.append(slot);
  slot.getBoundingClientRect = () => new DOMRect(0, 100, 1000, 600);
  const overlay = document.createElement('dialog');
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => overlay.isConnected ? overlay : slot });
  const browser = await nativeSurfaces.mountBrowser(slot, () => {});
  try {
    document.body.append(overlay);
    await vi.waitFor(() => expect(actions).toContainEqual({ op: 'bounds', bounds: { x: 0, y: 100, width: 1000, height: 600 }, visible: false }));
    overlay.remove();
    await vi.waitFor(() => expect(actions.at(-1)).toMatchObject({ op: 'bounds', visible: true }));
  } finally { await browser.close(); }
});

it('uses the native host surface without screenshot polling or an extension-owned grant button', async () => {
  let run!: () => unknown;
  const calls: string[] = [];
  const host = document.createElement('div'); document.body.append(host);
  vi.stubGlobal('SESSION', { endpoint: 'http://127.0.0.1:1', uiToken: 'test' });
  vi.stubGlobal('STYLES', '');
  vi.stubGlobal('fetch', () => { throw new Error('Native browsing must not poll screenshots'); });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  activate({
    registerGuiCommand: (_name, fn) => { run = () => fn(''); },
    openPanel: (_name, render) => { const result = render(host); if (typeof result === 'function') dispose = result; },
    nativeSurfaces: {
      available: async () => true,
      mountBrowser: async (_slot, changed) => {
        calls.push('mount');
        changed({ id: 'native', mode: 'human', url: 'https://example.com/', title: 'Native page', canGoBack: false, canGoForward: false });
        return { navigate: async () => { calls.push('navigate'); }, history: async () => {}, reload: async () => {}, close: async () => { calls.push('close'); } };
      },
    },
  } as GuiExtensionApi);
  await run();
  await vi.waitFor(() => expect(calls).toContain('mount'));
  expect(host.querySelector('img')).toBeNull();
  expect(host.querySelector('[data-control]')).toBeNull();
  expect(host.querySelector('input')?.value).toBe('https://example.com/');
  dispose?.(); dispose = undefined;
  await vi.waitFor(() => expect(calls).toContain('close'));
});

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
