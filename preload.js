'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ksDesktop', {
  version: ipcRenderer.sendSync('ks:version'),
  platform: process.platform,
  onUpdate: cb => ipcRenderer.on('ks:update', (_e, info) => cb(info)),
  checkUpdates: () => ipcRenderer.invoke('ks:check-updates'),
  installUpdate: () => ipcRenderer.invoke('ks:install-update'),
  openExternal: url => ipcRenderer.invoke('ks:open-external', url),
  onSplash: cb => ipcRenderer.on('ks:splash', (_e, info) => cb(info))
});
