const { app, BrowserWindow, Menu, ipcMain, protocol, session, shell, dialog, nativeImage, screen } = require('electron');
const { readFile } = require('node:fs/promises');
const Store = require('electron-store');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const { APP_ORIGIN, normalizeGateway, isExternalLink, isMediaUrl, createHandler } = require('./gateway.cjs');
const { installDesktop } = require('./desktop.cjs');
const { createAppearance } = require('./appearance.cjs');
const { readWindowState, trackWindowState } = require('./window-state.cjs');
const { createDesktopContext } = require('./desktop-context.cjs');
const { SystemMediaController } = require('./system-media.cjs');
const { createCompanion } = require('./companion.cjs');
const { createStreamDiagnostics } = require('./stream-diagnostics.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'nanobot', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }]);
app.setName('Nanobot');
// 升级沿用同一个应用数据目录；测试仍可显式指定临时目录。
app.setPath('userData', process.env.NANOBOT_DESKTOP_DATA_DIR || path.join(app.getPath('appData'), 'Nanobot'));
const store = new Store();
const streamDiagnostic = createStreamDiagnostics(path.join(app.getPath('userData'), 'logs'));

let window;
let desktop;
let companion;
let companionWindow;
let companionWorking = false;
let companionRatio = 4 / 3;
let quitting = false;
let gateway = 'http://127.0.0.1:8765';
let loadError = '';
const setupFile = path.join(__dirname, 'setup.html');
const companionPreload = path.join(__dirname, 'companion-preload.cjs');
let saveWindowState;
const preload = path.join(__dirname, 'preload.cjs');
const rendererDir = path.join(__dirname, 'renderer');
const appIcon = path.join(__dirname, 'assets', 'icon.png');
const COMPANION_RATIO = 4 / 3;
const COMPANION_HEADER = 32;
const sockets = new Map();

function trustedChat(event) {
  if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame
      || !event.senderFrame.url.startsWith(`${APP_ORIGIN}/`)) {
    throw new Error('拒绝非聊天页面的请求');
  }
}

function trustedCompanion(event) {
  if (event.sender !== companionWindow?.webContents || event.senderFrame !== event.sender.mainFrame
      || event.senderFrame.url !== `${APP_ORIGIN}/companion.html`) {
    throw new Error('拒绝非伴侣窗口的请求');
  }
}

function companionBounds(saved, ratio = COMPANION_RATIO) {
  const area = (saved && screen.getAllDisplays().find(({ workArea: a }) =>
    saved.x >= a.x && saved.y >= a.y && saved.x < a.x + a.width - 60 && saved.y < a.y + a.height - 30
  ) || screen.getPrimaryDisplay()).workArea;
  const width = Math.min(saved?.width ?? 320, area.width, Math.floor((area.height - COMPANION_HEADER) * ratio));
  const height = Math.round(width / ratio) + COMPANION_HEADER;
  return { x: saved ? Math.max(area.x, Math.min(saved.x, area.x + area.width - width)) : area.x + area.width - width - 24,
    y: saved ? Math.max(area.y, Math.min(saved.y, area.y + area.height - height)) : area.y + 48,
    width, height };
}

function setCompanionAspectRatio(ratio) {
  if (!companionWindow || companionWindow.isDestroyed() || !Number.isFinite(ratio) || ratio < 0.5 || ratio > 4
      || Math.abs(ratio - companionRatio) < 0.001) return;
  companionRatio = ratio;
  companionWindow.setMinimumSize(200, Math.ceil(200 / ratio) + COMPANION_HEADER);
  if (process.platform !== 'win32') companionWindow.setAspectRatio(ratio, { width: 0, height: COMPANION_HEADER });
  companionWindow.setBounds(companionBounds(companionWindow.getBounds(), ratio));
}

