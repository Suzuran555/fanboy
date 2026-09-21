/*
 * A small RFC 6455 WebSocket server on top of Node's http module — no npm dependencies, so
 * deploying is "copy the folder, run node". Text messages only, no extensions.
 *
 *   const wss = attach(httpServer, { path: '/ws', maxMessage: 512 * 1024 });
 *   wss.on('connection', (ws, req) => { ws.on('message', (text) => ...); ws.send('...'); });
 */
'use strict';
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0, OP_TEXT = 1, OP_BIN = 2, OP_CLOSE = 8, OP_PING = 9, OP_PONG = 10;

class WebSocketConnection extends EventEmitter {
  constructor(socket, maxMessage) {
    super();
    this.socket = socket;
    this.maxMessage = maxMessage;
    this.buffer = Buffer.alloc(0);
    this.chunks = []; this.chunkBytes = 0; this.need = 0;   // bytes still missing for the frame being received
    this.controlBudget = 40; this.controlStamp = Date.now();
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = 0;
    this.open = true;
    this.alive = true;
    this.remote = socket.remoteAddress;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }

  send(text) {
    if (!this.open) return false;
    // Drop hopelessly slow consumers instead of buffering without bound.
    if (this.socket.writableLength > 8 * 1024 * 1024) { this.terminate(); return false; }
    this.socket.write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf8')));
    return true;
  }

  ping() { if (this.open) this.socket.write(encodeFrame(OP_PING, Buffer.alloc(0))); }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0); body.write(reason, 2);
    try { this.socket.write(encodeFrame(OP_CLOSE, body)); } catch (e) { /* ignore */ }
    this.socket.end();
    this._closed();
  }

  terminate() { this.socket.destroy(); this._closed(); }

  _closed() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  _onData(chunk) {
    // Chunks are only joined once enough bytes for the pending frame have arrived, so a large
    // message trickling in over many TCP segments costs O(n), not O(n^2).
    this.chunks.push(chunk); this.chunkBytes += chunk.length;
    if (this.buffer.length + this.chunkBytes < this.need) return;
    this.buffer = Buffer.concat(this.buffer.length ? [this.buffer, ...this.chunks] : this.chunks);
    this.chunks = []; this.chunkBytes = 0; this.need = 0;
    for (;;) {
      const frame = this._readFrame();
      if (!frame) return;
      if (frame === 'error') { this.close(1002, 'protocol error'); return; }
      this._onFrame(frame);
      if (!this.open) return;
    }
  }

  _readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0, rsv = buf[0] & 0x70, opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f, offset = 2;
    if (rsv !== 0 || !masked) return 'error'; // no extensions negotiated; clients must mask
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2); offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(this.maxMessage)) return 'error';
      len = Number(big); offset = 10;
    }
    if (len > this.maxMessage) return 'error';
    if (buf.length < offset + 4 + len) { this.need = offset + 4 + len; return null; }
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i & 3];
    this.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _onFrame({ fin, opcode, payload }) {
    this.alive = true;
    if (opcode >= 8) { // control frames are never fragmented
      if (!fin || payload.length > 125) { this.close(1002, 'bad control frame'); return; }
      // Control frames get their own small budget (40 burst, 20/s): a ping flood is cut off
      // instead of filling the send buffer with pongs.
      const now = Date.now();
      this.controlBudget = Math.min(40, this.controlBudget + (now - this.controlStamp) * 0.02); this.controlStamp = now;
      if (this.controlBudget < 1 || this.socket.writableLength > 1024 * 1024) { this.terminate(); return; }
      this.controlBudget -= 1;
      if (opcode === OP_PING) this.socket.write(encodeFrame(OP_PONG, payload));
      else if (opcode === OP_CLOSE) this.close(1000);
      return;
    }
    if (opcode === OP_CONT) {
      if (!this.fragments.length) { this.close(1002, 'unexpected continuation'); return; }
    } else if (opcode === OP_TEXT || opcode === OP_BIN) {
      if (this.fragments.length) { this.close(1002, 'expected continuation'); return; }
      this.fragmentOpcode = opcode;
    } else { this.close(1002, 'unknown opcode'); return; }
    this.fragments.push(payload);
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.maxMessage) { this.close(1009, 'message too big'); return; }
    if (!fin) return;
    const whole = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
    const wasText = this.fragmentOpcode === OP_TEXT;
    this.fragments = []; this.fragmentBytes = 0;
    if (!wasText) { this.close(1003, 'text only'); return; }
    this.emit('message', whole.toString('utf8'));
  }
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.allocUnsafe(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.allocUnsafe(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.allocUnsafe(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function attach(server, opts) {
  opts = opts || {};
  const wss = new EventEmitter();
  const path = opts.path || '/ws';
  const maxMessage = opts.maxMessage || 512 * 1024;
  const connections = new Set();
  wss.connections = connections;

  server.on('upgrade', (req, socket) => {
    // Before anything is written: a peer that resets mid-handshake must not raise an unhandled 'error'.
    socket.on('error', () => socket.destroy());
    const url = (req.url || '').split('?')[0];
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (url !== path || upgrade !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    if (opts.maxConnections && connections.size >= opts.maxConnections) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const ws = new WebSocketConnection(socket, maxMessage);
    connections.add(ws);
    ws.on('close', () => connections.delete(ws));
    wss.emit('connection', ws, req);
  });

  // Keep-alive: drop peers that stopped answering pings (NATs and cloud firewalls idle out silently).
  const timer = setInterval(() => {
    for (const ws of connections) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, opts.pingMs || 25000);
  timer.unref();
  wss.close = () => { clearInterval(timer); for (const ws of connections) ws.terminate(); };
  return wss;
}

module.exports = { attach, encodeFrame };
