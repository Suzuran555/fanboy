// Raw-socket tests of lib/ws.js: fragmentation, 64-bit lengths, ping/pong, protocol violations, size limit, custom map upload.
'use strict';
const net = require('net'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const PORT = 18300 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function frame(opcode, payload, { fin = true, mask = true } = {}) {
  const len = payload.length; let head;
  if (len < 126) head = Buffer.from([0, (mask ? 0x80 : 0) | len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = (mask ? 0x80 : 0) | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = (mask ? 0x80 : 0) | 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = (fin ? 0x80 : 0) | opcode;
  if (!mask) return Buffer.concat([head, payload]);
  const key = crypto.randomBytes(4), body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
  return Buffer.concat([head, key, body]);
}
function open() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, '127.0.0.1');
    let buf = Buffer.alloc(0), upgraded = false; const c = { sock, msgs: [], closed: false, closeCode: null, pongs: 0 };
    sock.on('connect', () => sock.write(`GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; if (!buf.slice(0, i).toString().startsWith('HTTP/1.1 101')) return reject(new Error('no upgrade')); upgraded = true; buf = buf.slice(i + 4); resolve(c); }
      for (;;) { if (buf.length < 2) return; let len = buf[1] & 0x7f, off = 2; if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return; const op = buf[0] & 15, body = buf.slice(off, off + len); buf = buf.slice(off + len);
        if (op === 1) c.msgs.push(JSON.parse(body.toString())); else if (op === 10) c.pongs++; else if (op === 8) c.closeCode = body.length >= 2 ? body.readUInt16BE(0) : 1005; }
    });
    sock.on('close', () => { c.closed = true; }); sock.on('error', () => { c.closed = true; });
  });
}
const send = (c, obj, opts) => c.sock.write(frame(1, Buffer.from(JSON.stringify(obj)), opts));
let failed = 0; const check = (name, ok, extra = '') => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); if (!ok) failed++; };
(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT), REPLAY_DIR: path.join(__dirname, '..', 'replays-test') }), stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = ''; srv.stdout.on('data', (d) => { srvLog += d; }); srv.stderr.on('data', (d) => { srvLog += d; });
  await sleep(700);
  try {
    // 1. fragmented text message + ping
    let c = await open();
    const hello = Buffer.from(JSON.stringify({ t: 'hello', name: 'Frag' }));
    c.sock.write(frame(1, hello.slice(0, 5), { fin: false })); await sleep(30);
    c.sock.write(frame(9, Buffer.from('hi')));                       // a control frame may sit between fragments
    c.sock.write(frame(0, hello.slice(5, 11), { fin: false })); c.sock.write(frame(0, hello.slice(11)));
    await sleep(200);
    check('fragmented hello is reassembled', c.msgs.some((m) => m.t === 'welcome'));
    check('ping between fragments gets a pong', c.pongs === 1);
    // 2. two frames in one TCP packet, split across packets byte by byte
    send(c, { t: 'create' }); await sleep(150);
    const room = c.msgs.find((m) => m.t === 'room');
    check('room created', !!room, room && room.code);
    const two = Buffer.concat([frame(1, Buffer.from(JSON.stringify({ t: 'ping', ts: 1 }))), frame(1, Buffer.from(JSON.stringify({ t: 'ping', ts: 2 })))]);
    for (const byte of two) { c.sock.write(Buffer.from([byte])); } await sleep(300);
    check('byte-by-byte delivery parses both frames', c.msgs.filter((m) => m.t === 'pong').length === 2);
    // 3. a 190 KB custom map (64-bit length header) is accepted and becomes the room's map
    const big = fs.readFileSync(path.join(__dirname, '..', 'maps', 'help.map'), 'utf8');
    send(c, { t: 'customMap', text: big }); await sleep(900);
    const after = c.msgs.filter((m) => m.t === 'room').pop();
    check('190 KB custom map upload', after.settings.mapId === 'custom' && after.map.w === 64, `${Math.round(big.length / 1024)} KB`);
    const prev = c.msgs.filter((m) => m.t === 'preview').pop();
    check('preview of the custom map is sent back', prev && prev.mapId === 'custom' && prev.preview.dragons.length === 12);
    send(c, { t: 'customMap', text: 'MAP 12 12\nDRAGON 0 2 1 1 1 2\n' }); await sleep(200);
    check('broken custom map is rejected with a message', c.msgs.some((m) => m.t === 'error' && /each team/.test(m.msg)));
    c.sock.destroy();
    // 4. unmasked client frame -> protocol error close
    c = await open(); send(c, { t: 'hello' }, { mask: false }); await sleep(200);
    check('unmasked frame closes with 1002', c.closeCode === 1002 && c.closed);
    // 5. oversize message -> closed
    c = await open(); c.sock.write(frame(1, Buffer.alloc(600 * 1024, 0x20))); await sleep(400);
    check('600 KB message is refused', c.closed || c.closeCode === 1002 || c.closeCode === 1009, 'code ' + c.closeCode);
    // 6. garbage JSON and unknown types are ignored, connection survives
    c = await open(); c.sock.write(frame(1, Buffer.from('{not json'))); send(c, { t: 'nope' }); send(c, { t: 'hello', name: '<b>x</b>'.repeat(10) }); await sleep(200);
    const w = c.msgs.find((m) => m.t === 'welcome');
    check('garbage ignored, hello still works, name sanitised', !!w && !/[<>]/.test(w.name) && w.name.length <= 20, w && w.name);
    // 7. flood: 500 messages at once must not kill the server (rate limited)
    for (let i = 0; i < 500; i++) send(c, { t: 'ping', ts: i }); await sleep(400);
    const pongs = c.msgs.filter((m) => m.t === 'pong').length;
    check('flood is rate limited', pongs > 50 && pongs < 300, pongs + ' of 500 answered');
    // 8. commands for a dragon you do not own are refused
    await sleep(1500); // let the rate-limit bucket refill
    send(c, { t: 'create' }); await sleep(100); send(c, { t: 'seatKind', seat: 1, kind: 'ai', style: 'gatherer' }); send(c, { t: 'settings', settings: { mapId: 'arena', turnTimer: 0, roundMs: 60 } }); send(c, { t: 'start' }); await sleep(3400);
    await sleep(600); // let the rate-limit bucket refill
    send(c, { t: 'cmd', id: 1, a: { k: 'm', d: [0] } }); send(c, { t: 'cmd', id: 0, a: { k: 'm', d: [7] } }); send(c, { t: 'cmd', id: 0, a: { k: 's', n: 1 } }); await sleep(300);
    const errs = c.msgs.filter((m) => m.t === 'error').map((m) => m.msg);
    check('enemy dragon / malformed commands refused', errs.filter((e) => /not yours/.test(e)).length === 1 && errs.filter((e) => /Malformed/.test(e)).length === 2, JSON.stringify(errs));
    c.sock.destroy();
    // 9. Requests that used to be able to crash the process (found in review) must only earn a 400.
    const rawGet = (target) => new Promise((resolve) => { const sk = net.connect(PORT, '127.0.0.1'); let out = ''; sk.on('connect', () => sk.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)); sk.on('data', (d) => { out += d; }); sk.on('close', () => resolve(out.split('\r\n')[0])); sk.on('error', () => resolve('socket error')); });
    const statuses = [];
    for (const target of ['/%ff', '/%', '/%00', '//', 'http://[', '/..%2f..%2fserver.js', '/replay/../../server.js']) statuses.push(target + ' -> ' + (await rawGet(target)).replace('HTTP/1.1 ', ''));
    check('malformed request targets get 4xx, not a crash', statuses.every((x) => / -> 4\d\d/.test(x)), statuses.join(' | '));
    // 10. Upgrade that is rejected (wrong path / version) and then reset by the peer
    for (let i = 0; i < 20; i++) { const sk = net.connect(PORT, '127.0.0.1'); sk.on('error', () => {}); sk.on('connect', () => { sk.write(`GET /${i % 2 ? 'nope' : 'ws'} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: ${i % 3 ? 13 : 8}\r\n\r\nJUNKJUNK`); sk.resetAndDestroy ? sk.resetAndDestroy() : sk.destroy(); }); }
    await sleep(500);
    // 11. hello with hostile field types
    c = await open();
    for (const bad of [{ t: 'hello', name: { toString: 1 } }, { t: 'hello', name: 'x', room: { toString: 1 } }, { t: 'hello', name: ['a'], token: 5, lastToken: {}, key: [] }, { t: 'hello' }, { t: 'hello' }, { t: '__proto__' }, { t: 'constructor' }, { t: 'join', code: { toString: 1 } }, { t: 'settings', settings: null }, { t: 'settings', settings: { mapId: {}, roundMs: 'x', turnTimer: [], maxRounds: 1e99 } }, { t: 'mode', ids: 'x', mode: {} }, { t: 'cmd', id: {}, a: null }, { t: 'pace', roundMs: null, turnTimer: {} }, { t: 'step', turns: 'many' }, { t: 'customMap', text: { toString: 1 } }, { t: 'seat', seat: {} }, { t: 'seatKind', seat: 1, kind: 'ai', style: 'constructor' }]) send(c, bad);
    await sleep(400);
    const ids = new Set(c.msgs.filter((m) => m.t === 'welcome').map((m) => m.id));
    check('hostile field types are survived, and repeated hellos on one socket stay one player', ids.size === 1 && c.msgs.filter((m) => m.t === 'welcome').length >= 3, `${c.msgs.filter((m) => m.t === 'welcome').length} welcomes, ids ${[...ids]}`);
    c.sock.destroy();
    // 12. ping flood: the peer is cut off instead of the server buffering pongs for it
    c = await open(); const pingFrame = frame(9, Buffer.alloc(0)); const many = Buffer.concat(new Array(2000).fill(pingFrame));
    for (let i = 0; i < 20; i++) c.sock.write(many); await sleep(500);
    check('ping flood gets the connection terminated', c.closed, `${c.pongs} pongs sent before the cut`);
    const http = await fetch(`http://127.0.0.1:${PORT}/healthz`); check('server still healthy', http.status === 200);
    check('nothing reached the last-resort exception handlers', !/UNCAUGHT|UNHANDLED|handler error/.test(srvLog), (srvLog.match(/(UNCAUGHT|UNHANDLED|handler error).*/g) || []).slice(0, 3).join(' | '));
  } catch (e) { console.log('FAIL exception', e); failed++; }
  srv.kill('SIGTERM');
  console.log(failed ? `\n${failed} FAILED` : '\nALL OK'); process.exit(failed ? 1 : 0);
})();
