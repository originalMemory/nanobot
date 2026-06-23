/** PSB 全屏鼠标追踪：主进程节流与坐标换算（可单测）。 */

export const MOUSE_TRACK_INTERVAL_MS = 33;

export function shouldForwardMouse(input: {
  followMouse: boolean;
  windowVisible: boolean;
  windowDestroyed: boolean;
}): boolean {
  return input.followMouse && input.windowVisible && !input.windowDestroyed;
}

export function screenToContentPoint(
  screen: { x: number; y: number },
  contentBounds: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: screen.x - contentBounds.x,
    y: screen.y - contentBounds.y,
  };
}
