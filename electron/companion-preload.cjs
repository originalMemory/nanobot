const { contextBridge, ipcRenderer } = require('electron');
let currentWorking = false;
const workingListeners = new Set();
ipcRenderer.on('desktop:companion-working', (_event, working) => {
  currentWorking = working;
  for (const listener of workingListeners) listener(working);
});

contextBridge.exposeInMainWorld('companionWindow', {
  read: () => ipcRenderer.invoke('desktop:companion-read'),
  videos: () => ipcRenderer.invoke('desktop:companion-videos'),
  save: (patch) => ipcRenderer.invoke('desktop:companion-save', patch),
  setAspectRatio: (ratio) => ipcRenderer.invoke('desktop:companion-aspect-ratio', ratio),
  onWorking: (listener) => {
    workingListeners.add(listener);
    listener(currentWorking);
    return () => workingListeners.delete(listener);
  },
  onChanged: (listener) => {
    const handler = (_event, prefs) => listener(prefs);
    ipcRenderer.on('desktop:companion-changed', handler);
    return () => ipcRenderer.removeListener('desktop:companion-changed', handler);
  },
});
