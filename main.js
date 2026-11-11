// Karaoke System - AD SOUND & SERVICE
'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, shell, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const { createServer, listen } = require('./server');

const REPO = { owner: 'aviadderi1', repo: 'karaoke-system' };
const SPLASH_MS = 7000;
const isWin = process.platform === 'win32', isMac = process.platform === 'darwin';
let splash = null, mainWin = null, port = 0, updateInfo = null;

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } });

const res = (...p) => app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(__dirname, 'resources', ...p);
const log = (...a) => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'karaoke-system.log'), new Date().toISOString() + ' ' + a.join(' ') + '\n'); } catch (e) { } };

ipcMain.on('ks:version', e => { e.returnValue = app.getVersion(); });
ipcMain.handle('ks:open-external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('ks:check-updates', () => checkUpdates(true));
ipcMain.handle('ks:install-update', () => installUpdate());

// ------------------------------------------------------------ lyrics web browser
let lw = null, lv = null;
const BAR_H = 46;
function lwUrlFor(q) { q = String(q || '').trim(); if (/^https?:\/\//i.test(q)) return q; if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(q)) return 'https://' + q; return 'https://www.google.com/search?q=' + encodeURIComponent(q); }
function openLyricsWeb(q) {
  const url = lwUrlFor(q);
  if (lw && !lw.isDestroyed()) { lv.webContents.loadURL(url); lw.show(); lw.focus(); return; }
  lw = new BrowserWindow({ width: 1150, height: 820, title: 'Find lyrics on the web · Karaoke System', backgroundColor: '#1d1d1d', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'), webPreferences: { preload: path.join(__dirname, 'lyrics-preload.js'), contextIsolation: true } });
  lw.loadFile(path.join(__dirname, 'lyrics-browser.html'));
  lv = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } });
  lw.contentView.addChildView(lv);
  const layout = () => { if (!lw || lw.isDestroyed()) return; const [w, h] = lw.getContentSize(); lv.setBounds({ x: 0, y: BAR_H, width: w, height: Math.max(0, h - BAR_H) }); };
  layout(); lw.on('resize', layout);
  const wc = lv.webContents;
  wc.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) wc.loadURL(url); return { action: 'deny' }; });
  const sendUrl = () => { if (lw && !lw.isDestroyed()) lw.webContents.send('ks:lw-url', wc.getURL()); };
  wc.on('did-navigate', sendUrl); wc.on('did-navigate-in-page', sendUrl);
  lw.webContents.once('did-finish-load', sendUrl);
  lw.on('closed', () => { lw = null; lv = null; });
  wc.loadURL(url);
}
ipcMain.handle('ks:lyrics-web', (_e, q) => openLyricsWeb(q));
ipcMain.handle('ks:lw-action', async (_e, act, arg) => {
  if (!lv || lv.webContents.isDestroyed()) return { ok: false };
  const wc = lv.webContents, nh = wc.navigationHistory;
  if (act === 'back') { if (nh ? nh.canGoBack() : wc.canGoBack()) nh ? nh.goBack() : wc.goBack(); return { ok: true }; }
  if (act === 'forward') { if (nh ? nh.canGoForward() : wc.canGoForward()) nh ? nh.goForward() : wc.goForward(); return { ok: true }; }
  if (act === 'reload') { wc.reload(); return { ok: true }; }
  if (act === 'go') { if (arg) wc.loadURL(lwUrlFor(arg)); return { ok: true }; }
  if (act === 'take') {
    let text = '';
    try { text = await wc.executeJavaScript(arg === 'page' ? 'document.body ? document.body.innerText : ""' : 'String(window.getSelection ? window.getSelection() : "")', true); } catch (e) { }
    text = String(text || '').trim();
    if (!text) return { ok: false };
    if (mainWin && !mainWin.isDestroyed()) { mainWin.webContents.send('ks:lyrics-text', text); }
    return { ok: true, lines: text.split(/\n/).filter(l => l.trim()).length };
  }
  return { ok: false };
});

// ------------------------------------------------------------ tools
function prepareYtdlp() {
  const name = isWin ? 'yt-dlp.exe' : 'yt-dlp';
  const bundled = res('bin', name);
  if (!fs.existsSync(bundled)) return null;
  // copy to a writable place so it can update itself (YouTube changes often)
  const dir = path.join(app.getPath('userData'), 'bin');
  const target = path.join(dir, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = path.join(dir, 'bundled-version.txt');
    const bundledStamp = String(fs.statSync(bundled).size) + '|' + app.getVersion();
    if (!fs.existsSync(target) || (fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : '') !== bundledStamp) {
      fs.copyFileSync(bundled, target); fs.chmodSync(target, 0o755); fs.writeFileSync(stamp, bundledStamp);
    }
    return target;
  } catch (e) { log('ytdlp copy failed', e.message); return bundled; }
}
function selfUpdateYtdlp(p) {
  if (!p) return;
  const stampFile = path.join(app.getPath('userData'), 'bin', 'last-update.txt');
  try { if (Date.now() - +fs.readFileSync(stampFile, 'utf8') < 24 * 3600e3) return; } catch (e) { }
  try {
    const c = spawn(p, ['-U'], { windowsHide: true });
    c.on('close', code => { log('yt-dlp -U exit', code); if (code === 0) fs.writeFileSync(stampFile, String(Date.now())); });
    c.on('error', () => { });
  } catch (e) { }
}

