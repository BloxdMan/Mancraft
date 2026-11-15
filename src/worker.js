// Cubecraft multiplayer server: one Durable Object per lobby, WebSocket relay + persistent world edits.
// The terrain is generated deterministically in every browser, so the server only stores
// what players CHANGED (block edits, chest contents) and relays player positions.

const MAX_PLAYERS = 16;
const MAX_EDITS = 300000;   // per lobby, safety cap
const BATCH = 2500;         // edits per message when a player joins
const MAX_MSG = 64000;

const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const num = v => typeof v === 'number' && Number.isFinite(v);
const CHEST_KEY = /^-?\d{1,7},\d{1,3},-?\d{1,7}$/;

function cleanSkin(s) {
  if (s && typeof s === 'object') {
    if (typeof s.u === 'string' && s.u.length <= 40000 && s.u.startsWith('data:image/png;base64,') &&
        /^[A-Za-z0-9+/=]+$/.test(s.u.slice(22))) return { u: s.u };
    if (int(s.p, 0, 31)) return { p: s.p };
  }
  return { p: 0 };
}

function cleanChest(a) {
  if (!Array.isArray(a) || a.length !== 36) return null;
  return a.map(s => (s && int(s.id, 1, 255) && int(s.n, 1, 999)) ? { id: s.id, n: s.n } : null);
}

