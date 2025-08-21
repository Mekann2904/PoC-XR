const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openModel: () => ipcRenderer.invoke('dialog:open-model'),
  getStore: (key) => ipcRenderer.invoke('store:get', key),
  setStore: (partial) => ipcRenderer.invoke('store:set', partial),
  listRecents: () => ipcRenderer.invoke('recent:list'),
  addRecent: (path) => ipcRenderer.invoke('recent:add', path),
  setBaseDir: (dir) => ipcRenderer.invoke('fs:set-base', dir),
  fsRead: (absPath) => ipcRenderer.invoke('fs:read', absPath)
});
