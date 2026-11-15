'use strict';
/*
 * Cubecraft multiplayer server
 *   npm install
 *   node server.js            (default port 3000, override with PORT=4000)
 *
 * - Serves Cubecraft.html (and /textures/*) over HTTP, so players can just open http://<your-ip>:3000
 * - Relays player positions and block edits over WebSocket
 * - Each lobby name = one room with its own world edits, saved to ./worlds/<room>.json
 *   (terrain itself is generated from fixed seeds on every client, so only edits are stored)
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 3000;
const MAX_PLAYERS = +process.env.MAX_PLAYERS || 16;   // per room
const MAX_EDITS = +process.env.MAX_EDITS || 1000000;  // per room
const ROOT = __dirname;
const WORLDS = path.join(ROOT, 'worlds');
fs.mkdirSync(WORLDS, { recursive: true });

/* ---------------- HTTP: serve the game ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.json': 'application/json',
  '.js': 'text/javascript', '.css': 'text/css'
};
const GAME = path.join(ROOT, 'Cubecraft.html');
const TEXTURES = path.join(ROOT, 'textures') + path.sep;

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400).end('Bad request'); return; }
  if (p === '/' || p === '/index.html') p = '/Cubecraft.html';
  const file = path.join(ROOT, p);                       // normalised, so ../ is resolved here
  if (file !== GAME && !file.startsWith(TEXTURES)) { res.writeHead(404).end('Not found'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
});

/* ---------------- Rooms ---------------- */
const rooms = new Map();
let nextId = 1;

function getRoom(name) {
  let r = rooms.get(name);
  if (r) return r;
  r = { name, players: new Map(), edits: new Map(), dirty: false };
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(WORLDS, name + '.json'), 'utf8'));
    for (const e of arr) r.edits.set(e[0] + ',' + e[1] + ',' + e[2], e);
    console.log(`[room ${name}] loaded ${r.edits.size} edits`);
  } catch { /* new world */ }
  rooms.set(name, r);
  return r;
}

function saveRoom(r) {
  if (!r.dirty) return;
  r.dirty = false;
  const f = path.join(WORLDS, r.name + '.json');
  try {
    fs.writeFileSync(f + '.tmp', JSON.stringify([...r.edits.values()]));
    fs.renameSync(f + '.tmp', f);
  } catch (e) {
    r.dirty = true;
    console.error(`[room ${r.name}] save failed:`, e.message);
  }
}
setInterval(() => { for (const r of rooms.values()) saveRoom(r); }, 10000);

/* ---------------- Helpers ---------------- */
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const flt = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const validSkin = s => typeof s === 'string' && s.length <= 150000 && s.startsWith('data:image/png;base64,');
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
function bcast(room, m, except) {
  const s = JSON.stringify(m);
  for (const c of room.players.values()) if (c !== except && c.ws.readyState === 1) c.ws.send(s);
}
const pub = c => ({ id: c.id, name: c.name, skin: c.skin, has: c.has ? 1 : 0, ...c.st });

// token bucket: returns true if the action is allowed
function allow(c, key, perSec, burst) {
  const now = Date.now();
  const b = c.rl[key] || (c.rl[key] = { t: burst, l: now });
  b.t = Math.min(burst, b.t + (now - b.l) / 1000 * perSec);
  b.l = now;
  if (b.t < 1) return false;
  b.t -= 1;
  return true;
}

/* ---------------- WebSocket ---------------- */
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

wss.on('connection', ws => {
  let c = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const joinTimer = setTimeout(() => { if (!c) ws.close(); }, 10000);

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;

    /* ----- join ----- */
    if (!c) {
      if (m.t !== 'join') return;
      const rname = String(m.room || 'main').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'main';
      const room = getRoom(rname);
      if (room.players.size >= MAX_PLAYERS) {
        send(ws, { t: 'err', msg: `Room "${rname}" is full (${MAX_PLAYERS} players).` });
        ws.close();
        if (!room.players.size) rooms.delete(rname);
        return;
      }
      const id = nextId++;
      const name = String(m.name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16) || 'Player' + id;
      c = { id, ws, room, name, skin: validSkin(m.skin) ? m.skin : null, has: false,
            st: { x: 0, y: 0, z: 0, a: 0, b: 0, h: 0, ph: 1.8 }, rl: {} };
      clearTimeout(joinTimer);

      const others = [...room.players.values()].map(pub);
      room.players.set(id, c);
      bcast(room, { t: 'join', p: pub(c) }, c);

      send(ws, { t: 'welcome', id, room: rname, players: others });
      const all = [...room.edits.values()];
      for (let i = 0; i < all.length; i += 4000) send(ws, { t: 'edits', e: all.slice(i, i + 4000) });
      send(ws, { t: 'ready' });
      console.log(`[room ${rname}] ${c.name} (#${id}) joined — ${room.players.size} online`);
      return;
    }

    /* ----- in-room messages ----- */
    const room = c.room;
    switch (m.t) {
      case 'p': {
        if (!allow(c, 'p', 40, 60)) return;
        if (!(flt(m.x, -3e7, 3e7) && flt(m.y, -64, 512) && flt(m.z, -3e7, 3e7) && flt(m.a, -1e7, 1e7) &&
              flt(m.b, -4, 4) && int(m.h, 0, 255) && flt(m.ph, 0.5, 2.5))) return;
        c.st = { x: m.x, y: m.y, z: m.z, a: m.a, b: m.b, h: m.h, ph: m.ph };
        c.has = true;
        bcast(room, { t: 'p', id: c.id, ...c.st, s: m.s ? 1 : 0 }, c);
        break;
      }
      case 'b': {
        if (!allow(c, 'b', 60, 120)) return;
        if (!(int(m.x, -3e7, 3e7) && int(m.y, 0, 191) && int(m.z, -3e7, 3e7) && int(m.b, 0, 255))) return;
        const hasD = m.b !== 0 && int(m.d, 0, 3);
        const key = m.x + ',' + m.y + ',' + m.z;
        if (room.edits.size >= MAX_EDITS && !room.edits.has(key)) return;
        const e = hasD ? [m.x, m.y, m.z, m.b, m.d] : [m.x, m.y, m.z, m.b];
        room.edits.set(key, e);
        room.dirty = true;
        const out = { t: 'b', x: m.x, y: m.y, z: m.z, b: m.b };
        if (hasD) out.d = m.d;
        bcast(room, out, c);
        break;
      }
      case 'skin': {
        if (!allow(c, 'skin', 0.5, 2) || !validSkin(m.skin)) return;
        c.skin = m.skin;
        bcast(room, { t: 'skin', id: c.id, skin: m.skin }, c);
        break;
      }
    }
  });

  ws.on('close', () => {
    clearTimeout(joinTimer);
    if (!c) return;
    const room = c.room;
    room.players.delete(c.id);
    bcast(room, { t: 'leave', id: c.id });
    console.log(`[room ${room.name}] ${c.name} (#${c.id}) left — ${room.players.size} online`);
    if (!room.players.size) { saveRoom(room); rooms.delete(room.name); }
  });
  ws.on('error', () => {});
});

// drop dead connections
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

function shutdown() {
  for (const r of rooms.values()) saveRoom(r);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`Cubecraft server running on port ${PORT}`);
  console.log(`  This computer:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  Same network:   http://${i.address}:${PORT}`);
  console.log('Players open one of those addresses, press Open World / Peaceful, and press Play.');
});
