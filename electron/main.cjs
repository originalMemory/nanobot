const { app, BrowserWindow, Menu, ipcMain, protocol, session, shell, dialog, nativeImage, screen } = require('electron');
const { readFile, writeFile, rename, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const { APP_ORIGIN, normalizeGateway, isExternalLink, isMediaUrl, createHandler } = require('./gateway.cjs');
const { installDesktop } = require('./desktop.cjs');
const { createAppearance } = require('./appearance.cjs');
const { readWindowState, trackWindowState } = require('./window-state.cjs');
const { createDesktopContext } = require('./desktop-context.cjs');
const { SystemMediaController } = require('./system-media.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'nanobot', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }]);
app.setName('Nanobot');
// 与旧版 lover 的偏好和认证缓存分开，避免试用污染日常环境。
app.setPath('userData', process.env.NANOBOT_DESKTOP_DATA_DIR || path.join(app.getPath('appData'), 'Nanobot-next'));

let window;
let desktop;
let gateway = 'http://127.0.0.1:8765';
let loadError = '';
const setupFile = path.join(__dirname, 'setup.html');
const settingsFile = path.join(app.getPath('userData'), 'connection.json');
const windowStateFile = path.join(app.getPath('userData'), 'window.json');
let saveWindowState;
const preload = path.join(__dirname, 'preload.cjs');
const rendererDir = path.join(__dirname, 'renderer');
const sockets = new Map();

function trustedChat(event) {
  if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame
      || !event.senderFrame.url.startsWith(`${APP_ORIGIN}/`)) {
    throw new Error('拒绝非聊天页面的请求');
  }
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
    title: '图片预览', width: 900, height: 700, parent: owner,
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
  const { maximized, ...bounds } = readWindowState(windowStateFile, screen);
  const next = new BrowserWindow({
    title: 'Nanobot', ...bounds, minWidth: Math.min(760, bounds.width), minHeight: Math.min(540, bounds.height),
    backgroundColor: '#303030', show: false,
    frame: false, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 10, y: 12 },
    autoHideMenuBar: true,
    webPreferences: { preload, session: webSession, nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true, autoplayPolicy: 'no-user-gesture-required' },
  });
  next.once('ready-to-show', () => { if (maximized) next.maximize(); next.show(); });
  saveWindowState = trackWindowState(next, windowStateFile);
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
      rendererDir, gateway,
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
  catch { await showSetup('界面加载失败，请重新连接。'); }
  if (previous && !previous.isDestroyed()) previous.destroy();
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
    desktop = installDesktop({ getWindow: () => window, showWindow });
    const desktopContext = createDesktopContext();
    const mediaFile = path.join(app.getPath('userData'), 'speech.json');
    let pauseMedia = true;
    try { pauseMedia = JSON.parse(await readFile(mediaFile, 'utf8')).pauseSystemMedia !== false; } catch { /* 首次运行使用默认值。 */ }
    const systemMedia = new SystemMediaController({ get: () => pauseMedia, set: (_key, value) => { pauseMedia = value; } });
    ipcMain.handle('desktop:speech-settings', async (event, value) => {
      trustedChat(event);
      if (value !== undefined) {
        if (typeof value !== 'boolean') throw new Error('Invalid media setting');
        await systemMedia.setEnabled(value);
        const temporary = `${mediaFile}.tmp`;
        await writeFile(temporary, JSON.stringify({ pauseSystemMedia: value }));
        await rename(temporary, mediaFile);
      }
      return { pauseSystemMedia: systemMedia.getEnabled(), support: await systemMedia.getSupport() };
    });
    ipcMain.handle('desktop:speech-active', (event, active) => {
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
      if (mediaReleased) return;
      event.preventDefault();
      mediaReleased = true;
      void systemMedia.dispose().finally(() => app.quit());
    });
    app.on('will-quit', () => desktopContext.dispose());
    installMenu();
    ipcMain.handle('desktop:quit', (event) => {
      trustedChat(event);
      setImmediate(() => app.quit());
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
    const appearance = createAppearance({ directory: app.getPath('userData'), nativeImage, dialog });
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
      socket.addEventListener('open', () => { sendDesktopState(desktopContext.status()); emit({ type: 'open' }); });
      socket.addEventListener('message', (message) => {
        if (typeof message.data === 'string') {
          let frame;
          try { frame = JSON.parse(message.data); } catch { /* 非 JSON 帧仍交给原客户端。 */ }
          if (frame?.event === 'desktop_context_request') {
            if (window?.webContents !== owner || typeof frame.request_id !== 'string' || !/^[a-f0-9]{32}$/.test(frame.request_id)) return;
            void desktopContext.capture().then((result) => {
              if (window?.webContents === owner && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'desktop_context_result', request_id: frame.request_id, ...result }));
              }
            });
            return;
          }
          try { if (window?.webContents === owner) desktop.notify(JSON.parse(message.data)); } catch { /* 非 JSON 帧交给原客户端处理。 */ }
          emit({ type: 'message', data: message.data });
        }
      });
      socket.addEventListener('error', () => emit({ type: 'error', message: 'WebSocket 连接失败' }));
      socket.addEventListener('close', (close) => {
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
        await mkdir(path.dirname(settingsFile), { recursive: true });
        await writeFile(`${settingsFile}.tmp`, JSON.stringify({ gateway: selected }), { mode: 0o600 });
        await rename(`${settingsFile}.tmp`, settingsFile);
        gateway = selected;
        // 先响应连接页，避免销毁页面使 IPC Promise 悬挂。
        setImmediate(() => void showChat());
        return { ok: true };
      } catch (error) { return { ok: false, error: error.message }; }
    });
    try {
      gateway = normalizeGateway(process.env.NANOBOT_GATEWAY_URL
        || JSON.parse(await readFile(settingsFile, 'utf8')).gateway);
      await showChat();
    } catch (error) {
      await showSetup(error.code === 'ENOENT' ? '' : '后端地址配置无效，请重新填写。');
    }
    app.on('activate', showWindow);
  }).catch((error) => { dialog.showErrorBox('Nanobot 启动失败', error.message); app.quit(); });
}
