// Karaoke System - built-in local engine server (YouTube download + vocal separation)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MODELS = { htdemucs_ft: 4, htdemucs: 1 };
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.woff2': 'font/woff2', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.webm': 'audio/webm',
  '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.png': 'image/png' };

function createServer(opts) {
  const { appDir, workDir, ytdlpPath, denoDir, enginePath, modelsDir, version, log } = opts;
  fs.mkdirSync(workDir, { recursive: true });
  cleanup(workDir);
  const jobs = new Map();
  const procs = new Map();
  let sepQueue = Promise.resolve();

  const newJob = kind => { const id = crypto.randomBytes(6).toString('hex'); const j = { id, kind, state: 'running', progress: 0, msg: 'Starting', result: null }; jobs.set(id, j); return j; };
  const toolEnv = () => { const e = { ...process.env, PYTHONIOENCODING: 'utf-8', TORCH_HOME: modelsDir };
    if (denoDir) e.PATH = denoDir + path.delimiter + (process.env.PATH || ''); return e; };

  function cleanTitle(t) {
    return String(t || '').replace(/\s*[\(\[][^\)\]]*(official|video|audio|lyric|lyrics|clip|hd|4k|visualizer|קליפ|רשמי)[^\)\]]*[\)\]]/gi, '').replace(/\s{2,}/g, ' ').replace(/^[\s\-|]+|[\s\-|]+$/g, '');
  }

  function runYoutube(j, url) {
    if (!ytdlpPath || !fs.existsSync(ytdlpPath)) { Object.assign(j, { state: 'error', msg: 'The YouTube downloader is missing from this installation.' }); return; }
    const outTpl = path.join(workDir, j.id + '_yt.%(ext)s');
    const args = ['-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best', '--no-playlist', '--newline', '--no-warnings',
      '--no-simulate', '--print', 'after_move:KSJSON %(.{title,track,artist,creator,uploader,channel,duration,ext,filepath})j', '-o', outTpl, url];
    const p = spawn(ytdlpPath, args, { env: toolEnv(), windowsHide: true });
    procs.set(j.id, p);
    let info = null, err = '';
    const onLine = line => {
      const m = line.match(/\[download\]\s+([\d.]+)%/);
      if (m) { j.progress = Math.min(0.99, parseFloat(m[1]) / 100); j.msg = 'Downloading'; }
      if (line.startsWith('KSJSON ')) { try { info = JSON.parse(line.slice(7)); } catch (e) { } }
    };
    lines(p.stdout, onLine);
    lines(p.stderr, l => { if (l.trim()) err = (err + '\n' + l).slice(-1500); });
    p.on('error', e => Object.assign(j, { state: 'error', msg: String(e.message || e) }));
    p.on('close', code => {
      procs.delete(j.id);
      if (j.state === 'cancelled') return;
      if (code !== 0 || !info) { const last = err.trim().split('\n').pop() || `yt-dlp exited with code ${code}`; Object.assign(j, { state: 'error', msg: last.replace(/^ERROR:\s*/, '') }); return; }
      let file = info.filepath && fs.existsSync(info.filepath) ? info.filepath : null;
      if (!file) { const c = fs.readdirSync(workDir).find(f => f.startsWith(j.id + '_yt.')); if (c) file = path.join(workDir, c); }
      if (!file) { Object.assign(j, { state: 'error', msg: 'Download finished but the file was not found.' }); return; }
      let title = info.track || '', artist = info.artist || info.creator || '';
      if (!title) { const raw = cleanTitle(info.title || 'YouTube audio'); if (raw.includes(' - ') && !artist) { [artist, title] = raw.split(/ - (.*)/s).map(s => (s || '').trim()); } else title = raw; }
      if (!artist) artist = String(info.uploader || info.channel || '').replace(/\s*-\s*Topic$/, '');
      Object.assign(j, { state: 'done', progress: 1, msg: 'Done', result: { file: path.basename(file), title, artist, ext: path.extname(file).slice(1), duration: info.duration } });
    });
  }

  function runSeparate(j, inp, model) {
    sepQueue = sepQueue.then(() => new Promise(resolve => {
      if (j.state === 'cancelled') return resolve();
      if (!enginePath || !fs.existsSync(enginePath)) { Object.assign(j, { state: 'error', msg: 'The separation engine is missing from this installation.' }); return resolve(); }
      const out = path.join(workDir, j.id + '_sep');
      j.msg = 'Loading the separation model';
      const p = spawn(enginePath, [inp, out, '-n', model], { env: toolEnv(), windowsHide: true });
      procs.set(j.id, p);
      let nModels = MODELS[model] || 1, err = '';
      lines(p.stdout, l => {
        let m;
        if ((m = l.match(/^M (\d+)/))) nModels = +m[1];
        else if ((m = l.match(/^P (\d+) (\d+) (\d+)/))) { const idx = +m[1], done = +m[2], tot = +m[3]; j.progress = Math.min(0.99, ((idx - 1) + done / tot) / nModels); j.msg = 'Separating vocals' + (nModels > 1 ? ` (pass ${Math.min(idx, nModels)} of ${nModels})` : ''); }
        else if ((m = l.match(/^ERR (.*)/))) err = m[1];
      });
      lines(p.stderr, l => { if (l.trim() && !err) log && log('[engine] ' + l); });
      p.on('error', e => { Object.assign(j, { state: 'error', msg: String(e.message || e) }); resolve(); });
      p.on('close', code => {
        procs.delete(j.id); fs.rm(inp, { force: true }, () => { });
        if (j.state === 'cancelled') { fs.rm(out, { recursive: true, force: true }, () => { }); return resolve(); }
        const voc = path.join(out, 'vocals.wav'), pb = path.join(out, 'no_vocals.wav');
        if (code !== 0 || !fs.existsSync(voc) || !fs.existsSync(pb)) { Object.assign(j, { state: 'error', msg: err || `Separation failed (code ${code})` }); return resolve(); }
        const rv = j.id + '_vocals.wav', rp = j.id + '_playback.wav';
        fs.renameSync(voc, path.join(workDir, rv)); fs.renameSync(pb, path.join(workDir, rp)); fs.rm(out, { recursive: true, force: true }, () => { });
        Object.assign(j, { state: 'done', progress: 1, msg: 'Done', result: { vocals: rv, playback: rp } });
        resolve();
      });
    }));
  }

  function send(res, code, obj) { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); res.end(b); }
  function sendFile(res, p) {
    fs.stat(p, (e, st) => {
      if (e || !st.isFile()) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      fs.createReadStream(p).pipe(res);
    });
  }
  function readBody(req, cb) { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => cb(Buffer.concat(chunks))); }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': '*' }); return res.end(); }
    if (req.method === 'GET') {
      if (u.pathname === '/' || u.pathname === '/index.html') return sendFile(res, path.join(appDir, 'index.html'));
      if (u.pathname === '/status') return send(res, 200, { ok: true, desktop: true, version, device: 'cpu', ytdlp: !!(ytdlpPath && fs.existsSync(ytdlpPath)), engine: !!(enginePath && fs.existsSync(enginePath)) });
      if (u.pathname.startsWith('/job/')) return send(res, 200, jobs.get(u.pathname.slice(5)) || { state: 'missing', msg: 'Unknown job' });
      if (u.pathname.startsWith('/file/')) return sendFile(res, path.join(workDir, path.basename(decodeURIComponent(u.pathname.slice(6)))));
      if (u.pathname.startsWith('/assets/')) return sendFile(res, path.join(appDir, path.basename(u.pathname)));
      if (u.pathname.startsWith('/fonts/')) return sendFile(res, path.join(appDir, 'fonts', path.basename(decodeURIComponent(u.pathname))));
      return send(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST') {
      if (u.pathname === '/youtube') return readBody(req, b => { let url = ''; try { url = JSON.parse(b.toString() || '{}').url || ''; } catch (e) { } if (!/^https?:\/\//.test(url)) return send(res, 400, { error: 'bad url' }); const j = newJob('youtube'); runYoutube(j, url); send(res, 200, { job: j.id }); });
      if (u.pathname === '/separate') {
        let model = u.searchParams.get('model'); if (!MODELS[model]) model = 'htdemucs_ft';
        const j = newJob('separate'); const inp = path.join(workDir, j.id + '_in.wav'); const ws = fs.createWriteStream(inp);
        req.pipe(ws); ws.on('finish', () => { if (sepBusy(jobs, j)) j.msg = 'Waiting for the previous separation'; runSeparate(j, inp, model); send(res, 200, { job: j.id }); });
        ws.on('error', e => send(res, 500, { error: String(e) })); return;
      }
      if (u.pathname.startsWith('/cancel/')) { const id = u.pathname.slice(8); const j = jobs.get(id); if (j) Object.assign(j, { state: 'cancelled', msg: 'Cancelled' }); const p = procs.get(id); if (p) try { p.kill(); } catch (e) { } return send(res, 200, { ok: true }); }
    }
    send(res, 404, { error: 'not found' });
  });
  return server;
}

function sepBusy(jobs, self) { for (const j of jobs.values()) if (j !== self && j.kind === 'separate' && j.state === 'running') return true; return false; }
function lines(stream, fn) { let buf = ''; stream.setEncoding('utf8'); stream.on('data', d => { buf += d; const parts = buf.split(/\r?\n|\r/); buf = parts.pop(); parts.forEach(fn); }); stream.on('end', () => { if (buf) fn(buf); }); }
function cleanup(dir, hours = 24) { try { const now = Date.now(); for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); try { if (now - fs.statSync(p).mtimeMs > hours * 3600e3) fs.rmSync(p, { recursive: true, force: true }); } catch (e) { } } } catch (e) { } }

function listen(server, preferred = 8765) {
  return new Promise((resolve, reject) => {
    const tryPort = (port, left) => {
      server.once('error', e => { if (e.code === 'EADDRINUSE' && left > 0) tryPort(port + 1, left - 1); else reject(e); });
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    };
    tryPort(preferred, 20);
  });
}

module.exports = { createServer, listen };
