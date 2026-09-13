/** Leave room for the conversation when interactive content takes a wide pane. */
export function workspacePaneWidth(windowWidth: number, railWidth: number, requested?: number): number {
  const available = Math.max(0, windowWidth - railWidth - 10);
  const minimum = Math.min(360, available / 2);
  return Math.round(Math.min(available - minimum, Math.max(minimum, requested ?? available * 0.55)));
}
