const { app, BrowserWindow, Menu, ipcMain, protocol, session, shell, dialog } = require('electron');
const { readFile, writeFile, rename, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const { APP_ORIGIN, normalizeGateway, isExternalLink, isMediaUrl, createHandler } = require('./gateway.cjs');
const { installDesktop } = require('./desktop.cjs');

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
  const next = new BrowserWindow({
    title: 'Nanobot', width: 1200, height: 820, minWidth: 760, minHeight: 540,
    backgroundColor: '#303030', show: false,
    webPreferences: { preload, session: webSession, nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true },
  });
  next.once('ready-to-show', () => next.show());
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
    installMenu();
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
      socket.addEventListener('open', () => emit({ type: 'open' }));
      socket.addEventListener('message', (message) => {
        if (typeof message.data === 'string') {
          try { if (window?.webContents === owner) desktop.notify(JSON.parse(message.data)); } catch { /* 非 JSON 帧交给原客户端处理。 */ }
          emit({ type: 'message', data: message.data });
        }
      });
      socket.addEventListener('error', () => emit({ type: 'error', message: 'WebSocket 连接失败' }));
      socket.addEventListener('close', (close) => {
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
