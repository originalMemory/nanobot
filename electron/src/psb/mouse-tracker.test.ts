/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';

import { screenToContentPoint, shouldForwardMouse } from './mouse-tracker';

describe('shouldForwardMouse', () => {
  it('forwards only when followMouse is on and window is visible', () => {
    expect(
      shouldForwardMouse({ followMouse: true, windowVisible: true, windowDestroyed: false }),
    ).toBe(true);
    expect(
      shouldForwardMouse({ followMouse: false, windowVisible: true, windowDestroyed: false }),
    ).toBe(false);
    expect(
      shouldForwardMouse({ followMouse: true, windowVisible: false, windowDestroyed: false }),
    ).toBe(false);
  });
});

describe('screenToContentPoint', () => {
  it('converts screen coordinates into window content space', () => {
    expect(screenToContentPoint({ x: 150, y: 260 }, { x: 100, y: 200 })).toEqual({
      x: 50,
      y: 60,
    });
  });
});
