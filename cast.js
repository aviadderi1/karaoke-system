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
// Three ways, all at once, because home networks and firewalls differ:
//  1. mDNS "legacy unicast" query sent from a random port on every network adapter.
//     The TV answers straight back to that port, which Windows Firewall lets through.
//  2. A normal mDNS listener on port 5353 (multicast-dns).
//  3. SSDP / DIAL search (port 1900), which Chromecasts also answer.
const dgram = require('dgram');
const httpGet = (url, ms = 2500) => new Promise(res => {
  const req = http.get(url, r => { let d = ''; r.setEncoding('utf8'); r.on('data', c => d += c); r.on('end', () => res(d)); });
  req.on('error', () => res('')); req.setTimeout(ms, () => { req.destroy(); res(''); });
});
function ifaces() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
  return out;
}
function discover(ms = 4500) {
  libs();
  const dnsPacket = require('dns-packet');
  return new Promise(resolve => {
    const found = new Map(); // instance name -> {id,name,model,port,target}
    const ips = new Map();   // target host -> ip
    const byHost = new Map(); // ip -> device (SSDP and fallbacks)
    const socks = [];
    const take = (recs, from) => {
      for (const r of recs) {
        if (r.type === 'PTR' && /_googlecast\._tcp\.local$/i.test(r.name)) { if (!found.has(r.data)) found.set(r.data, { id: r.data }); }
        else if (r.type === 'SRV') { const d = found.get(r.name) || { id: r.name }; d.port = r.data.port; d.target = r.data.target; if (from) d.from = from; found.set(r.name, d); }
        else if (r.type === 'TXT') {
          const d = found.get(r.name) || { id: r.name };
          for (const b of [].concat(r.data)) { const s = b.toString(); if (s.startsWith('fn=')) d.name = s.slice(3); if (s.startsWith('md=')) d.model = s.slice(3); }
          if (from && !d.from) d.from = from; found.set(r.name, d);
        } else if (r.type === 'A') ips.set(r.name, r.data);
      }
    };
    const query = dnsPacket.encode({ type: 'query', id: 0, flags: 0, questions: [{ type: 'PTR', name: '_googlecast._tcp.local', class: 'IN' }] });
    const ssdp = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:dial-multiscreen-org:service:dial:1\r\n\r\n');
    const ssdpHits = new Set();
    // 1 + 3: per-adapter sockets on random ports
    for (const ifc of ifaces()) {
      try {
        const m = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        m.on('error', () => {}); m.on('message', (msg, rinfo) => { try { const p = dnsPacket.decode(msg); take([...(p.answers || []), ...(p.additionals || [])], rinfo.address); } catch (e) {} });
        m.bind(0, ifc.address, () => { try { m.setMulticastInterface(ifc.address); m.setMulticastTTL(255); } catch (e) {} const send = () => { try { m.send(query, 5353, '224.0.0.251'); } catch (e) {} }; send(); setTimeout(send, 900); setTimeout(send, 2200); });
        socks.push(m);
        const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        s.on('error', () => {}); s.on('message', (msg, rinfo) => { const t = msg.toString(); const loc = /LOCATION:\s*(\S+)/i.exec(t); if (loc && !ssdpHits.has(rinfo.address)) { ssdpHits.add(rinfo.address); byHost.set(rinfo.address, { loc: loc[1] }); } });
        s.bind(0, ifc.address, () => { try { s.setMulticastInterface(ifc.address); } catch (e) {} const send = () => { try { s.send(ssdp, 1900, '239.255.255.250'); } catch (e) {} }; send(); setTimeout(send, 1200); });
        socks.push(s);
      } catch (e) {}
    }
    // 2: classic listener on 5353
    let m5353 = null;
    try {
      m5353 = mdnsLib();
      m5353.on('error', () => {});
      m5353.on('response', (res, rinfo) => take([...(res.answers || []), ...(res.additionals || [])], rinfo && rinfo.address));
      const ask = () => { try { m5353.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] }); } catch (e) {} };
      ask(); setTimeout(ask, 1500);
    } catch (e) { m5353 = null; }

    setTimeout(async () => {
      for (const s of socks) { try { s.close(); } catch (e) {} }
      try { m5353 && m5353.destroy(); } catch (e) {}
      const list = [], seen = new Set();
      for (const d of found.values()) {
        const host = ips.get(d.target) || d.from;
        if (!host || seen.has(host)) continue;
        seen.add(host);
        list.push({ id: d.id, name: d.name || d.id.replace(/\._googlecast.*$/, ''), model: d.model || '', host, port: d.port || 8009 });
      }
      // SSDP devices not found by mDNS: read their name from the DIAL description
      await Promise.all([...byHost.entries()].filter(([ip]) => !seen.has(ip)).map(async ([ip, v]) => {
        const xml = await httpGet(v.loc);
        if (!/chromecast|google|cast/i.test(xml)) return;
        const name = (/<friendlyName>([^<]+)<\/friendlyName>/i.exec(xml) || [])[1] || ip;
        const model = (/<modelName>([^<]+)<\/modelName>/i.exec(xml) || [])[1] || '';
        seen.add(ip); list.push({ id: 'ssdp-' + ip, name, model, host: ip, port: 8009 });
      }));
      resolve(list);
    }, ms);
  });
}

// ---------------------------------------------------------------- LAN stream server
let lan = null, lanPort = 0, token = '', client = null, player = null, current = null, onRestart = () => {}, onState = () => {};
let sink = null; // the response currently receiving the stream
let gotStream = false;

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
    gotStream = true; onRestart(); // ask the studio to start a fresh recording so the stream begins with a WebM header
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
  current = dev; gotStream = false;
  return new Promise((resolve, reject) => {
    const c = new CastClient(); client = c;
    const to = setTimeout(() => fail(new Error(`No answer from ${dev.name} (${dev.host}). Check that the TV is on and on the same network.`)), 12000);
    const fail = err => { clearTimeout(to); onState({ state: 'error', msg: String(err && err.message || err), device: dev.name }); try { c.close(); } catch (e) {} if (client === c) client = null; reject(err); };
    c.on('error', fail);
    c.connect({ host: dev.host, port: dev.port }, () => {
      c.launch(DefaultMediaReceiver, (err, p) => {
        if (err) return fail(err);
        player = p;
        p.on('status', st => { if (st && st.playerState) onState({ state: 'playing', playerState: st.playerState, device: dev.name }); });
        p.load({ contentId: url, contentType: 'video/webm', streamType: 'LIVE', metadata: { type: 0, metadataType: 0, title: 'Karaoke Lab' } }, { autoplay: true }, e2 => {
          if (e2) return fail(e2);
          clearTimeout(to); onState({ state: 'connected', device: dev.name }); resolve({ ok: true, url });
          // the TV should start pulling the stream within a few seconds; if not, it can't reach this computer
          setTimeout(() => { if (current === dev && !gotStream) onState({ state: 'blocked', device: dev.name }); }, 12000);
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
