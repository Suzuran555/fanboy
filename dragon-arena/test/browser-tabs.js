// Two tabs of the SAME browser profile must be two different players; a closed tab gets its seat back when reopened.
'use strict';
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const path = require('path');
const PORT = 19800 + Math.floor(Math.random() * 90); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0; const check = (n, ok, extra = '') => { console.log((ok ? 'ok   ' : 'FAIL ') + n + (extra ? ' — ' + extra : '')); if (!ok) failed++; };
(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT), REPLAY_DIR: path.join(__dirname, '..', 'replays-test') }), stdio: 'ignore' });
  await sleep(700);
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });   // one context = one localStorage
    const a = await ctx.newPage(); await a.goto(`http://127.0.0.1:${PORT}/`); await a.fill('#nameInput', 'Wang'); await a.click('#createBtn'); await a.waitForSelector('#lobby:not([hidden])'); await sleep(300);
    const code = (await a.textContent('#roomCode')).trim();
    const b = await ctx.newPage(); await b.goto(`http://127.0.0.1:${PORT}/?room=${code}`); await b.waitForSelector('#lobby:not([hidden])', { timeout: 6000 }); await sleep(400);
    const seats = await a.evaluate(() => window.__arena.S.room.seats.map((s) => s.player));
    check('second tab of the same browser is a second player and takes side B', seats[0] !== null && seats[1] !== null && seats[0] !== seats[1], JSON.stringify(seats));
    check('first tab is still connected', await a.evaluate(() => window.__arena.S.connected));
    await a.selectOption('#setTurnTimer', '-1'); await a.click('[data-map="arena"]'); await sleep(200); await a.click('#startBtn'); await b.waitForSelector('#game:not([hidden])'); await sleep(3300);
    const seatB = await b.evaluate(() => window.__arena.S.game.seat);
    await b.close(); await sleep(500);
    const c = await ctx.newPage(); await c.goto(`http://127.0.0.1:${PORT}/?room=${code}`); await c.waitForSelector('#game:not([hidden])', { timeout: 6000 }); await sleep(500);
    check('a reopened tab gets its old seat back', seatB === 1 && (await c.evaluate(() => window.__arena.S.game.seat)) === 1);
  } catch (e) { console.log('FAIL exception', e.message.split('\n')[0]); failed++; }
  await browser.close(); srv.kill('SIGTERM'); console.log(failed ? `\n${failed} FAILED` : '\nALL OK'); process.exit(failed ? 1 : 0);
})();
