'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ksDesktop', {
  version: ipcRenderer.sendSync('ks:version'),
  platform: process.platform,
  onUpdate: cb => ipcRenderer.on('ks:update', (_e, info) => cb(info)),
  checkUpdates: () => ipcRenderer.invoke('ks:check-updates'),
  installUpdate: () => ipcRenderer.invoke('ks:install-update'),
  openExternal: url => ipcRenderer.invoke('ks:open-external', url),
  onSplash: cb => ipcRenderer.on('ks:splash', (_e, info) => cb(info)),
  openLyricsWeb: q => ipcRenderer.invoke('ks:lyrics-web', q),
  onLyricsText: cb => ipcRenderer.on('ks:lyrics-text', (_e, t) => cb(t)),
  saveProject: (json, name, saveAs, lastPath) => ipcRenderer.invoke('ks:save-project', json, name, saveAs, lastPath),
  onAskClose: cb => ipcRenderer.on('ks:ask-close', () => cb()),
  closeOk: () => ipcRenderer.send('ks:close-ok'),
  onEdit: cb => ipcRenderer.on('ks:edit', (_e, a) => cb(a)),
  saveManual: () => ipcRenderer.invoke('ks:manual'),
  castDiscover: () => ipcRenderer.invoke('ks:cast-discover'),
  castStart: dev => ipcRenderer.invoke('ks:cast-start', dev),
  castStop: () => ipcRenderer.invoke('ks:cast-stop'),
  fixFirewall: () => ipcRenderer.invoke('ks:fix-firewall'),
  castChunk: buf => ipcRenderer.send('ks:cast-chunk', buf),
  onCastRestart: cb => ipcRenderer.on('ks:cast-restart', () => cb()),
  onCastState: cb => ipcRenderer.on('ks:cast-state', (_e, st) => cb(st))
});