export class Lobby {
  constructor(state, env) {
    this.state = state;
    this.players = new Map();   // id -> player
    this.edits = new Map();     // "x,y,z" -> [blockId] or [blockId, dir]
    this.chests = new Map();    // "x,y,z" -> 36 slots
    this.dirty = new Set();     // storage keys waiting to be written
    this.alarmSet = false;
    this.nextId = 1;
    state.blockConcurrencyWhile(async () => {
      const all = await state.storage.list();
      for (const [k, v] of all) {
        if (k.startsWith('e:')) this.edits.set(k.slice(2), v);
        else if (k.startsWith('c:')) this.chests.set(k.slice(2), v);
      }
    });
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.join(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  join(ws) {
    const p = { ws, id: 0, joined: false, closed: false, name: 'Player', skin: { p: 0 },
                has: false, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, h: 0, c: 0, tok: 300, tl: Date.now() };
    ws.addEventListener('message', ev => this.onMessage(p, ev.data));
    ws.addEventListener('close', () => this.onClose(p));
    ws.addEventListener('error', () => this.onClose(p));
  }

  send(p, o) { try { p.ws.send(JSON.stringify(o)); } catch (e) {} }

  broadcast(o, except) {
    const s = JSON.stringify(o);
    for (const q of this.players.values()) if (q !== except) { try { q.ws.send(s); } catch (e) {} }
  }

  pub(p) {
    const o = { id: p.id, name: p.name, skin: p.skin, h: p.h, c: p.c };
    if (p.has) Object.assign(o, { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch });
    return o;
  }

  onMessage(p, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
    const now = Date.now();                       // token bucket: ~250 msgs/s, burst 300
    p.tok = Math.min(300, p.tok + (now - p.tl) * 0.25); p.tl = now;
    if (p.tok < 1) return;
    p.tok--;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (!p.joined) {
      if (m.t !== 'hi') return;
      if (this.players.size >= MAX_PLAYERS) { this.send(p, { t: 'full' }); try { p.ws.close(4001, 'full'); } catch (e) {} return; }
      p.joined = true;
      p.id = this.nextId++;
      p.name = String(m.name || 'Player').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || 'Player';
      p.skin = cleanSkin(m.skin);
      const others = [...this.players.values()].map(q => this.pub(q));
      this.players.set(p.id, p);
      this.send(p, { t: 'init', id: p.id, players: others, chests: Object.fromEntries(this.chests) });
      let batch = [];
      for (const [k, v] of this.edits) {
        const [x, y, z] = k.split(',').map(Number);
        batch.push(v.length > 1 ? [x, y, z, v[0], v[1]] : [x, y, z, v[0]]);
        if (batch.length >= BATCH) { this.send(p, { t: 'edits', e: batch }); batch = []; }
      }
      if (batch.length) this.send(p, { t: 'edits', e: batch });
      this.broadcast({ t: 'join', p: this.pub(p) }, p);
      return;
    }

    switch (m.t) {
      case 'p': {
        if (!(num(m.x) && num(m.y) && num(m.z) && num(m.yaw) && num(m.pitch))) return;
        if (Math.abs(m.x) > 1e7 || Math.abs(m.z) > 1e7 || m.y < -1000 || m.y > 1000) return;
        p.has = true; p.x = m.x; p.y = m.y; p.z = m.z; p.yaw = m.yaw; p.pitch = m.pitch;
        p.h = int(m.h, 0, 255) ? m.h : 0; p.c = m.c ? 1 : 0;
        if (this.players.size > 1)
          this.broadcast({ t: 'p', id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, h: p.h, c: p.c, sw: m.sw ? 1 : 0 }, p);
        break;
      }
      case 'b': {
        if (!(int(m.x, -1e6, 1e6) && int(m.y, 0, 191) && int(m.z, -1e6, 1e6) && int(m.b, 0, 255))) return;
        const hasD = m.b !== 0 && int(m.d, 0, 3);
        const k = m.x + ',' + m.y + ',' + m.z;
        if (this.edits.has(k) || this.edits.size < MAX_EDITS) {
          this.edits.set(k, hasD ? [m.b, m.d] : [m.b]);
          this.dirty.add('e:' + k);
        }
        if (m.b !== 47 && this.chests.delete(k)) this.dirty.add('c:' + k);
        this.schedule();
        const o = { t: 'b', x: m.x, y: m.y, z: m.z, b: m.b };
        if (hasD) o.d = m.d;
        this.broadcast(o, p);
        break;
      }
      case 'ch': {
        if (typeof m.k !== 'string' || !CHEST_KEY.test(m.k)) return;
        const a = cleanChest(m.a);
        if (!a) return;
        this.chests.set(m.k, a);
        this.dirty.add('c:' + m.k);
        this.schedule();
        this.broadcast({ t: 'ch', k: m.k, a }, p);
        break;
      }
      case 'sk': {
        p.skin = cleanSkin(m.skin);
        this.broadcast({ t: 'sk', id: p.id, skin: p.skin }, p);
        break;
      }
    }
  }

  onClose(p) {
    if (p.closed) return;
    p.closed = true;
    if (p.joined) {
      this.players.delete(p.id);
      this.broadcast({ t: 'leave', id: p.id });
    }
    if (!this.players.size) this.flush();
  }

  schedule() {
    if (this.alarmSet) return;
    this.alarmSet = true;
    this.state.storage.setAlarm(Date.now() + 1500);
  }

  async alarm() { this.alarmSet = false; await this.flush(); }

  async flush() {
    const keys = [...this.dirty]; this.dirty.clear();
    let put = {}, pn = 0, del = [];
    const commit = async () => {
      if (pn) { await this.state.storage.put(put); put = {}; pn = 0; }
      if (del.length) { await this.state.storage.delete(del); del = []; }
    };
    for (const k of keys) {
      const v = k[0] === 'e' ? this.edits.get(k.slice(2)) : this.chests.get(k.slice(2));
      if (v === undefined) del.push(k); else { put[k] = v; pn++; }
      if (pn >= 100 || del.length >= 100) await commit();
    }
    await commit();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      const lobby = (url.searchParams.get('lobby') || '').trim().toLowerCase().slice(0, 32);
      const mode = url.searchParams.get('mode') === 'peace' ? 'peace' : 'open';
      if (!lobby) return new Response('Missing lobby', { status: 400 });
      const id = env.LOBBY.idFromName(mode + ':' + lobby);
      return env.LOBBY.get(id).fetch(request);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Cubecraft server is running.');
  }
};
