#!/usr/bin/env node
/*
 * Dragon Arena server — real-time, human-playable UNSW Battlecode 2026.
 *
 *   node server.js                 # http://0.0.0.0:8080
 *   PORT=9000 node server.js
 *
 * No npm dependencies. Serves the browser client, hosts rooms over WebSocket, runs the
 * authoritative game (lib/match.js) and stores replays under ./replays.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const Eng = require('./lib/engine');
const AI = require('./lib/ai');
const { Match, MODES } = require('./lib/match');
const { attach } = require('./lib/ws');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '';   // empty = every interface, IPv6 and IPv4 alike (an IPv6-only VPS needs this)
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const MAP_DIR = path.join(ROOT, 'maps');
const REPLAY_DIR = process.env.REPLAY_DIR || path.join(ROOT, 'replays');
const MAX_ROOMS = 60, MAX_REPLAYS = 80, MAX_MEMBERS = 12, MAX_PLAYERS = 3000;
// Optional shared secret: when set, only people whose link carries ?key=... can connect.
const ACCESS_KEY = process.env.ACCESS_KEY || '';

const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);

// ---------------------------------------------------------------- maps
const maps = new Map(); // id -> { id, name, w, h, perTeam, symmetry, kelp, portals, parsed, preview }
function describeMap(id, parsed) {
  const g = Eng.createGame(parsed, { seed: 1 });
  const st = Eng.staticMap(g);
  let kelp = 0, portals = 0;
  for (let i = 0; i < g.n; i++) { kelp += (g.edgeN[i] === 1) + (g.edgeW[i] === 1); portals += (g.edgeN[i] === 2) + (g.edgeW[i] === 2); }
  return {
    id, name: g.name, w: g.w, h: g.h, symmetry: g.symmetry, kelp, portals: portals / 2,
    perTeam: [Eng.teamCount(g, 0), Eng.teamCount(g, 1)],
    startLength: [Eng.summary(g, 0).total, Eng.summary(g, 1).total],
    spawnTiles: st.spawns.reduce((a, b) => a + b, 0),
    parsed,
    preview: { map: st, dragons: Eng.snapshot(g).dragons },
  };
}
function loadMaps() {
  for (const f of fs.readdirSync(MAP_DIR).filter((x) => x.endsWith('.map')).sort()) {
    const id = f.replace(/\.map$/, '');
    try { maps.set(id, describeMap(id, Eng.parseMap(fs.readFileSync(path.join(MAP_DIR, f), 'utf8')))); }
    catch (e) { log(`skipping map ${f}: ${e.message}`); }
  }
  log(`loaded ${maps.size} maps: ${Array.from(maps.keys()).join(', ')}`);
}
const mapSummary = (m) => ({ id: m.id, name: m.name, w: m.w, h: m.h, symmetry: m.symmetry, kelp: m.kelp, portals: m.portals, perTeam: m.perTeam, startLength: m.startLength, spawnTiles: m.spawnTiles });

// ---------------------------------------------------------------- replays
fs.mkdirSync(REPLAY_DIR, { recursive: true });
function saveReplay(replay) {
  const id = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(4).toString('hex');
  replay.id = id;
  zlib.gzip(JSON.stringify(replay), (zerr, data) => {
    if (zerr) { log('replay compress failed:', zerr.message); return; }
    fs.writeFile(path.join(REPLAY_DIR, id + '.json.gz'), data, (err) => {
      if (err) { log('replay save failed:', err.message); return; }
      fs.readdir(REPLAY_DIR, (e2, names) => {
        if (e2) return;
        const files = names.filter((f) => f.endsWith('.json.gz')).sort();
        while (files.length > MAX_REPLAYS) fs.unlink(path.join(REPLAY_DIR, files.shift()), () => {});
      });
    });
  });
  return id;
}

// ---------------------------------------------------------------- http
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  try { handleHttp(req, res); }
  catch (e) { try { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad request'); } catch (e2) { /* socket already gone */ } }
});
server.on('clientError', (err, socket) => { socket.destroy(); });

