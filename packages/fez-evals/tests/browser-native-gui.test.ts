// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GuiExtensionApi, NativeBrowser, NativeSurfaceState } from '../../fez-extension-api/src/gui.js';
import { openNativeBrowser } from '../../fez-browser/src/native-gui';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); });

it('shows the shared driver and waiting agents, with one owner pause/resume control', async () => {
  document.body.innerHTML = readFileSync(resolve(__dirname, '../../fez-browser/prototype-tauri-cef/ui/owner.html'), 'utf8');
  const calls: string[] = [];
  let update!: (event: { payload: object }) => void;
  const ownerWindow = { __TAURI__: {
    core: { invoke: async (_command: string, args: { action: string }) => {
      calls.push(args.action);
      return { id: 'browser-1', mode: 'human', queued: true, paused: args.action !== 'resume', waiting: ['drift'] };
    } },
    event: { listen: async (_name: string, callback: typeof update) => { update = callback; } },
  } };
  new Function('window', 'document', readFileSync(resolve(__dirname, '../../fez-browser/prototype-tauri-cef/ui/owner.js'), 'utf8'))(ownerWindow, document);
  await vi.waitFor(() => expect(document.querySelector('#control')!.textContent).toBe('Resume agents'));
  update({ payload: { id: 'browser-1', mode: 'agent', queued: true, paused: false, agentName: 'quill', waiting: ['drift'] } });
  expect(document.querySelector('#state')!.textContent).toBe('@quill driving');
  expect(document.querySelector('#waiting')!.textContent).toContain('@drift waiting');
  document.querySelector<HTMLButtonElement>('#control')!.click();
  await vi.waitFor(() => expect(calls.at(-1)).toBe('take'));
  expect(document.querySelector('#state')!.textContent).toBe('You have control');
  document.querySelector<HTMLButtonElement>('#control')!.click();
  await vi.waitFor(() => expect(calls.at(-1)).toBe('resume'));
  expect(document.querySelector('select')).toBeNull();
});

it('cancels the exact waiter without surface authority and ignores other browser events', async () => {
  document.body.innerHTML = readFileSync(resolve(__dirname, '../../fez-browser/prototype-tauri-cef/ui/owner.html'), 'utf8');
  const calls: object[] = [], order: string[] = [];
  let update!: (event: { payload: object }) => void;
  let connected!: (state: object) => void;
  const state = { id: 'browser-1', mode: 'agent', queued: true, paused: false, agentName: 'quill', waiting: ['drift'],
    waitingEntries: [{ request: 'request-17', persona: 'drift' }] };
  const ownerWindow = { __TAURI__: {
    core: { invoke: async (command: string, args: { action: string }) => {
      expect(command).toBe('native_surface_owner');
      order.push(args.action); calls.push(args);
      if (args.action === 'state') return new Promise(resolve => { connected = resolve; });
      return { ...state, waiting: [], waitingEntries: [] };
    } },
    event: { listen: async (_name: string, callback: typeof update) => { order.push('listen'); update = callback; } },
  } };
  new Function('window', 'document', readFileSync(resolve(__dirname, '../../fez-browser/prototype-tauri-cef/ui/owner.js'), 'utf8'))(ownerWindow, document);
  update({ payload: { ...state, id: 'other-browser', agentName: 'stranger' } });
  expect(document.querySelector('#state')!.textContent).not.toContain('stranger');
  await vi.waitFor(() => expect(order).toEqual(['listen', 'state']));
  connected(state);
  await vi.waitFor(() => expect(document.querySelector('#state')!.textContent).toBe('@quill driving'));
  update({ payload: { ...state, id: 'other-browser', mode: 'human', waitingEntries: [] } });
  expect(document.querySelector('#state')!.textContent).toBe('@quill driving');
  const cancel = document.querySelector<HTMLButtonElement>('#waiting button')!;
  expect(cancel).not.toBeNull();
  expect(document.querySelectorAll('#waiting button')).toHaveLength(1);
  expect(cancel.getAttribute('aria-label')).toContain('drift');
  cancel.click();
  await vi.waitFor(() => expect(calls.at(-1)).toEqual({ action: 'cancel', request: 'request-17', persona: 'drift' }));
  await vi.waitFor(() => expect(document.querySelectorAll('#waiting button')).toHaveLength(0));
});

