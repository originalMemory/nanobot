import type { NativeImage, ProgressBarOptions, Tray } from 'electron';

const STREAMING_INTERVAL_MS = 800;
const UNREAD_INTERVAL_MS = 600;

export interface TrayStatusIcons {
  idle: NativeImage;
  streaming: NativeImage;
  streamingAlt: NativeImage;
  unread: NativeImage;
  unreadOverlay: NativeImage;
}

interface TrayStatusWindow {
  isDestroyed(): boolean;
  setProgressBar(progress: number, options?: ProgressBarOptions): void;
  setOverlayIcon(overlay: NativeImage | null, description: string): void;
}

let trayRef: Tray | null = null;
let iconsRef: TrayStatusIcons | null = null;
let getMainWindowRef: (() => TrayStatusWindow | null) | null = null;
let platformRef: NodeJS.Platform = process.platform;
let animationTimer: ReturnType<typeof setInterval> | null = null;
let alternateFrame = false;
let streaming = false;
let unread = false;

function clearAnimation(): void {
  if (animationTimer !== null) {
    clearInterval(animationTimer);
    animationTimer = null;
  }
  alternateFrame = false;
}

function setTrayImage(image: NativeImage): void {
  if (!trayRef || trayRef.isDestroyed() || image.isEmpty()) return;
  trayRef.setImage(image);
}

function updateTaskbar(): void {
  if (platformRef !== 'win32') return;
  const window = getMainWindowRef?.();
  if (!window || window.isDestroyed()) return;

  if (streaming) {
    window.setProgressBar(2, { mode: 'indeterminate' });
  } else {
    window.setProgressBar(-1);
  }

  const overlay = unread ? iconsRef?.unreadOverlay : null;
  window.setOverlayIcon(overlay && !overlay.isEmpty() ? overlay : null, unread ? 'Nanobot · 有新回复' : '');
}

function updateTooltip(): void {
  if (!trayRef || trayRef.isDestroyed()) return;
  trayRef.setToolTip(unread ? 'Nanobot · 有新回复' : streaming ? 'Nanobot · 正在回复' : 'Nanobot');
}

function renderAnimationFrame(): void {
  if (!iconsRef) return;
  alternateFrame = !alternateFrame;
  if (unread) {
    setTrayImage(alternateFrame ? iconsRef.unread : iconsRef.idle);
    return;
  }
  if (streaming) {
    setTrayImage(alternateFrame ? iconsRef.streamingAlt : iconsRef.streaming);
  }
}

function renderStatus(): void {
  clearAnimation();
  updateTooltip();
  updateTaskbar();
  if (!iconsRef) return;

  if (unread) {
    setTrayImage(iconsRef.unread);
    animationTimer = setInterval(renderAnimationFrame, UNREAD_INTERVAL_MS);
    return;
  }
  if (streaming) {
    setTrayImage(iconsRef.streaming);
    animationTimer = setInterval(renderAnimationFrame, STREAMING_INTERVAL_MS);
    return;
  }
  setTrayImage(iconsRef.idle);
}

/** 绑定菜单栏/托盘实例。重复初始化时先清理旧状态。 */
export function initTrayStatus(
  tray: Tray,
  icons: TrayStatusIcons,
  getMainWindow: () => TrayStatusWindow | null,
  platform: NodeJS.Platform = process.platform,
): void {
  disposeTrayStatus();
  trayRef = tray;
  iconsRef = icons;
  getMainWindowRef = getMainWindow;
  platformRef = platform;
  renderStatus();
}

/** 同步聚合后的流式状态；状态未变化时不重置动画。 */
export function setTrayStreaming(active: boolean): void {
  if (streaming === active) return;
  streaming = active;
  renderStatus();
}

/** Windows 隐藏窗口后会丢失任务栏进度，窗口恢复时重放缓存状态。 */
export function refreshTrayStatus(): void {
  updateTaskbar();
}

/** 窗口无焦点时标记未读；由 main 进程负责最终焦点判断。 */
export function notifyTrayIncoming(): void {
  if (unread) return;
  unread = true;
  renderStatus();
}

/** 清除未读；仍在流式时自动回到工作态。 */
export function clearTrayUnread(): void {
  if (!unread) return;
  unread = false;
  renderStatus();
}

/** 清理定时器、任务栏状态并恢复空闲图标。 */
export function disposeTrayStatus(): void {
  clearAnimation();
  streaming = false;
  unread = false;
  updateTaskbar();
  if (iconsRef) setTrayImage(iconsRef.idle);
  trayRef = null;
  iconsRef = null;
  getMainWindowRef = null;
  platformRef = process.platform;
}
