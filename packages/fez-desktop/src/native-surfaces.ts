import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { nativeSlotVisible } from './native-visibility';
import { BUILT_IN_DEFAULT } from './theme-default';

export interface NativeSurfaceState {
  id: string; label?: string; mode: 'human' | 'agent' | 'stopped'; url: string; title: string;
  canGoBack: boolean; canGoForward: boolean;
}
export interface NativeBrowser {
  navigate(url: string): Promise<void>;
  history(delta: -1 | 1): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
}
export interface NativeSurfaceApi {
  available(): Promise<boolean>;
  /** Mounts a native view and host-owned handoff controls. No grant method is exposed. */
  mountBrowser(slot: HTMLElement, changed: (state: NativeSurfaceState) => void, initialUrl?: string): Promise<NativeBrowser>;
}

export const nativeSurfaces: NativeSurfaceApi = {
  available: () => invoke<boolean>('native_surface_available').catch(() => false),
  async mountBrowser(slot, changed, initialUrl) {
    let id = '', closed = false, previous = '', previousPalette = '', timer: ReturnType<typeof setTimeout> | undefined;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Native browser theme colors are unavailable');
    const palette = () => {
      const styles = getComputedStyle(document.documentElement);
      // Let the browser resolve CSS colors, including custom themes and alpha.
      context.fillStyle = BUILT_IN_DEFAULT.dark['--bg0']; context.fillRect(0, 0, 1, 1);
      const color = (token: '--bg0' | '--fg') => {
        context.fillStyle = BUILT_IN_DEFAULT.dark[token];
        context.fillStyle = styles.getPropertyValue(token).trim() || BUILT_IN_DEFAULT.dark[token];
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      };
      return { background: color('--bg0'), foreground: color('--fg') };
    };
    const bounds = () => {
      const { x, y, width, height } = slot.getBoundingClientRect();
      return { x, y, width, height };
    };
    const action = (op: string, args: object = {}) => invoke<void>('native_surface_action', { id, action: { op, ...args } });
    const unlisten = await listen<NativeSurfaceState>('native-surface', ({ payload }) => {
      if (!closed && payload.id === id) changed(payload);
    });
    try {
      const initial = bounds();
      const initialPalette = palette();
      const state = await invoke<NativeSurfaceState>('native_surface_open', { bounds: initial, palette: initialPalette, initialUrl });
      id = state.id;
      previous = JSON.stringify([initial, true]);
      previousPalette = JSON.stringify(initialPalette);
      changed(state);
    } catch (error) { unlisten(); throw error; }
    function layout() {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (closed) return;
        const colors = palette();
        const paletteKey = JSON.stringify(colors);
        if (paletteKey !== previousPalette) {
          previousPalette = paletteKey;
          void action('palette', { palette: colors }).catch(error => console.warn('Native cursor theme unavailable', error));
        }
        const rect = bounds();
        const visible = nativeSlotVisible(slot);
        const key = JSON.stringify([rect, visible]);
        if (key === previous) return;
        previous = key;
        void action('bounds', { bounds: rect, visible }).catch(() => {
          if (!closed) changed({ id, mode: 'stopped', url: '', title: 'Native browser disconnected', canGoBack: false, canGoForward: false });
        });
      }, 30);
    }
    const observer = new ResizeObserver(layout);
    observer.observe(slot);
    const mutations = new MutationObserver(layout);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true });
    mutations.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-scheme'] });
    layout();
    window.addEventListener('scroll', layout, true);
    document.addEventListener('visibilitychange', layout);
    return {
      navigate: url => action('navigate', { url }),
      history: delta => action('history', { delta }),
      reload: () => action('reload'),
      async close() {
        if (closed) return;
        closed = true;
        clearTimeout(timer); observer.disconnect(); mutations.disconnect(); unlisten();
        window.removeEventListener('scroll', layout, true);
        document.removeEventListener('visibilitychange', layout);
        await action('close');
      },
    };
  },
};
