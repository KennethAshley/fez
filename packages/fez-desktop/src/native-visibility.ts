/** Native views sit above the DOM, so host overlays must hide their slots. */
export function nativeSlotVisible(element: HTMLElement, rect = element.getBoundingClientRect()): boolean {
  const { x, y, width, height } = rect;
  const doc = element.ownerDocument;
  // Resize handles overlap adjacent panes by 3px; sample their interior.
  const insetX = Math.min(8, width / 2), insetY = Math.min(8, height / 2);
  return element.isConnected && doc.visibilityState !== 'hidden' && width > 0 && height > 0 &&
    [[x + insetX, y + insetY], [x + width / 2, y + height / 2], [x + width - insetX, y + height - insetY]]
      .every(([left, top]) => element.contains(doc.elementFromPoint(left, top)));
}
