// Smoke test: start the server, create a room, AI vs AI on a small map at high speed, check the game finishes and a replay is served.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const zlib = require('zlib');
const PORT = 18080 + Math.floor(Math.random() * 1000);
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT), REPLAY_DIR: path.join(__dirname, '..', 'replays-test') }), stdio: ['ignore', 'pipe', 'pipe'] });
srv.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
srv.stderr.on('data', (d) => process.stdout.write('[srv!] ' + d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function client(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const c = { ws, msgs: [], waiters: [], name };
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); c.msgs.push(m); c.waiters = c.waiters.filter((w) => !w(m)); };
  c.send = (m) => ws.send(JSON.stringify(m));
  c.wait = (pred, ms = 8000) => new Promise((resolve, reject) => {
    const found = c.msgs.find(pred); if (found) return resolve(found);
    const timer = setTimeout(() => reject(new Error(`${name}: timed out waiting`)), ms);
    c.waiters.push((m) => { if (pred(m)) { clearTimeout(timer); resolve(m); return true; } return false; });
  });
  c.opened = new Promise((resolve) => { ws.onopen = resolve; });
  return c;
}
(async () => {
  try {
    await sleep(600);
    const a = client('alice'); await a.opened;
    a.send({ t: 'hello', name: 'Alice' });
    const w = await a.wait((m) => m.t === 'welcome');
    console.log('welcome: maps', w.maps.length, 'styles', Object.keys(w.styles).join(','));
    a.send({ t: 'create' });
    const room = await a.wait((m) => m.t === 'room');
    console.log('room', room.code, 'seats', JSON.stringify(room.seats));
    a.send({ t: 'seatKind', seat: 0, kind: 'ai', style: 'swarm' });
    a.send({ t: 'seatKind', seat: 1, kind: 'ai', style: 'balanced' });
    a.send({ t: 'settings', settings: { mapId: 'arena', roundMs: 40, turnTimer: 0, maxRounds: 120 } });
    a.send({ t: 'start' });
    const sync = await a.wait((m) => m.t === 'sync');
    console.log('sync: map', sync.map.name, sync.map.w + 'x' + sync.map.h, 'dragons', sync.state.dragons.length, 'you', sync.you);
    // spectator joins mid-game
    await sleep(1500);
    const b = client('bob'); await b.opened;
    b.send({ t: 'hello', name: 'Bob', room: room.code });
    const bsync = await b.wait((m) => m.t === 'sync');
    console.log('bob synced at round', bsync.state.round, 'as seat', bsync.you);
    const over = await a.wait((m) => m.t === 'd' && m.list.some((x) => x.k === 'o'), 30000);
    const res = over.list.find((x) => x.k === 'o').result;
    console.log('over:', JSON.stringify({ winner: res.winner, reason: res.reason, rounds: res.rounds, longest: res.teams.map((t) => t.longest) }));
    const roomOver = await a.wait((m) => m.t === 'room' && m.phase === 'over');
    console.log('replay id', roomOver.lastReplay, 'score', roomOver.score);
    await sleep(300);
    const r = await fetch(`http://127.0.0.1:${PORT}/replay/${roomOver.lastReplay}`);
    const rep = await r.json();
    console.log('replay frames', rep.frames.length, 'bytes(json)', JSON.stringify(rep).length, 'result', rep.result.reason);
    const nDeltas = a.msgs.filter((m) => m.t === 'd').reduce((n, m) => n + m.list.length, 0);
    console.log('delta messages', a.msgs.filter((m) => m.t === 'd').length, 'deltas', nDeltas);
    const page = await fetch(`http://127.0.0.1:${PORT}/`); console.log('GET / ->', page.status);
    const eng = await fetch(`http://127.0.0.1:${PORT}/engine.js`); console.log('GET /engine.js ->', eng.status);
    const bad = await fetch(`http://127.0.0.1:${PORT}/../server.js`); console.log('GET /../server.js ->', bad.status);
    console.log('SMOKE OK');
  } catch (e) { console.log('SMOKE FAILED', e); process.exitCode = 1; }
  finally { srv.kill('SIGTERM'); setTimeout(() => process.exit(), 500); }
})();
