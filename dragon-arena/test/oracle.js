// Drives the OFFICIAL UNSW Battlecode engine (unswbc_engine.wasm, MIT, from the
// `unswbc` PyPI package) so our own engine can be differential-tested against it.
'use strict';
const fs = require('fs');
const path = require('path');

const WASM = path.join(__dirname, '..', 'official', 'unswbc_engine.wasm');
let cachedModule = null;

function runOfficial(mapText, { reply, onSpawn, onDeath, onNotice, debug = 0, clockNs = 1234567890123456789n } = {}) {
  if (!cachedModule) {
    try { cachedModule = new WebAssembly.Module(fs.readFileSync(WASM)); }
    catch (e) {
      console.error(`The official engine uses newer WebAssembly features than Node ${process.version} supports. ` +
        'The game server runs fine on Node 18, but these engine-comparison tests need Node 22 or newer.');
      process.exit(2);
    }
  }
  let memory;
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const u8 = () => new Uint8Array(memory.buffer);
  const dv = () => new DataView(memory.buffer);
  let stderrBuf = '';
  class Exit extends Error { constructor(code) { super('proc_exit ' + code); this.code = code; } }

  const wasi = {
    environ_get: () => 0,
    environ_sizes_get: (countPtr, sizePtr) => { dv().setUint32(countPtr, 0, true); dv().setUint32(sizePtr, 0, true); return 0; },
    clock_time_get: (id, precision, outPtr) => { dv().setBigUint64(outPtr, clockNs, true); return 0; },
    fd_close: () => 0,
    fd_prestat_get: () => 8, // EBADF: no preopens
    fd_prestat_dir_name: () => 8,
    fd_seek: () => 70, // ESPIPE
    fd_write: (fd, iovs, iovsLen, nwrittenPtr) => {
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = dv().getUint32(iovs + i * 8, true);
        const len = dv().getUint32(iovs + i * 8 + 4, true);
        const chunk = dec.decode(u8().subarray(ptr, ptr + len));
        total += len;
        if (fd === 2 || fd === 1) {
          stderrBuf += chunk;
          let idx;
          while ((idx = stderrBuf.indexOf('\n')) >= 0) {
            const line = stderrBuf.slice(0, idx); stderrBuf = stderrBuf.slice(idx + 1);
            if (onNotice) onNotice(line);
          }
        }
      }
      dv().setUint32(nwrittenPtr, total, true);
      return 0;
    },
    proc_exit: (code) => { throw new Exit(code); },
  };
  const env = {
    bot_reply: (dragonId, ptr, len, out, cap) => {
      const block = dec.decode(u8().subarray(ptr, ptr + len));
      const text = reply ? (reply(dragonId, block) || '') : '';
      const bytes = enc.encode(text);
      const n = Math.min(bytes.length, cap);
      u8().set(bytes.subarray(0, n), out);
      return n;
    },
    log: (dragonId, round, reason) => { if (onDeath) onDeath(dragonId, round, String.fromCharCode(reason)); },
    bot_spawn: (dragonId, ptr, len) => { if (onSpawn) onSpawn(dragonId, dec.decode(u8().subarray(ptr, ptr + len))); },
  };
  const instance = new WebAssembly.Instance(cachedModule, { wasi_snapshot_preview1: wasi, unswbc: env });
  const ex = instance.exports;
  memory = ex.memory;
  if (ex._initialize) ex._initialize();

  const mapBytes = enc.encode(mapText);
  const mapPtr = ex.ubc_alloc(mapBytes.length);
  u8().set(mapBytes, mapPtr);
  const outPtr = ex.ubc_alloc(32);
  const code = ex.ubc_run(mapPtr, mapBytes.length, debug, outPtr);
  if (code !== 0) {
    let p = ex.ubc_error(); let s = '';
    const m = u8(); while (m[p]) s += String.fromCharCode(m[p++]);
    throw new Error('official engine: ' + (s || 'failed'));
  }
  const v = []; for (let i = 0; i < 8; i++) v.push(dv().getInt32(outPtr + i * 4, true));
  const result = { rounds: v[0], winner: [null, 'A', 'B'][v[1]], endReason: v[2], aDragons: v[3], bDragons: v[4], aLength: v[5], bLength: v[6], events: v[7] };
  result.replay = (nameA = 'A', nameB = 'B') => {
    const a = enc.encode(nameA), b = enc.encode(nameB);
    const pa = ex.ubc_alloc(a.length); u8().set(a, pa);
    const pb = ex.ubc_alloc(b.length); u8().set(b, pb);
    const size = ex.ubc_replay(pa, a.length, pb, b.length);
    if (size < 0) throw new Error('replay failed');
    const base = ex.ubc_replay_ptr();
    return Buffer.from(u8().subarray(base, base + size));
  };
  return result;
}

module.exports = { runOfficial };

if (require.main === module) {
  const mapFile = process.argv[2] || path.join(__dirname, '..', 'official', 'maps', 'arena.map');
  const mapText = fs.readFileSync(mapFile, 'utf8');
  let shown = 0;
  const res = runOfficial(mapText, {
    reply: (id, block) => {
      if (shown < 3) { console.log(`--- block for dragon ${id} ---\n${block}\n--- end ---`); shown++; }
      return 'MOVE N\n';
    },
    onSpawn: (id, init) => console.log(`SPAWN ${id}: ${JSON.stringify(init)}`),
    onDeath: (id, round, reason) => console.log(`DEATH ${id} round ${round} reason ${reason}`),
    onNotice: (line) => console.log('NOTICE', line),
    debug: 15,
  });
  console.log(res);
}
