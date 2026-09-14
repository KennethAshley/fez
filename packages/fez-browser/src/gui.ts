import type { GuiExtensionApi } from '@fezchat/extension-api/gui';
import { openNativeBrowser } from './native-gui';
import settings from './gui.json';
import styles from '../prototype-cef/gui.css?inline';

export function activate(api: GuiExtensionApi) {
  const open = async (address = '') => {
    if (!api.nativeSurfaces || !await api.nativeSurfaces.available()) return 'Open this in a Fez build with the native browser enabled. Agent browser tools remain available through Camofox.';
    return openNativeBrowser(api, styles, address.trim());
  };
  api.registerGuiCommand('browser', open);
  api.registerSettingsPanel('browser', () => api.React.createElement('div', null,
    api.React.createElement('button', { type: 'button', onClick: () => { void open().then(message => { if (message) api.toast?.(message, 'info'); }); } }, 'Open browser'),
    api.renderSettings?.(JSON.stringify(settings)),
  ));
}