// ------------------------------------------------------------ windows
function createSplash() {
  splash = new BrowserWindow({ width: 760, height: 428, frame: false, resizable: false, movable: true, center: true, show: false,
    backgroundColor: '#07040f', skipTaskbar: false, title: 'Karaoke System', icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true } });
  splash.loadFile(path.join(__dirname, 'splash.html'), { query: { v: app.getVersion() } });
  splash.once('ready-to-show', () => splash.show());
}
function createMain() {
  mainWin = new BrowserWindow({ width: 1600, height: 950, minWidth: 1100, minHeight: 680, show: false, backgroundColor: '#161616',
    title: 'Karaoke System', icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  if (!isMac) mainWin.setMenuBarVisibility(false);
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || url === '') {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1280, height: 760, title: 'Program monitor · Karaoke System', backgroundColor: '#000', autoHideMenuBar: true, icon: path.join(__dirname, 'build', 'icon.png') } };
    }
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`http://127.0.0.1:${port}`)) { e.preventDefault(); shell.openExternal(url); } });
  mainWin.on('page-title-updated', e => e.preventDefault());
  mainWin.loadURL(`http://127.0.0.1:${port}/`);
}
function macMenu() {
  if (!isMac) { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Karaoke System', submenu: [{ role: 'about' }, { label: 'Check for updates…', click: () => checkUpdates(true) }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' }]));
}

// ------------------------------------------------------------ updates
function sendUpdate(info) { updateInfo = info; if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('ks:update', info); }
function cmpVer(a, b) { const pa = String(a).replace(/^v/, '').split('.').map(Number), pb = String(b).replace(/^v/, '').split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; } return 0; }
function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Karaoke-System', Accept: 'application/vnd.github+json' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return getJSON(r.headers.location).then(resolve, reject);
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { r.statusCode === 200 ? resolve(JSON.parse(d)) : reject(new Error('HTTP ' + r.statusCode)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
let autoUpdater = null;
function setupAutoUpdater() {
  if (!isWin || !app.isPackaged) return;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', i => sendUpdate({ state: 'downloading', version: i.version, percent: 0 }));
    autoUpdater.on('download-progress', p => sendUpdate({ state: 'downloading', version: updateInfo && updateInfo.version, percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', i => sendUpdate({ state: 'ready', version: i.version }));
    autoUpdater.on('update-not-available', () => { if (updateInfo && updateInfo.manual) sendUpdate({ state: 'none', version: app.getVersion() }); });
    autoUpdater.on('error', e => { log('updater', e && e.message); if (updateInfo && updateInfo.manual) sendUpdate({ state: 'error', msg: String(e && e.message || e) }); });
  } catch (e) { log('electron-updater missing', e.message); autoUpdater = null; }
}
async function checkUpdates(manual) {
  if (manual) updateInfo = { manual: true };
  if (autoUpdater) { try { await autoUpdater.checkForUpdates(); } catch (e) { log('check', e.message); } return; }
  try {
    const rel = await getJSON(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}/releases/latest`);
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    if (latest && cmpVer(latest, app.getVersion()) > 0) {
      const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
      const asset = (rel.assets || []).find(a => a.name.endsWith('.dmg') && a.name.includes(arch)) || (rel.assets || []).find(a => isWin ? a.name.endsWith('.exe') : a.name.endsWith('.dmg'));
      sendUpdate({ state: 'available', version: latest, url: asset ? asset.browser_download_url : rel.html_url, notes: rel.body || '' });
    } else if (manual) sendUpdate({ state: 'none', version: app.getVersion() });
  } catch (e) { log('update check failed', e.message); if (manual) sendUpdate({ state: 'error', msg: 'Could not reach the update server.' }); }
}
function installUpdate() {
  if (updateInfo && updateInfo.state === 'ready' && autoUpdater) { setImmediate(() => autoUpdater.quitAndInstall(false, true)); return; }
  if (updateInfo && updateInfo.url) shell.openExternal(updateInfo.url);
}

// ------------------------------------------------------------ boot
app.whenReady().then(async () => {
  macMenu();
  createSplash();
  const t0 = Date.now();
  const status = msg => { try { splash && !splash.isDestroyed() && splash.webContents.executeJavaScript(`window.ksStatus&&ksStatus(${JSON.stringify(msg)})`); } catch (e) { } };
  let engineErr = null;
  try {
    status('Starting audio engine');
    const ytdlp = prepareYtdlp();
    const engineName = isWin ? 'ks-separate.exe' : 'ks-separate';
    const server = createServer({
      appDir: path.join(__dirname, 'app'), workDir: path.join(app.getPath('temp'), 'karaoke-system-work'),
      ytdlpPath: ytdlp, denoDir: fs.existsSync(res('bin')) ? res('bin') : null,
      enginePath: res('engine', 'ks-separate', engineName), modelsDir: res('models'), version: app.getVersion(), log
    });
    port = await listen(server, 8765);
    status('Loading separation models');
    selfUpdateYtdlp(ytdlp);
    setupAutoUpdater();
  } catch (e) { engineErr = e; log('boot error', e.stack || e.message); }
  createMain();
  const ready = new Promise(r => mainWin.webContents.once('did-finish-load', r));
  await Promise.all([ready, new Promise(r => setTimeout(r, Math.max(0, SPLASH_MS - (Date.now() - t0))))]);
  mainWin.maximize(); mainWin.show();
  if (splash && !splash.isDestroyed()) splash.close();
  if (engineErr) dialog.showErrorBox('Karaoke System', 'The built-in engine could not start:\n' + engineErr.message);
  setTimeout(() => checkUpdates(false), 6000);
});
app.on('window-all-closed', () => app.quit());
