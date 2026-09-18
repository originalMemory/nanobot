const { contextBridge, ipcRenderer } = require('electron');

// 连接页拥有有限的设置接口；聊天页不能修改宿主配置。
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('desktopSetup', {
    read: () => ipcRenderer.invoke('desktop:read'),
    connect: (url) => ipcRenderer.invoke('desktop:connect', url),
  });
} else if (location.protocol === 'nanobot:' && location.host === 'desktop') {
  // 复用上游 native 外观，不宣称有远端工作区的本地目录选择能力。
  contextBridge.exposeInMainWorld('nanobotHost', {
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