it('can cancel a later request from the driving persona without interrupting its active turn', async () => {
  document.body.innerHTML = readFileSync(resolve(__dirname, '../../fez-browser/prototype-tauri-cef/ui/owner.html'), 'utf8');
  const calls: object[] = [];
  const state = { id: 'browser-1', mode: 'agent', queued: true, paused: false, agentName: 'quill', waiting: ['quill'],
    waitingEntries: [{ request: 'later-message-request', persona: 'quill' }] };
  const ownerWindow = { __TAURI__: {
    core: { invoke: async (_command: string, args: { action: string }) => {
      calls.push(args);
      return args.action === 'state' ? state : { ...state, waiting: [], waitingEntries: [] };
    } },
    event: { listen: async () => {} },
  } };
  new Function('window', 'document', readFileSync(resolve(__dirname, '../../fez-browser/prototype-tauri-cef/ui/owner.js'), 'utf8'))(ownerWindow, document);
  await vi.waitFor(() => expect(document.querySelector('#state')!.textContent).toBe('@quill driving'));
  const cancel = document.querySelector<HTMLButtonElement>('#waiting button');
  expect(cancel).not.toBeNull();
  cancel!.click();
  await vi.waitFor(() => expect(calls.at(-1)).toEqual({ action: 'cancel', request: 'later-message-request', persona: 'quill' }));
  expect(document.querySelector('#state')!.textContent).toBe('@quill driving');
  expect(calls).toHaveLength(2);
});

it('mounts visible independent browser panes and closes only the chosen session', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const actions: [number, string, unknown?][] = [];
  const changes: ((state: NativeSurfaceState) => void)[] = [];
  let panels = 0;
  openNativeBrowser({
    openPanel: (_title, render, options) => {
      panels++; expect(options?.layout).toBe('workspace');
      const result = render(host); if (typeof result === 'function') dispose = result;
    },
    nativeSurfaces: {
      available: async () => true,
      mountBrowser: async (slot, changed) => {
        expect(slot.isConnected).toBe(true);
        const id = changes.push(changed);
        changed({ id: `browser-${id}`, mode: 'human', url: `https://example.com/${id}`, title: `Page ${id}`, canGoBack: true, canGoForward: false });
        return { navigate: async url => { actions.push([id, 'navigate', url]); }, history: async delta => { actions.push([id, 'history', delta]); },
          reload: async () => { actions.push([id, 'reload']); }, close: async () => { actions.push([id, 'close']); } };
      },
    },
  }, '');
  const add = host.querySelector<HTMLButtonElement>('[data-new-browser]');
  expect(add).not.toBeNull();
  add!.click();
  await vi.waitFor(() => expect(changes).toHaveLength(2));
  const panes = host.querySelectorAll<HTMLElement>('.cef-browser');
  expect(panels).toBe(1);
  expect([...panes].map(p => p.dataset.surfaceId)).toEqual(['browser-1', 'browser-2']);
  expect([...panes].every(p => !p.hidden)).toBe(true);
  changes[1]({ id: 'browser-2', mode: 'agent', url: 'https://example.com/2', title: 'Second', canGoBack: true, canGoForward: false });
  expect(panes[0].querySelector('input')!.disabled).toBe(false);
  expect(panes[1].querySelector('input')!.disabled).toBe(true);
  panes[0].querySelector('input')!.value = 'first.example';
  panes[0].querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  changes[1]({ id: 'browser-2', mode: 'human', url: 'https://example.com/2', title: 'Second', canGoBack: true, canGoForward: false });
  panes[1].querySelector<HTMLButtonElement>('[data-nav=back]')!.click();
  panes[1].querySelector<HTMLButtonElement>('[data-nav=reload]')!.click();
  await vi.waitFor(() => expect(actions).toEqual([[1, 'navigate', 'https://first.example'], [2, 'history', -1], [2, 'reload']]));
  panes[0].querySelector<HTMLButtonElement>('[data-close-browser]')!.click();
  await vi.waitFor(() => expect(actions.at(-1)).toEqual([1, 'close']));
  expect(host.querySelectorAll('.cef-browser')).toHaveLength(1);
  expect(host.querySelector<HTMLElement>('.cef-browser')!.dataset.surfaceId).toBe('browser-2');
  add!.click(); add!.click(); add!.click(); add!.click();
  expect(host.querySelectorAll('.cef-browser')).toHaveLength(4);
  expect(add!.disabled).toBe(true);
  dispose?.(); dispose = undefined;
  await vi.waitFor(() => expect(actions.filter(([, action]) => action === 'close').map(([id]) => id).sort()).toEqual([1, 2, 3, 4, 5]));
});

