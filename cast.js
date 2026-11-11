'use strict';
// Chromecast support: find Cast devices on the network, stream the program monitor to them
// as a live WebM (VP8/Opus) over HTTP, played by Google's Default Media Receiver.
const http = require('http');
const os = require('os');
const crypto = require('crypto');

let mdnsLib = null, CastClient = null, DefaultMediaReceiver = null;
function libs() {
  if (!mdnsLib) mdnsLib = require('multicast-dns');
  if (!CastClient) ({ Client: CastClient, DefaultMediaReceiver } = require('castv2-client'));
}

// ---------------------------------------------------------------- discovery
function discover(ms = 3500) {
  libs();
  return new Promise(resolve => {
    const m = mdnsLib();
    const found = new Map(); // instance name -> {name, host, port}
    const ips = new Map();   // target host -> ip
    const take = recs => {
      for (const r of recs) {
        if (r.type === 'PTR' && r.name === '_googlecast._tcp.local') { if (!found.has(r.data)) found.set(r.data, { id: r.data }); }
        else if (r.type === 'SRV') { const d = found.get(r.name) || { id: r.name }; d.port = r.data.port; d.target = r.data.target; found.set(r.name, d); }
        else if (r.type === 'TXT') {
          const d = found.get(r.name) || { id: r.name };
          for (const b of [].concat(r.data)) { const s = b.toString(); if (s.startsWith('fn=')) d.name = s.slice(3); if (s.startsWith('md=')) d.model = s.slice(3); }
          found.set(r.name, d);
        } else if (r.type === 'A') ips.set(r.name, r.data);
      }
    };
    m.on('response', res => take([...(res.answers || []), ...(res.additionals || [])]));
    const ask = () => { try { m.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] }); } catch (e) {} };
    ask(); const again = setTimeout(ask, 1200);
    setTimeout(() => {
      clearTimeout(again); try { m.destroy(); } catch (e) {}
      const list = [];
      for (const d of found.values()) {
        const host = ips.get(d.target);
        if (host && d.port) list.push({ id: d.id, name: d.name || d.id.replace(/\._googlecast.*$/, ''), model: d.model || '', host, port: d.port });
      }
      resolve(list);
    }, ms);
  });
}

// ---------------------------------------------------------------- LAN stream server
let lan = null, lanPort = 0, token = '', client = null, player = null, current = null, onRestart = () => {}, onState = () => {};
let sink = null; // the response currently receiving the stream

function lanAddressFor(host) {
  const cands = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) cands.push(a.address);
  const pre = host.split('.').slice(0, 3).join('.');
  return cands.find(a => a.startsWith(pre + '.')) || cands[0] || '127.0.0.1';
}
function startLan() {
  if (lan) return Promise.resolve();
  token = crypto.randomBytes(9).toString('hex');
  lan = http.createServer((req, res) => {
    if (req.url !== `/cast/${token}/live.webm`) { res.writeHead(404); return res.end(); }
    if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'video/webm' }); return res.end(); }
    if (sink) { try { sink.end(); } catch (e) {} }
    sink = res;
    res.writeHead(200, { 'Content-Type': 'video/webm', 'Cache-Control': 'no-cache, no-store', 'Access-Control-Allow-Origin': '*', Connection: 'keep-alive' });
    req.on('close', () => { if (sink === res) sink = null; });
    onRestart(); // ask the studio to start a fresh recording so the stream begins with a WebM header
  });
  return new Promise((resolve, reject) => { lan.once('error', reject); lan.listen(0, '0.0.0.0', () => { lanPort = lan.address().port; resolve(); }); });
}
function chunk(buf) { if (sink && buf) { try { sink.write(Buffer.from(buf)); } catch (e) {} } }

// ---------------------------------------------------------------- cast session
async function start(dev, hooks) {
  libs(); onRestart = hooks.onRestart || onRestart; onState = hooks.onState || onState;
  await stop(true);
  await startLan();
  const url = `http://${lanAddressFor(dev.host)}:${lanPort}/cast/${token}/live.webm`;
  current = dev;
  return new Promise((resolve, reject) => {
    const c = new CastClient(); client = c;
    const fail = err => { onState({ state: 'error', msg: String(err && err.message || err), device: dev.name }); try { c.close(); } catch (e) {} if (client === c) client = null; reject(err); };
    c.on('error', fail);
    c.connect({ host: dev.host, port: dev.port }, () => {
      c.launch(DefaultMediaReceiver, (err, p) => {
        if (err) return fail(err);
        player = p;
        p.on('status', st => { if (st && st.playerState) onState({ state: 'playing', playerState: st.playerState, device: dev.name }); });
        p.load({ contentId: url, contentType: 'video/webm', streamType: 'LIVE', metadata: { type: 0, metadataType: 0, title: 'Karaoke Lab' } }, { autoplay: true }, e2 => {
          if (e2) return fail(e2);
          onState({ state: 'connected', device: dev.name }); resolve({ ok: true, url });
        });
      });
    });
  });
}
async function stop(quiet) {
  const c = client, p = player; client = null; player = null;
  if (p) { try { await new Promise(r => p.stop(() => r())); } catch (e) {} }
  if (c) { try { c.close(); } catch (e) {} }
  if (sink) { try { sink.end(); } catch (e) {} sink = null; }
  if (!quiet && current) onState({ state: 'stopped', device: current.name });
  current = null;
}
module.exports = { discover, start, stop, chunk,
  // used by the automated tests: serve the stream without a TV
  _test: async hooks => { onRestart = hooks.onRestart; await startLan(); return `http://127.0.0.1:${lanPort}/cast/${token}/live.webm`; } };