function handleHttp(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { 'Content-Type': 'text/plain' }); res.end('method not allowed'); return; }
  const url = new URL(req.url, 'http://x');                 // throws on junk such as "//" -> 400 above
  const p = decodeURIComponent(url.pathname);               // throws on "%ff" -> 400 above
  if (p.includes('\0')) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad request'); return; }
  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  const rep = /^\/replay\/([0-9]{8}-[0-9a-f]{8})$/.exec(p);
  if (rep) {
    const file = path.join(REPLAY_DIR, rep[1] + '.json.gz');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('replay not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    });
    return;
  }
  if (p === '/replays') {
    fs.readdir(REPLAY_DIR, (err, names) => {
      const files = (err ? [] : names).filter((f) => f.endsWith('.json.gz')).sort().reverse().slice(0, 40);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=5' });
      res.end(JSON.stringify(files.map((f) => f.replace('.json.gz', ''))));
    });
    return;
  }
  let file;
  if (p === '/') file = path.join(PUBLIC, 'index.html');
  else if (p === '/engine.js') file = path.join(ROOT, 'lib', 'engine.js');
  else file = path.join(PUBLIC, path.normalize(p).replace(/^([/\\]|\.\.)+/, ''));
  if (!file.startsWith(PUBLIC) && file !== path.join(ROOT, 'lib', 'engine.js')) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---------------------------------------------------------------- players & rooms
const players = new Map();  // token -> { id, token, name, ws, room }
const rooms = new Map();    // code -> room
let nextPlayerId = 1;

const DEFAULT_SETTINGS = { mapId: 'default_small', roundMs: 500, turnTimer: 1500, maxRounds: 500, assist: true };

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[crypto.randomInt(letters.length)];
    if (!rooms.has(c)) return c;
  }
}

function send(player, msg) { if (player && player.ws && player.ws.open) player.ws.send(JSON.stringify(msg)); }
function fail(player, msg) { send(player, { t: 'error', msg }); }

function roomState(room) {
  const custom = room.customMap;
  return {
    t: 'room', code: room.code, phase: room.phase, host: room.hostId,
    members: Array.from(room.members.values()).map((m) => ({ id: m.id, name: m.name, online: !!(m.ws && m.ws.open) })),
    seats: room.seats.map((s) => ({ kind: s.kind, style: s.style || null, player: s.player || null })),
    settings: room.settings,
    map: room.settings.mapId === 'custom' && custom ? mapSummary(custom) : (maps.has(room.settings.mapId) ? mapSummary(maps.get(room.settings.mapId)) : null),
    lastReplay: room.lastReplay || null,
    score: room.score,
  };
}
function broadcast(room, msg, filter) {
  const text = JSON.stringify(msg);
  for (const m of room.members.values()) if (m.ws && m.ws.open && (!filter || filter(m))) m.ws.send(text);
}
const pushRoom = (room) => broadcast(room, roomState(room));
const seatOf = (room, player) => room.seats.findIndex((s) => s.kind === 'human' && s.player === player.id);

function createRoom(player) {
  if (rooms.size >= MAX_ROOMS) { fail(player, 'The server is full of rooms right now.'); return; }
  leaveRoom(player);
  const room = {
    code: makeCode(), hostId: player.id, phase: 'lobby', members: new Map(),
    seats: [{ kind: 'human', player: player.id }, { kind: 'open' }],
    settings: Object.assign({}, DEFAULT_SETTINGS), customMap: null, match: null, lastReplay: null,
    score: [0, 0, 0], touched: Date.now(),
  };
  rooms.set(room.code, room);
  room.members.set(player.id, player);
  player.room = room;
  log(`room ${room.code} created by ${player.name}`);
  pushRoom(room);
  sendMapPreview(room, player);
}

