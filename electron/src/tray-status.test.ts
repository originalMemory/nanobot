/**
 * @vitest-environment node
 */
import type { BrowserWindow, NativeImage, Tray } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearTrayUnread,
  disposeTrayStatus,
  initTrayStatus,
  notifyTrayIncoming,
  setTrayStreaming,
  type TrayStatusIcons,
} from './tray-status';

function image(name: string): NativeImage {
  return {
    isEmpty: vi.fn(() => false),
    toString: () => name,
  } as unknown as NativeImage;
}

function setup(platform: NodeJS.Platform = 'win32') {
  const icons: TrayStatusIcons = {
    idle: image('idle'),
    streaming: image('streaming'),
    streamingAlt: image('streaming-alt'),
    unread: image('unread'),
    unreadOverlay: image('unread-overlay'),
  };
  const tray = {
    isDestroyed: vi.fn(() => false),
    setImage: vi.fn(),
    setToolTip: vi.fn(),
  } as unknown as Tray;
  const window = {
    isDestroyed: vi.fn(() => false),
    setProgressBar: vi.fn(),
    setOverlayIcon: vi.fn(),
  } as unknown as BrowserWindow;
  initTrayStatus(tray, icons, () => window, platform);
  return { icons, tray, window };
}

describe('tray status', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    disposeTrayStatus();
    vi.useRealTimers();
  });

  it('在 Windows 流式中显示工作动画和任务栏不确定进度', () => {
    const { icons, tray, window } = setup();

    setTrayStreaming(true);

    expect(tray.setImage).toHaveBeenLastCalledWith(icons.streaming);
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Nanobot · 正在回复');
    expect(window.setProgressBar).toHaveBeenLastCalledWith(2, { mode: 'indeterminate' });

    vi.advanceTimersByTime(800);
    expect(tray.setImage).toHaveBeenLastCalledWith(icons.streamingAlt);
  });

  it('未读优先于工作态，清除后恢复工作态', () => {
    const { icons, tray, window } = setup();
    setTrayStreaming(true);

    notifyTrayIncoming();

    expect(tray.setImage).toHaveBeenLastCalledWith(icons.unread);
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Nanobot · 有新回复');
    expect(window.setOverlayIcon).toHaveBeenLastCalledWith(
      icons.unreadOverlay,
      'Nanobot · 有新回复',
    );
    expect(window.setProgressBar).toHaveBeenLastCalledWith(2, { mode: 'indeterminate' });

    vi.advanceTimersByTime(600);
    expect(tray.setImage).toHaveBeenLastCalledWith(icons.unread);
    vi.advanceTimersByTime(600);
    expect(tray.setImage).toHaveBeenLastCalledWith(icons.idle);

    clearTrayUnread();
    expect(tray.setImage).toHaveBeenLastCalledWith(icons.streaming);
    expect(window.setOverlayIcon).toHaveBeenLastCalledWith(null, '');
  });

  it('结束和 dispose 清除 Windows 任务栏状态', () => {
    const { icons, tray, window } = setup();
    setTrayStreaming(true);
    notifyTrayIncoming();

    setTrayStreaming(false);
    clearTrayUnread();

    expect(tray.setImage).toHaveBeenLastCalledWith(icons.idle);
    expect(window.setProgressBar).toHaveBeenLastCalledWith(-1);
    expect(window.setOverlayIcon).toHaveBeenLastCalledWith(null, '');

    disposeTrayStatus();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('macOS 只更新菜单栏图标和 tooltip', () => {
    const { icons, tray, window } = setup('darwin');

    setTrayStreaming(true);
    vi.advanceTimersByTime(800);
    notifyTrayIncoming();

    expect(tray.setImage).toHaveBeenCalledWith(icons.streamingAlt);
    expect(tray.setImage).toHaveBeenLastCalledWith(icons.unread);
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Nanobot · 有新回复');
    expect(window.setProgressBar).not.toHaveBeenCalled();
    expect(window.setOverlayIcon).not.toHaveBeenCalled();
  });
});
