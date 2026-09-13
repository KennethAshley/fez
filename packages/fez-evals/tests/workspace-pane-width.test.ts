import { expect, it } from 'vitest';
import { workspacePaneWidth } from '../../fez-desktop/src/workspace-pane-width.js';

it('shares a large workspace and keeps both columns visible at the drag limits', () => {
  expect(workspacePaneWidth(1450, 240)).toBe(660);
  expect(workspacePaneWidth(1450, 240, 5000)).toBe(840);
  expect(workspacePaneWidth(1450, 240, -500)).toBe(360);
  expect(workspacePaneWidth(800, 240, 5000)).toBe(275);
});