function joinRoom(player, code) {
  const room = rooms.get((typeof code === 'string' ? code : '').toUpperCase().trim());
  if (!room) { fail(player, 'No room with that code.'); return; }
  if (player.room === room) { resync(player); return; }
  if (room.members.size >= MAX_MEMBERS && !room.members.has(player.id)) { fail(player, 'That room is full.'); return; }
  leaveRoom(player);
  room.members.set(player.id, player);
  player.room = room;
  room.touched = Date.now();
  if (room.phase === 'lobby' && seatOf(room, player) < 0) {
    const open = room.seats.findIndex((s) => s.kind === 'open');
    if (open >= 0) room.seats[open] = { kind: 'human', player: player.id };
  }
  log(`${player.name} joined room ${room.code}`);
  pushRoom(room);
  resync(player);
}

/** Bring a (re)connecting member fully up to date. */
function resync(player) {
  const room = player.room;
  if (!room) return;
  send(player, roomState(room));
  sendMapPreview(room, player);
  if (room.match && room.phase !== 'lobby') {
    const seat = seatOf(room, player);
    room.match.flush(); // anything already applied to the state must not reach this client again as a delta
    send(player, Object.assign({ t: 'sync', you: seat }, room.match.sync(seat >= 0 ? seat : null)));
    if (seat >= 0) room.match.setConnected(seat, true);
  }
}

function leaveRoom(player) {
  const room = player.room;
  if (!room) return;
  player.room = null;
  room.members.delete(player.id);
  const seat = seatOf(room, player);
  if (seat >= 0) {
    if (room.phase === 'lobby') room.seats[seat] = { kind: 'open' };
    else if (room.match) { room.match.setConnected(seat, false); }
  }
  if (room.members.size === 0) { closeRoom(room); return; }
  if (room.hostId === player.id) room.hostId = room.members.keys().next().value;
  pushRoom(room);
}

function closeRoom(room) {
  if (room.match) room.match.abort();
  rooms.delete(room.code);
  log(`room ${room.code} closed`);
}

function currentMap(room) {
  if (room.settings.mapId === 'custom') return room.customMap;
  return maps.get(room.settings.mapId) || null;
}

function sendMapPreview(room, to) {
  const m = currentMap(room);
  if (!m) return;
  const msg = { t: 'preview', mapId: room.settings.mapId, preview: m.preview, info: mapSummary(m) };
  if (to) send(to, msg); else broadcast(room, msg);
}

function startMatch(room) {
  const m = currentMap(room);
  if (!m) return 'Pick a map first.';
  if (room.seats.some((s) => s.kind === 'open')) return 'Both sides need a player or an AI.';
  const names = room.seats.map((s) => (s.kind === 'ai' ? `${AI.STYLES[s.style].label} AI` : (room.members.get(s.player) || {}).name || 'Player'));
  const match = new Match({
    map: m.parsed,
    seats: room.seats.map((s, i) => ({ kind: s.kind, style: s.style, name: names[i] })),
    settings: { roundMs: room.settings.roundMs, turnTimer: room.settings.turnTimer, maxRounds: room.settings.maxRounds, assist: room.settings.assist },
  });
  room.match = match;
  room.phase = 'playing';
  match.on('deltas', (list) => broadcast(room, { t: 'd', list }));
  match.on('ctl', (team, ctl) => { const s = room.seats[team]; if (s.kind === 'human') send(room.members.get(s.player), { t: 'ctl', ctl }); });
  match.on('notice', (team, text) => { const s = room.seats[team]; if (s.kind === 'human') send(room.members.get(s.player), { t: 'notice', text }); });
  match.on('error', (err) => { log(`room ${room.code} match error:`, err.stack || err); broadcast(room, { t: 'error', msg: 'The match crashed: ' + err.message }); room.phase = 'lobby'; room.match = null; pushRoom(room); });
  match.on('over', (result) => {
    room.phase = 'over';
    room.lastReplay = saveReplay(match.replay);
    room.score[result.winner === null ? 2 : result.winner]++;
    log(`room ${room.code} finished: ${result.winner === null ? 'draw' : 'team ' + 'AB'[result.winner]} (${result.reason}) after ${result.rounds + 1} rounds; replay ${room.lastReplay}`);
    pushRoom(room);
  });
  for (const mem of room.members.values()) {
    const seat = seatOf(room, mem);
    send(mem, Object.assign({ t: 'sync', you: seat, fresh: true }, match.sync(seat >= 0 ? seat : null)));
  }
  room.seats.forEach((s, i) => { if (s.kind === 'human') { const p = room.members.get(s.player); match.setConnected(i, !!(p && p.ws && p.ws.open)); } });
  pushRoom(room);
  log(`room ${room.code} started: ${names[0]} vs ${names[1]} on ${m.name}`);
  match.run();
  return null;
}

