import { nativeSurfaces } from '../../../fez-desktop/src/native-surfaces';
import { openNativeBrowser } from '../../src/native-gui';
declare const STYLES: string;
const workspace = document.querySelector<HTMLElement>('#workspace')!;
let dispose: (() => void) | undefined;
const close = () => { dispose?.(); dispose = undefined; };
const open = () => {
  if (dispose && workspace.querySelector<HTMLElement>('.cef-browser')?.dataset.mode !== 'stopped') return;
  close();
  openNativeBrowser({ nativeSurfaces, openPanel(_title, render) { dispose = render(workspace) || undefined; } }, STYLES);
};
document.querySelector<HTMLButtonElement>('#open')!.onclick = open;
document.querySelector<HTMLButtonElement>('#close')!.onclick = close;
open();
