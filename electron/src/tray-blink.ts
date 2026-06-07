import { nativeImage, type NativeImage, type Tray } from 'electron';

/** 托盘闪烁间隔（ms），接近微信观感 */
const BLINK_INTERVAL_MS = 500;

let trayRef: Tray | null = null;
let normalIcon: NativeImage | null = null;
let emptyIcon: NativeImage | null = null;
let blinkTimer: ReturnType<typeof setInterval> | null = null;
let showEmptyFrame = false;
let blinking = false;

function createEmptyTrayIcon(width: number, height: number): NativeImage {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const transparentBitmap = Buffer.alloc(safeWidth * safeHeight * 4, 0);
  return nativeImage.createFromBitmap(transparentBitmap, {
    width: safeWidth,
    height: safeHeight,
  });
}

/** 绑定托盘实例与正常态图标，仅 Windows 有效。 */
export function initTrayBlink(tray: Tray, normal: NativeImage): void {
  if (process.platform !== 'win32') return;
  trayRef = tray;
  normalIcon = normal;
  const { width, height } = normal.getSize();
  emptyIcon = createEmptyTrayIcon(width || 16, height || 16);
}

/** 停止闪烁并恢复原图标。 */
export function stopTrayBlink(): void {
  if (blinkTimer !== null) {
    clearInterval(blinkTimer);
    blinkTimer = null;
  }
  blinking = false;
  showEmptyFrame = false;
  if (trayRef && normalIcon && !normalIcon.isEmpty()) {
    trayRef.setImage(normalIcon);
  }
}

function tickBlinkFrame(): void {
  if (!trayRef || !normalIcon || !emptyIcon) return;
  showEmptyFrame = !showEmptyFrame;
  trayRef.setImage(showEmptyFrame ? emptyIcon : normalIcon);
}

/** 主窗口无焦点时启动闪烁；已在闪时不重置 interval。 */
export function notifyTrayIncoming(isMainWindowFocused: () => boolean): void {
  if (process.platform !== 'win32') return;
  if (isMainWindowFocused()) return;
  if (!trayRef || !normalIcon || !emptyIcon || normalIcon.isEmpty()) return;
  if (blinking) return;

  blinking = true;
  showEmptyFrame = false;
  trayRef.setImage(normalIcon);
  blinkTimer = setInterval(tickBlinkFrame, BLINK_INTERVAL_MS);
}