// ---------------------------------------------------------------- message handling
function clampInt(v, lo, hi, dflt) { v = parseInt(v, 10); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt; }

const handlers = {
  create(player) { createRoom(player); },
  join(player, msg) { joinRoom(player, msg.code); },
  leave(player) { leaveRoom(player); send(player, { t: 'left' }); },
  name(player, msg) { player.name = cleanName(msg.name) || player.name; if (player.room) pushRoom(player.room); },

  seat(player, msg) {
    const room = player.room;
    if (!room || room.phase !== 'lobby') return;
    const cur = seatOf(room, player);
    if (msg.seat === 'spec') { if (cur >= 0) room.seats[cur] = { kind: 'open' }; pushRoom(room); return; }
    const want = msg.seat === 1 ? 1 : 0;
    const target = room.seats[want];
    if (target.kind === 'human' && target.player !== player.id) { fail(player, 'That side is taken.'); return; }
    if (target.kind === 'ai' && room.hostId !== player.id) { fail(player, 'Only the host can replace an AI.'); return; }
    if (cur >= 0) room.seats[cur] = { kind: 'open' };
    room.seats[want] = { kind: 'human', player: player.id };
    pushRoom(room);
  },

  seatKind(player, msg) {
    const room = player.room;
    if (!room || room.phase !== 'lobby' || room.hostId !== player.id) return;
    const i = msg.seat === 1 ? 1 : 0;
    if (msg.kind === 'ai') { if (!AI.STYLES[msg.style]) { fail(player, 'Unknown AI style.'); return; } room.seats[i] = { kind: 'ai', style: msg.style }; }
    else if (msg.kind === 'open') room.seats[i] = { kind: 'open' };
    pushRoom(room);
  },

  swap(player) {
    const room = player.room;
    if (!room || room.phase === 'playing' || room.hostId !== player.id) return;
    room.seats.reverse();
    room.score = [room.score[1], room.score[0], room.score[2]];
    pushRoom(room);
  },

  settings(player, msg) {
    const room = player.room;
    if (!room || room.hostId !== player.id || room.phase === 'playing') return;
    const s = room.settings, v = msg.settings || {};
    if (typeof v.mapId === 'string' && (maps.has(v.mapId) || (v.mapId === 'custom' && room.customMap))) s.mapId = v.mapId;
    if (v.roundMs !== undefined) s.roundMs = clampInt(v.roundMs, 40, 5000, s.roundMs);
    if (v.turnTimer !== undefined) s.turnTimer = parseInt(v.turnTimer, 10) < 0 ? -1 : clampInt(v.turnTimer, 0, 60000, s.turnTimer);
    if (v.maxRounds !== undefined) s.maxRounds = clampInt(v.maxRounds, 20, 2000, s.maxRounds);
    if (typeof v.assist === 'boolean') s.assist = v.assist;
    pushRoom(room);
    if (v.mapId !== undefined) sendMapPreview(room);
  },

  customMap(player, msg) {
    const room = player.room;
    if (!room || room.hostId !== player.id || room.phase === 'playing') return;
    try {
      const parsed = Eng.parseMap(typeof msg.text === 'string' ? msg.text : '');
      room.customMap = describeMap('custom', parsed);
      room.settings.mapId = 'custom';
      pushRoom(room); sendMapPreview(room);
    } catch (e) { fail(player, 'Map rejected — ' + e.message); }
  },

  start(player) {
    const room = player.room;
    if (!room || room.hostId !== player.id || room.phase === 'playing') return;
    const err = startMatch(room);
    if (err) fail(player, err);
  },

  lobby(player) {
    const room = player.room;
    if (!room || room.hostId !== player.id) return;
    if (room.match) room.match.abort();
    room.match = null; room.phase = 'lobby';
    // Seats whose player left during the game open up again.
    room.seats = room.seats.map((s) => (s.kind === 'human' && !room.members.has(s.player) ? { kind: 'open' } : s));
    pushRoom(room); sendMapPreview(room);
  },

  // --- in-game
  cmd(player, msg) { inGame(player, (match, seat) => match.command(seat, msg.id, msg.a, { replace: !!msg.replace })); },
  clear(player, msg) { inGame(player, (match, seat) => match.clearQueue(seat, msg.id)); },
  mode(player, msg) {
    inGame(player, (match, seat) => {
      if (!Array.isArray(msg.ids) || msg.ids.length > 64 || !MODES.includes(msg.mode)) return 'Malformed mode command.';
      return match.setMode(seat, msg.ids.filter(Number.isInteger), msg.mode, msg.arg);
    });
  },
  childMode(player, msg) { inGame(player, (match, seat) => match.setChildMode(seat, msg.mode)); },
  pause(player, msg) { control(player, (match) => match.setPaused(!!msg.on, player.name)); },
  step(player, msg) { control(player, (match) => match.step(msg.round ? match.turnsLeftInRound() : (msg.turns || 1))); },
  pace(player, msg) { control(player, (match) => match.setPace(msg)); },
  ping(player, msg) { send(player, { t: 'pong', ts: msg.ts }); },
};