function syncCompanionWindow(prefs) {
  if (prefs.enabled && prefs.detached && !companionWindow) {
    const next = new BrowserWindow({ title: '数字伴侣', ...companionBounds(prefs.window), minWidth: 200,
      minHeight: 182, frame: false, backgroundColor: '#303030', icon: appIcon,
      webPreferences: { preload: companionPreload, session: window.webContents.session,
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
        autoplayPolicy: 'no-user-gesture-required' } });
    companionWindow = next;
    companionRatio = COMPANION_RATIO;
    if (process.platform === 'win32') {
      next.on('will-resize', (event, bounds, { edge }) => {
        event.preventDefault();
        const current = next.getBounds();
        const width = Math.max(200, edge === 'top' || edge === 'bottom'
          ? Math.round((bounds.height - COMPANION_HEADER) * companionRatio) : bounds.width);
        const height = Math.round(width / companionRatio) + COMPANION_HEADER;
        next.setBounds({ x: edge.includes('left') ? current.x + current.width - width : bounds.x,
          y: edge.includes('top') ? current.y + current.height - height : bounds.y, width, height });
      });
    } else next.setAspectRatio(COMPANION_RATIO, { width: 0, height: COMPANION_HEADER });
    let timer;
    const saveBounds = () => {
      clearTimeout(timer);
      if (!next.isDestroyed() && !next.isMinimized()) store.set('avatarCompanion.window', next.getBounds());
    };
    for (const event of ['move', 'resize']) next.on(event, () => { clearTimeout(timer); timer = setTimeout(saveBounds, 300); });
    next.on('close', saveBounds);
    next.on('closed', () => {
      clearTimeout(timer);
      if (companionWindow === next) companionWindow = null;
      if (quitting) return;
      void companion.read().then(prefs => {
        if (prefs.enabled && prefs.detached) return companion.save({ enabled: false }).then(syncCompanionWindow);
      }).catch(error => console.warn('无法保存伴侣窗口关闭状态。', error.message));
    });
    next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    next.webContents.on('will-navigate', event => event.preventDefault());
    next.webContents.on('will-attach-webview', event => event.preventDefault());
    next.webContents.on('did-finish-load', () => next.webContents.send('desktop:companion-working', companionWorking));
    void next.loadURL(`${APP_ORIGIN}/companion.html`).catch(() => next.destroy());
  }
  if (companionWindow && !companionWindow.isDestroyed()) {
    if (!prefs.enabled || !prefs.detached) companionWindow.close();
    else companionWindow.setAlwaysOnTop(prefs.pinned);
  }
  if (window && !window.isDestroyed()) window.webContents.send('desktop:companion-changed', prefs);
  if (companionWindow && !companionWindow.isDestroyed()) companionWindow.webContents.send('desktop:companion-changed', prefs);
}

function ownedSocket(event, id) {
  trustedChat(event);
  const entry = sockets.get(id);
  if (!entry || entry.owner !== event.sender) throw new Error('连接不存在');
  return entry.socket;
}

function trustedSetup(event) {
  if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame
      || event.senderFrame.url !== pathToFileURL(setupFile).href) {
    throw new Error('拒绝非连接页面的请求');
  }
}

function openExternal(url) {
  if (isExternalLink(url)) void shell.openExternal(url).catch(() => {});
}

function showWindow() {
  if (!window || window.isDestroyed()) { void showChat(); return; }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function openMedia(owner, url) {
  // 只在图片标签中展示附件，不让附件 HTML 获得聊天页的 origin 或 preload。
  const preview = new BrowserWindow({
    title: '图片预览', width: 900, height: 700, parent: owner, icon: appIcon,
    webPreferences: { session: owner.webContents.session, nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true },
  });
  preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  preview.webContents.on('will-navigate', (event) => event.preventDefault());
  preview.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const close = () => { if (!preview.isDestroyed()) preview.destroy(); };
  owner.once('closed', close);
  preview.once('closed', () => owner.removeListener('closed', close));
  void preview.loadFile(path.join(__dirname, 'media.html'), { query: { src: url } })
    .catch(() => close());
}

function makeWindow(webSession) {
  saveWindowState?.();
  const { maximized, ...bounds } = readWindowState(store, screen);
  const next = new BrowserWindow({
    title: 'Nanobot', ...bounds, minWidth: Math.min(760, bounds.width), minHeight: Math.min(540, bounds.height),
    backgroundColor: '#303030', show: false, icon: appIcon,
    frame: false, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 10, y: 12 },
    autoHideMenuBar: true,
    webPreferences: { preload, session: webSession, nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true, autoplayPolicy: 'no-user-gesture-required' },
  });
  next.once('ready-to-show', () => { if (maximized) next.maximize(); next.show(); });
  saveWindowState = trackWindowState(next, store);
  desktop?.bindWindow(next);
  next.on('closed', () => { if (window === next) window = null; });
  next.webContents.setWindowOpenHandler(({ url }) => {
    if (isMediaUrl(url)) openMedia(next, url);
    else openExternal(url);
    return { action: 'deny' };
  });
  const guard = (event) => {
    const url = event.url;
    if (url.startsWith(`${APP_ORIGIN}/`) || url === pathToFileURL(setupFile).href) return;
    event.preventDefault();
    openExternal(url);
  };
  next.webContents.on('will-navigate', guard);
  next.webContents.on('will-redirect', guard);
  next.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const owner = next.webContents;
  owner.on('console-message', (details) => {
    const prefix = '[nanobot-stream] ';
    if (typeof details?.message !== 'string' || !details.message.startsWith(prefix)) return;
    try { streamDiagnostic({ ...JSON.parse(details.message.slice(prefix.length)), windowId: next.id }); }
    catch { /* Ignore malformed diagnostic lines. */ }
  });
  const sendWindowState = () => owner.send('desktop:window-state', next.isMaximized());
  next.on('maximize', sendWindowState);
  next.on('unmaximize', sendWindowState);
  const closeSockets = () => {
    for (const [id, entry] of sockets) {
      if (entry.owner === owner) { entry.socket.close(); sockets.delete(id); }
    }
  };
  owner.once('destroyed', closeSockets);
  owner.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) closeSockets();
  });
  return next;
}

