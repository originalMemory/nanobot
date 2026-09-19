const path = require('node:path');

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
  const notified = new Set();
  const iconName = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', iconName));
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  const tray = new Tray(icon);
  tray.setToolTip('Nanobot');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示聊天', click: showWindow },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);

  function toggle() {
    const win = getWindow();
    if (win?.isVisible() && win.isFocused()) win.hide();
    else showWindow();
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
      showWindow();
    }
  }

  function notify(frame) {
    const key = completionKey(frame);
    if (!key || notified.has(key)) return;
    notified.add(key);
    if (notified.size > 256) notified.delete(notified.values().next().value);
    const win = getWindow();
    if (win?.isVisible() && win.isFocused()) return;
    tray.setToolTip('Nanobot · 有新的对话更新');
    if (process.env.NANOBOT_DESKTOP_NOTIFICATIONS === '0' || !Notification.isSupported()) return;
    // 系统通知不展示私人对话正文，点击后回到应用查看。
    const notification = new Notification({ title: 'Nanobot', body: '有新的对话更新，点击查看。' });
    notification.on('click', showWindow);
    notification.show();
  }

  const supportsStartup = app.isPackaged && ['darwin', 'win32'].includes(process.platform);
  const shortcut = process.env.NANOBOT_RAISE_SHORTCUT ?? store?.get('shortcuts.raiseInbox') ?? 'CommandOrControl+Shift+E';
  const registered = Boolean(shortcut) && globalShortcut.register(shortcut, toggle);
  if (shortcut && !registered) console.warn(`快捷键 ${shortcut} 已被占用，请通过托盘显示窗口。`);
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => { if (registered) globalShortcut.unregister(shortcut); tray.destroy(); });

  return {
    capture, notify,
    bindWindow(win) {
      win.on('close', (event) => {
        if (!quitting) { event.preventDefault(); win.hide(); }
      });
      win.on('focus', () => tray.setToolTip('Nanobot'));
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
