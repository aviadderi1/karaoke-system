'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lw', {
  action: (act, arg) => ipcRenderer.invoke('ks:lw-action', act, arg),
  onUrl: cb => ipcRenderer.on('ks:lw-url', (_e, u) => cb(u))
});
