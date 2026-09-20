const path = require('node:path');
const { notificationBody } = require('./notification-text.cjs');

const STREAMING_INTERVAL_MS = 800;
const UNREAD_INTERVAL_MS = 600;

function completionKey(frame) {
  if (frame?.chat_id !== 'desktop') return null;
  if (frame.event === 'turn_end' && typeof frame.turn_id === 'string') return frame.turn_id;
  if (frame.event === 'session_updated' && typeof frame.notification_id === 'string') return frame.notification_id;
  return null;
}

function installDesktop({ store, getWindow, showWindow, electron = require('electron') }) {
  const { app, Tray, Menu, nativeImage, globalShortcut, desktopCapturer, screen, Notification, dialog } = electron;
  let quitting = false;
  let capturing = false;
  let directWorking = false;
  let companionWorking = false;
  let unread = false;
  let alternateFrame = false;
  let animationTimer = null;
  const notified = new Set();
  const previews = new Map();
  const iconName = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', iconName));
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  const loadStatusIcon = (name) => {
    const candidate = nativeImage.createFromPath(path.join(__dirname, 'assets', name));
    if (candidate.isEmpty?.()) return icon;
    if (process.platform === 'darwin') candidate.setTemplateImage(true);
    return candidate;
  };
  const statusIcons = process.platform === 'darwin' ? {
    idle: icon,
    streaming: loadStatusIcon('trayStreamingTemplate.png'),
    streamingAlt: loadStatusIcon('trayStreamingAltTemplate.png'),
    unread: loadStatusIcon('trayUnreadTemplate.png'),
  } : { idle: icon, streaming: icon, streamingAlt: icon, unread: icon };
  const animateTray = process.platform === 'darwin';
  const tray = new Tray(icon);
  tray.setToolTip('Nanobot');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示聊天', click: showDesktopWindow },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', showDesktopWindow);

  function clearAnimation() {
    if (animationTimer) clearInterval(animationTimer);
    animationTimer = null;
    alternateFrame = false;
  }

  function working() {
    return directWorking || companionWorking;
  }

  function updateTaskbar() {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    if (working()) win.setProgressBar?.(2, { mode: 'indeterminate' });
    else win.setProgressBar?.(-1);
  }

  function setTrayImage(image) {
    if (!tray.isDestroyed?.() && !image.isEmpty?.()) tray.setImage?.(image);
  }

  function renderFrame() {
    alternateFrame = !alternateFrame;
    if (unread) setTrayImage(alternateFrame ? statusIcons.unread : statusIcons.idle);
    else if (working()) setTrayImage(alternateFrame ? statusIcons.streamingAlt : statusIcons.streaming);
  }

  function renderStatus() {
    clearAnimation();
    tray.setToolTip(unread ? 'Nanobot · 有新回复' : working() ? 'Nanobot · 正在回复' : 'Nanobot');
    updateTaskbar();
    if (unread) {
      setTrayImage(statusIcons.unread);
      if (animateTray) animationTimer = setInterval(renderFrame, UNREAD_INTERVAL_MS);
      animationTimer?.unref?.();
    } else if (working()) {
      setTrayImage(statusIcons.streaming);
      if (animateTray) animationTimer = setInterval(renderFrame, STREAMING_INTERVAL_MS);
      animationTimer?.unref?.();
    } else {
      setTrayImage(statusIcons.idle);
    }
  }

  function clearUnread() {
    if (!unread) return;
    unread = false;
    renderStatus();
  }

  function showDesktopWindow() {
    clearUnread();
    showWindow();
  }

  function toggle() {
    const win = getWindow();
    if (win?.isVisible() && win.isFocused()) win.hide();
    else showDesktopWindow();
  }

  async function capture() {
    const win = getWindow();
    if (capturing || !win || !win.webContents.getURL().startsWith('nanobot://desktop/')) return;
    capturing = true;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    try {
      win.hide();
      // 等窗口消失后再取图，避免把输入框本身拍进去。
      await new Promise((resolve) => setTimeout(resolve, 200));
      const sources = await desktopCapturer.getSources({
        types: ['screen'], thumbnailSize: display.size,
      });
      const source = sources.find((item) => item.display_id === String(display.id));
      if (!source || source.thumbnail.isEmpty()) throw new Error('无法获取屏幕，请检查系统屏幕录制权限。');
      if (!win.isDestroyed()) {
        win.webContents.send('desktop:screenshot', `data:image/jpeg;base64,${source.thumbnail.toJPEG(85).toString('base64')}`);
      }
    } catch (error) {
      dialog.showErrorBox('截图失败', error.message);
    } finally {
      capturing = false;
      showDesktopWindow();
    }
  }

  function notify(frame, payload = {}) {
    const key = completionKey(frame);
    if (!key || notified.has(key)) return;
    notified.add(key);
    if (notified.size > 256) notified.delete(notified.values().next().value);
    const win = getWindow();
    if (win?.isVisible() && win.isFocused()) return;
    unread = true;
    renderStatus();
    if (process.env.NANOBOT_DESKTOP_NOTIFICATIONS === '0' || !Notification.isSupported()) return;
    const notification = new Notification({
      title: 'Nanobot',
      body: notificationBody(payload, app.getLocale?.() || 'zh-CN'),
    });
    notification.on('click', showDesktopWindow);
    notification.show();
  }

  function appendPreview(frame) {
    if (frame.chat_id !== 'desktop' || typeof frame.turn_id !== 'string') return;
    if (!['delta', 'message', 'stream_end'].includes(frame.event)) return;
    if (frame.event === 'message' && ['tool_hint', 'progress', 'reasoning'].includes(frame.kind)) return;
    const text = typeof frame.text === 'string' ? frame.text : '';
    const current = previews.get(frame.turn_id) || { text: '', hasMedia: false };
    previews.set(frame.turn_id, {
      text: (
        frame.event === 'stream_end' && current.text
          ? current.text
          : current.text + text
      ).slice(0, 1000),
      hasMedia: current.hasMedia || Boolean(frame.media_urls?.length || frame.media?.length),
    });
  }

  function handleFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    if (frame.event === 'companion_state') {
      companionWorking = frame.working === true;
      renderStatus();
      return;
    }
    if (frame.chat_id !== 'desktop') return;
    if (frame.event === 'goal_status') {
      directWorking = frame.status === 'running';
      renderStatus();
    }
    appendPreview(frame);
    // 外部渠道只发 session_updated；renderer 刷新统一历史后再带正文请求通知。
    if (frame.event === 'session_updated') return;
    const key = completionKey(frame);
    if (!key) return;
    if (frame.event === 'turn_end') {
      directWorking = false;
      renderStatus();
    }
    const preview = previews.get(key);
    previews.delete(key);
    notify(frame, preview);
  }

  const supportsStartup = app.isPackaged && ['darwin', 'win32'].includes(process.platform);
  const shortcut = process.env.NANOBOT_RAISE_SHORTCUT ?? store?.get('shortcuts.raiseInbox') ?? 'CommandOrControl+Shift+E';
  const registered = Boolean(shortcut) && globalShortcut.register(shortcut, toggle);
  if (shortcut && !registered) console.warn(`快捷键 ${shortcut} 已被占用，请通过托盘显示窗口。`);
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    clearAnimation();
    if (registered) globalShortcut.unregister(shortcut);
    tray.destroy();
  });

  return {
    capture, handleFrame, notify,
    notifyIncoming(notificationId, payload) {
      notify({
        event: 'session_updated',
        chat_id: 'desktop',
        notification_id: notificationId,
      }, payload);
    },
    disconnected() {
      directWorking = false;
      companionWorking = false;
      previews.clear();
      renderStatus();
    },
    bindWindow(win) {
      win.on('close', (event) => {
        if (!quitting) { event.preventDefault(); win.hide(); }
      });
      win.on('focus', clearUnread);
      win.on('show', updateTaskbar);
    },
    menu: { label: '桌面', submenu: [
      { label: registered ? `显示/隐藏窗口（${shortcut}）` : '显示/隐藏窗口（全局快捷键未启用）', click: toggle },
      { label: '截图并附加', accelerator: 'CommandOrControl+Shift+S', click: () => void capture() },
      { type: 'separator' },
      { label: '开机启动', type: 'checkbox', enabled: supportsStartup,
        checked: supportsStartup && app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    ] },
  };
}

module.exports = { completionKey, installDesktop };