function inGame(player, fn) {
  const room = player.room;
  if (!room || room.phase !== 'playing' || !room.match) return;
  const seat = seatOf(room, player);
  if (seat < 0) return;
  const err = fn(room.match, seat);
  if (err) fail(player, err);
}
/** Pause / step / pace: either seated player, or the host. */
function control(player, fn) {
  const room = player.room;
  if (!room || room.phase !== 'playing' || !room.match) return;
  if (seatOf(room, player) < 0 && room.hostId !== player.id) return;
  fn(room.match);
}

function cleanName(s) { return (typeof s === 'string' ? s : '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20); }

// ---------------------------------------------------------------- sockets
const wss = attach(server, { path: '/ws', maxMessage: 512 * 1024, maxConnections: 300 });
wss.on('connection', (ws) => {
  let player = null, current = null;
  let budget = 120, last = Date.now();
  ws.on('message', (text) => {
    // Token bucket: 120 messages burst, 60/s sustained.
    const now = Date.now(); budget = Math.min(120, budget + (now - last) * 0.06); last = now;
    if (budget < 1) return;   // dropped, and a flood does not dig a hole that takes minutes to refill
    budget -= 1;
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try {
    if (msg.t === 'hello') {
      if (ACCESS_KEY && msg.key !== ACCESS_KEY) { ws.send(JSON.stringify({ t: 'denied', msg: 'This server needs an access key. Open the full invite link your host sent you.' })); ws.close(4001, 'key'); return; }
      // Identity: a tab keeps its own token (so two tabs of one browser are two players), and a
      // tab with none may take over this browser's previous identity if that one is offline
      // (browser crashed or tab closed mid-game -> you get your seat back).
      const valid = (t) => typeof t === 'string' && /^[0-9a-f]{32}$/.test(t);
      let token = valid(msg.token) ? msg.token : null;
      player = token ? players.get(token) : null;
      if (!token && valid(msg.lastToken)) { const old = players.get(msg.lastToken); if (old && !(old.ws && old.ws.open)) { player = old; token = old.token; } }
      if (!player && current) { player = current; token = current.token; }      // a repeated hello on one socket is the same person
      if (!player && players.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: 'denied', msg: 'The server is full right now.' })); ws.close(4002, 'full'); return; }
      if (!token) token = crypto.randomBytes(16).toString('hex');
      if (!player) { player = { id: nextPlayerId++, token, name: cleanName(msg.name) || 'Player', ws: null, room: null }; players.set(token, player); }
      else if (cleanName(msg.name)) player.name = cleanName(msg.name);
      if (player.ws && player.ws !== ws && player.ws.open) player.ws.close(4000, 'opened elsewhere');
      player.ws = ws;
      current = player;
      player.seen = Date.now();
      send(player, { t: 'welcome', id: player.id, token, name: player.name, maps: Array.from(maps.values()).map(mapSummary), styles: AI.STYLES, modes: MODES, defaults: DEFAULT_SETTINGS });
      if (player.room && rooms.get(player.room.code) === player.room) { pushRoom(player.room); resync(player); }
      else { player.room = null; if (msg.room) joinRoom(player, msg.room); }
      return;
    }
    if (!player || player.ws !== ws) return;
    player.seen = Date.now();
    if (player.room) player.room.touched = Date.now();
    const h = Object.prototype.hasOwnProperty.call(handlers, msg.t) ? handlers[msg.t] : null;
    if (!h) return;
    h(player, msg);
    } catch (e) { log('handler error', msg && msg.t, e.stack || e); if (player) fail(player, 'Server error handling that message.'); }
  });
  ws.on('close', () => {
    if (!player || player.ws !== ws) return;
    player.ws = null;
    const room = player.room;
    if (!room) return;
    const seat = seatOf(room, player);
    if (room.phase === 'playing' && room.match && seat >= 0) {
      room.match.setConnected(seat, false);
      if (!room.match.paused) { room.match.setPaused(true, `${player.name} disconnected`); }
    }
    pushRoom(room);
  });
});