async function showSetup(error = '') {
  loadError = error;
  const previous = window;
  window = makeWindow(session.fromPartition('desktop-setup'));
  await window.loadFile(setupFile);
  if (previous && !previous.isDestroyed()) previous.destroy();
}

async function showChat() {
  try { await readFile(path.join(rendererDir, 'index.html')); }
  catch { await showSetup('桌面界面尚未构建，请先在 electron 目录运行 npm run build。'); return; }
  const key = createHash('sha256').update(gateway).digest('hex').slice(0, 24);
  // 每个 gateway 分开保存 token/cookie，切换地址不会把旧凭据发往新服务器。
  const webSession = session.fromPartition(`persist:gateway-${key}`);
  if (!(await webSession.protocol.isProtocolHandled('nanobot'))) {
    webSession.protocol.handle('nanobot', createHandler({
      rendererDir, gateway, companion,
      fetch: (url, options) => webSession.fetch(url, { ...options, credentials: 'include' }),
    }));
    webSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const trusted = contents === window?.webContents
        && contents.getURL().startsWith(`${APP_ORIGIN}/`)
        && details.isMainFrame && details.requestingUrl.startsWith(`${APP_ORIGIN}/`);
      const audioOnly = permission === 'media' && details.mediaTypes?.length === 1
        && details.mediaTypes[0] === 'audio';
      callback(Boolean(trusted && (permission === 'clipboard-sanitized-write' || audioOnly)));
    });
    webSession.setPermissionCheckHandler((contents, permission, _origin, details) => {
      const trusted = contents === window?.webContents
        && contents.getURL().startsWith(`${APP_ORIGIN}/`)
        && details.isMainFrame && details.requestingUrl?.startsWith(`${APP_ORIGIN}/`);
      return Boolean(trusted && (permission === 'clipboard-sanitized-write'
        || (permission === 'media' && details.mediaType === 'audio')));
    });
  }
  const previous = window;
  window = makeWindow(webSession);
  try { await window.loadURL(`${APP_ORIGIN}/`); }
  catch { await showSetup('界面加载失败，请重新连接。'); return; }
  if (previous && !previous.isDestroyed()) previous.destroy();
  void companion.read().then(syncCompanionWindow).catch(error => console.warn('无法恢复伴侣窗口。', error.message));
}

function installMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: '连接', submenu: [
      { label: '更换后端地址…', accelerator: 'CmdOrCtrl+,', click: () => void showSetup() },
      { label: '重新连接', accelerator: 'CmdOrCtrl+R', click: () => void showChat() },
      { type: 'separator' }, { role: 'quit', label: '退出' },
    ] },
    { role: 'editMenu', label: '编辑' },
    ...(desktop ? [desktop.menu] : []),
    { label: '视图', submenu: [
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { role: 'togglefullscreen' },
      ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : []),
    ] },
    { role: 'windowMenu', label: '窗口' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.whenReady().then(async () => {
    if (app.dock) app.dock.setIcon(appIcon);
    desktop = installDesktop({ store, getWindow: () => window, showWindow });
    companion = createCompanion({ store, bundledRoot: path.join(__dirname, 'avatar-videos'), dialog });
    for (const action of ['read', 'save', 'choose', 'packs', 'videos']) {
      ipcMain.handle(`desktop:companion-${action}`, async (event, value) => {
        if (event.sender === companionWindow?.webContents) {
          trustedCompanion(event);
          if (!['read', 'save', 'videos'].includes(action)) throw new Error('无效伴侣操作');
          if (action === 'save' && (!value || Object.keys(value).some(key => !['enabled', 'detached', 'pinned'].includes(key)))) throw new Error('无效伴侣设置');
        } else trustedChat(event);
        const result = await (action === 'save' || action === 'packs' ? companion[action](value) : companion[action]());
        if (action === 'save') syncCompanionWindow(result);
        return result;
      });
    }
    ipcMain.handle('desktop:companion-working', (event, value) => {
      trustedChat(event);
      if (typeof value !== 'boolean') throw new Error('Invalid companion state');
      companionWorking = value;
      if (companionWindow && !companionWindow.isDestroyed()) companionWindow.webContents.send('desktop:companion-working', value);
    });
    ipcMain.handle('desktop:companion-aspect-ratio', (event, ratio) => {
      trustedCompanion(event);
      setCompanionAspectRatio(ratio);
    });
    const desktopContext = createDesktopContext();
    const systemMedia = new SystemMediaController(store);
    ipcMain.handle('desktop:voice-settings', async (event, value) => {
      trustedChat(event);
      if (value !== undefined) {
        if (typeof value !== 'boolean') throw new Error('Invalid media setting');
        await systemMedia.setEnabled(value);
      }
      return { pauseSystemMedia: systemMedia.getEnabled(), support: await systemMedia.getSupport() };
    });
    ipcMain.handle('desktop:voice-active', (event, active) => {
      trustedChat(event);
      if (typeof active !== 'boolean') throw new Error('Invalid playback state');
      return systemMedia.setTtsActive(event.sender.id, active);
    });
    app.on('web-contents-created', (_event, contents) => {
      const release = () => { void systemMedia.setTtsActive(contents.id, false); };
      contents.on('destroyed', release);
      contents.on('render-process-gone', release);
      contents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) release(); });
    });
    let mediaReleased = false;
    app.on('before-quit', (event) => {
      quitting = true;
      if (mediaReleased) return;
      event.preventDefault();
      mediaReleased = true;
      void systemMedia.dispose().finally(() => app.quit());
    });
    app.on('will-quit', () => desktopContext.dispose());
    installMenu();
    for (const action of ['get', 'set']) {
      ipcMain.handle(`desktop:config-${action}`, (event, key, value) => {
        trustedChat(event);
        if (!['appearance.theme', 'appearance.language', 'gateway.token'].includes(key)) throw new Error('Invalid preference');
        if (action === 'get') return store.get(key);
        if (typeof value !== 'string' || value.length > 100) throw new Error('Invalid preference value');
        store.set(key, value);
      });
    }
    ipcMain.handle('desktop:quit', (event) => {
      trustedChat(event);
      setImmediate(() => app.quit());
    });
    ipcMain.handle('desktop:notify-incoming', (event, notificationId, payload) => {
      trustedChat(event);
      if (typeof notificationId !== 'string' || !notificationId || notificationId.length > 256) {
        throw new Error('Invalid notification id');
      }
      const text = typeof payload?.text === 'string' ? payload.text.slice(0, 1000) : undefined;
      desktop.notifyIncoming(notificationId, {
        ...(text?.trim() ? { text } : {}),
        hasMedia: payload?.hasMedia === true,
      });
    });
    // 仅主窗口的聊天页或连接页可操作自身窗口，附件页无此权限。
    const trustedWindow = (event) => {
      if (event.senderFrame?.url === pathToFileURL(setupFile).href) trustedSetup(event);
      else trustedChat(event);
    };
    ipcMain.handle('desktop:window-state', (event) => { trustedWindow(event); return window.isMaximized(); });
    ipcMain.handle('desktop:window-action', (event, action) => {
      trustedWindow(event);
      if (action === 'minimize') window.minimize();
      else if (action === 'maximize') { if (window.isMaximized()) window.unmaximize(); else window.maximize(); }
      else if (action === 'close') window.close();
      else throw new Error('无效窗口操作');
    });
    const appearance = createAppearance({ store, nativeImage, dialog });
    ipcMain.handle('desktop:appearance-read', (event) => { trustedChat(event); return appearance.read(); });
    ipcMain.handle('desktop:appearance-save', (event, value) => { trustedChat(event); return appearance.save(value); });
    ipcMain.handle('desktop:appearance-choose', (event, kind) => { trustedChat(event); return appearance.choose(kind, window); });
    ipcMain.handle('desktop:wallpaper', (event) => { trustedChat(event); return appearance.wallpaper(); });
    // 使用上游 HostSocketBridge，支持 NAS 的 ws://，不降低 renderer 的混合内容保护。
    ipcMain.handle('desktop:socket-open', (event, value) => {
      trustedChat(event);
      const url = new URL(value);
      const expected = new URL(gateway);
      expected.protocol = expected.protocol === 'https:' ? 'wss:' : 'ws:';
      if (url.origin !== expected.origin || url.username || url.password || url.hash) {
        throw new Error('WebSocket 必须连接当前 gateway');
      }
      const id = randomUUID();
      const owner = event.sender;
      const socket = new WebSocket(url);
      sockets.set(id, { socket, owner });
      const emit = (payload) => { if (!owner.isDestroyed()) owner.send('desktop:socket-event', { id, ...payload }); };
      const sendDesktopState = (state) => {
        if (socket.readyState === WebSocket.OPEN && window?.webContents === owner) {
          socket.send(JSON.stringify({ type: 'desktop_context_state', ...state }));
        }
      };
      const unsubscribeDesktop = desktopContext.subscribe(sendDesktopState);
      socket.addEventListener('open', () => {
        streamDiagnostic({ event: 'transport.open', socketId: id });
        sendDesktopState(desktopContext.status()); emit({ type: 'open' });
      });
      socket.addEventListener('message', (message) => {
        if (typeof message.data === 'string') {
          let frame;
          try { frame = JSON.parse(message.data); } catch { /* 非 JSON 帧仍交给原客户端。 */ }
          if (['message_accepted', 'goal_status', 'stream_end', 'turn_end', 'error'].includes(frame?.event)) {
            streamDiagnostic({
              event: 'transport.event', socketId: id, wireEvent: frame.event,
              chatId: frame.chat_id, turnId: frame.turn_id, streamId: frame.stream_id,
              status: frame.status, resuming: frame.resuming, mergeNext: frame.merge_next,
              outcome: frame.outcome, detail: frame.detail, reason: frame.reason,
            });
          }
          if (frame?.event === 'desktop_context_request') {
            if (window?.webContents !== owner || typeof frame.request_id !== 'string' || !/^[a-f0-9]{32}$/.test(frame.request_id)) return;
            void desktopContext.capture().then((result) => {
              if (window?.webContents === owner && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'desktop_context_result', request_id: frame.request_id, ...result }));
              }
            });
            return;
          }
          try { if (window?.webContents === owner && frame) desktop.handleFrame(frame); } catch { /* 状态提示失败不影响原客户端。 */ }
          emit({ type: 'message', data: message.data });
        }
      });
      socket.addEventListener('error', () => emit({ type: 'error', message: 'WebSocket 连接失败' }));
      socket.addEventListener('close', (close) => {
        streamDiagnostic({ event: 'transport.close', socketId: id, code: close.code });
        if (window?.webContents === owner) desktop.disconnected();
        unsubscribeDesktop();
        sockets.delete(id); emit({ type: 'close', code: close.code, reason: close.reason });
      });
      return id;
    });
    ipcMain.handle('desktop:socket-send', (event, id, data) => {
      const socket = ownedSocket(event, id);
      if (typeof data !== 'string') throw new Error('只支持文本帧');
      socket.send(data);
    });
    ipcMain.handle('desktop:socket-close', (event, id) => {
      trustedChat(event);
      if (sockets.has(id)) ownedSocket(event, id).close();
    });
    ipcMain.handle('desktop:read', (event) => { trustedSetup(event); return { gateway, error: loadError }; });
    ipcMain.handle('desktop:connect', async (event, value) => {
      trustedSetup(event);
      try {
        const selected = normalizeGateway(value);
        store.set('gateway.url', selected);
        gateway = selected;
        // 先响应连接页，避免销毁页面使 IPC Promise 悬挂。
        setImmediate(() => void showChat());
        return { ok: true };
      } catch (error) { return { ok: false, error: error.message }; }
    });
    try {
      gateway = normalizeGateway(process.env.NANOBOT_GATEWAY_URL
        || store.get('gateway.url'));
      await showChat();
    } catch (error) {
      await showSetup(error.code === 'ENOENT' ? '' : '后端地址配置无效，请重新填写。');
    }
    app.on('activate', showWindow);
  }).catch((error) => { dialog.showErrorBox('Nanobot 启动失败', error.message); app.quit(); });
}
