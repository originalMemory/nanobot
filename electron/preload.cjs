const { contextBridge, ipcRenderer } = require('electron');

const windowControls = {
  isMac: process.platform === 'darwin',
  read: () => ipcRenderer.invoke('desktop:window-state'),
  action: (action) => ipcRenderer.invoke('desktop:window-action', action),
  onState: (listener) => {
    const handler = (_event, maximized) => listener(maximized);
    ipcRenderer.on('desktop:window-state', handler);
    return () => ipcRenderer.removeListener('desktop:window-state', handler);
  },
};

// 连接页拥有有限的设置接口；聊天页不能修改宿主配置。
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('desktopSetup', {
    windowControls,
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
    quit: () => ipcRenderer.invoke('desktop:quit'),
    windowControls,
    fixedChatId: 'desktop',
    companion: {
      read: () => ipcRenderer.invoke('desktop:companion-read'),
      save: (value) => ipcRenderer.invoke('desktop:companion-save', value),
      choose: () => ipcRenderer.invoke('desktop:companion-choose'),
      videos: () => ipcRenderer.invoke('desktop:companion-videos'),
    },
    speech: {
      settings: (value) => ipcRenderer.invoke('desktop:speech-settings', value),
      active: (value) => ipcRenderer.invoke('desktop:speech-active', value),
    },
    appearance: {
      read: () => ipcRenderer.invoke('desktop:appearance-read'),
      save: (value) => ipcRenderer.invoke('desktop:appearance-save', value),
      choose: (kind) => ipcRenderer.invoke('desktop:appearance-choose', kind),
      wallpaper: () => ipcRenderer.invoke('desktop:wallpaper'),
    },
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