// Housekeeping: forget idle rooms and long-gone players.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyone = Array.from(room.members.values()).some((m) => m.ws && m.ws.open);
    if (!anyone && now - room.touched > 15 * 60 * 1000) { for (const m of room.members.values()) m.room = null; closeRoom(room); }
  }
  for (const [token, p] of players) if (!(p.ws && p.ws.open) && !p.room && now - (p.seen || 0) > 20 * 60 * 1000) players.delete(token);
}, 60 * 1000).unref();

// Last-resort net: one bad connection must never take every room down with it.
process.on('uncaughtException', (err) => log('UNCAUGHT', err && err.stack ? err.stack : err));
process.on('unhandledRejection', (err) => log('UNHANDLED REJECTION', err && err.stack ? err.stack : err));

loadMaps();
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') log(`port ${PORT} is already in use — set PORT to something else`);
  else if (err.code === 'EACCES') log(`not allowed to bind port ${PORT} — ports below 1024 need root or CAP_NET_BIND_SERVICE`);
  else log('server error:', err.message);
  process.exit(1);
});
const onListening = () => {
  const a = server.address();
  log(`Dragon Arena listening on ${a.family === 'IPv6' ? `[${a.address}]` : a.address}:${a.port}${a.address === '::' ? ' (IPv6 + IPv4)' : ''}${ACCESS_KEY ? ' (access key required)' : ''}`);
};
// With no host Node binds "::", which also accepts IPv4, and falls back to 0.0.0.0 where IPv6 is unavailable.
if (HOST) server.listen(PORT, HOST, onListening); else server.listen(PORT, onListening);
process.on('SIGTERM', () => { log('shutting down'); wss.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); });