it('closes mounts that finish after their pane or workspace was removed', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const finish: ((browser: NativeBrowser) => void)[] = [];
  const closed: number[] = [], navigated: string[] = [];
  openNativeBrowser({
    openPanel: (_title, render) => { const result = render(host); if (typeof result === 'function') dispose = result; },
    nativeSurfaces: { available: async () => true, mountBrowser: () => new Promise(resolve => { finish.push(resolve); }) },
  }, '', 'never-open.example');
  const close = host.querySelector<HTMLButtonElement>('[data-close-browser]');
  expect(close).not.toBeNull();
  host.querySelector<HTMLButtonElement>('[data-new-browser]')!.click();
  close!.click();
  expect(host.querySelectorAll('.cef-browser')).toHaveLength(1);
  dispose?.(); dispose = undefined;
  finish.forEach((resolve, index) => resolve({ navigate: async url => { navigated.push(url); }, history: async () => {}, reload: async () => {}, close: async () => { closed.push(index); } }));
  await vi.waitFor(() => expect(closed.sort()).toEqual([0, 1]));
  expect(navigated).toEqual([]);
  expect(host.children).toHaveLength(0);
});

it('keeps navigation usable after a navigation fails', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const urls: string[] = [];
  openNativeBrowser({
    openPanel: (_title, render) => { const result = render(host); if (typeof result === 'function') dispose = result; },
    nativeSurfaces: { available: async () => true, mountBrowser: async (_slot, changed) => {
      changed({ id: 'browser', mode: 'human', url: 'about:blank', title: '', canGoBack: false, canGoForward: false });
      return { navigate: async url => { urls.push(url); if (url.endsWith('bad.example')) throw new Error('Navigation failed'); }, history: async () => {}, reload: async () => {}, close: async () => {} };
    } },
  }, '');
  host.querySelector('input')!.value = 'bad.example';
  host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(host.querySelector('[role=alert]')!.textContent).toContain('Navigation failed'));
  host.querySelector('input')!.value = 'good.example';
  host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(urls).toEqual(['https://bad.example', 'https://good.example']));
});

it('creates the packaged browser at its requested URL without racing a second navigation', async () => {
  const { activate } = await import('../../fez-browser/src/gui');
  const commands = new Map<string, (args: string) => string | Promise<string>>();
  const urls: string[] = [];
  const mounts: (string | undefined)[] = [];
  let closes = 0;
  const host = document.createElement('div'); document.body.append(host);
  activate({
    registerGuiCommand: (name, run) => { commands.set(name, run); },
    registerSettingsPanel: () => {},
    openPanel: (_title, render) => { const result = render(host); if (typeof result === 'function') dispose = result; },
    nativeSurfaces: {
      available: async () => true,
      mountBrowser: async (_slot, changed, initialUrl) => {
        mounts.push(initialUrl);
        changed({ id: 'browser', mode: 'human', url: initialUrl || 'https://example.com/', title: '', canGoBack: false, canGoForward: false });
        return { navigate: async url => { urls.push(url); }, history: async () => {}, reload: async () => {}, close: async () => { closes++; } };
      },
    },
  } as GuiExtensionApi);
  expect(commands.has('browser')).toBe(true);
  expect(await commands.get('browser')!('example.org')).toBe('');
  await vi.waitFor(() => expect(mounts).toEqual(['https://example.org']));
  expect(urls).toEqual([]);
  expect(host.querySelector('input')!.value).toBe('https://example.org');
  expect(host.querySelector('img')).toBeNull();
  dispose?.(); dispose = undefined;
  await vi.waitFor(() => expect(closes).toBe(1));
});

it('reports native runtime unavailability without opening a broken pane', async () => {
  const { activate } = await import('../../fez-browser/src/gui');
  let run!: (args: string) => string | Promise<string>;
  let opened = false;
  activate({ registerGuiCommand: (_name, command) => { run = command; }, registerSettingsPanel: () => {},
    openPanel: () => { opened = true; }, nativeSurfaces: { available: async () => false },
  } as GuiExtensionApi);
  expect(await run('')).toMatch(/native browser/i);
  expect(opened).toBe(false);
});
