const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// 桌面感知只响应 gateway 的按需请求，不启动截图定时器。
function createDesktopContext({ electron = require('electron') } = {}) {
  const { app, BrowserWindow, desktopCapturer, powerMonitor, screen } = electron;
  const listeners = new Set();
  let locked = false;
  let suspended = false;
  let epoch = 0;
  let capturing = false;
  function status() {
    let idleState = 'unknown';
    try { idleState = powerMonitor.getSystemIdleState(60); } catch { /* 未知状态不截图。 */ }
    return {
      focused: Boolean(BrowserWindow.getFocusedWindow()),
      locked: locked || idleState === 'locked',
      unknown: idleState === 'unknown',
      suspended,
    };
  }
  const publish = () => { epoch++; for (const listener of listeners) listener(status()); };
  const bindings = [
    [app, 'browser-window-focus', publish], [app, 'browser-window-blur', publish],
    [powerMonitor, 'lock-screen', () => { locked = true; publish(); }],
    [powerMonitor, 'unlock-screen', () => { locked = false; publish(); }],
    [powerMonitor, 'suspend', () => { suspended = true; publish(); }],
    [powerMonitor, 'resume', () => { suspended = false; publish(); }],
  ];
  for (const [owner, event, callback] of bindings) owner.on(event, callback);
  function reason(value) {
    return value.locked ? 'locked' : value.unknown ? 'unknown' : value.suspended ? 'suspended' : value.focused ? 'focused' : null;
  }
  return {
    status,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async capture() {
      const blocked = reason(status());
      if (blocked || capturing) return { reason: blocked || 'busy' };
      const version = epoch;
      capturing = true;
      try {
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        const scale = Math.min(1, 1600 / Math.max(display.size.width, display.size.height));
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: {
          width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale),
        } });
        if (epoch !== version || reason(status())) return { reason: 'state_changed' };
        const image = sources.find((source) => source.display_id === String(display.id))?.thumbnail;
        if (!image || image.isEmpty()) return { reason: 'unavailable' };
        const bytes = image.toJPEG(80);
        if (bytes.length > MAX_IMAGE_BYTES) return { reason: 'too_large' };
        return { reason: 'captured', image: `data:image/jpeg;base64,${bytes.toString('base64')}` };
      } catch { return { reason: 'unavailable' }; }
      finally { capturing = false; }
    },
    dispose() {
      listeners.clear();
      for (const [owner, event, callback] of bindings) owner.removeListener(event, callback);
    },
  };
}

module.exports = { createDesktopContext };
