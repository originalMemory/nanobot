const { contextBridge, ipcRenderer } = require('electron');

// 连接页拥有有限的设置接口；聊天页不能修改宿主配置。
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('desktopSetup', {
    read: () => ipcRenderer.invoke('desktop:read'),
    connect: (url) => ipcRenderer.invoke('desktop:connect', url),
  });
} else if (location.protocol === 'nanobot:' && location.host === 'desktop') {
  let pendingScreenshot = null;
  let screenshotListener = null;
  ipcRenderer.on('desktop:screenshot', (_event, data) => {
    pendingScreenshot = data;
    location.hash = '#/chat/websocket%3Adesktop';
    if (screenshotListener) { screenshotListener(data); pendingScreenshot = null; }
  });
  // 复用上游 native 外观，不宣称有远端工作区的本地目录选择能力。
  contextBridge.exposeInMainWorld('nanobotHost', {
    fixedChatId: 'desktop',
    onScreenshot: (listener) => {
      screenshotListener = listener;
      if (pendingScreenshot) { listener(pendingScreenshot); pendingScreenshot = null; }
      return () => { if (screenshotListener === listener) screenshotListener = null; };
    },
    openSocket: (url) => ipcRenderer.invoke('desktop:socket-open', url),
    sendSocket: (id, data) => ipcRenderer.invoke('desktop:socket-send', id, data),
    closeSocket: (id) => ipcRenderer.invoke('desktop:socket-close', id),
    onSocketEvent: (listener) => {
      const handler = (_event, message) => listener(message);
      ipcRenderer.on('desktop:socket-event', handler);
      return () => ipcRenderer.removeListener('desktop:socket-event', handler);
    },
  });
}
