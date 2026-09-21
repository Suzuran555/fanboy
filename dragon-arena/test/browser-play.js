// Browser playtest: two real browser pages (host + friend) play a short human-vs-human game; screenshots are saved.
'use strict';
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const PORT = 19000 + Math.floor(Math.random() * 500);
const SHOTS = path.join(__dirname, 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs inside the page: choose a key for the dragon the game is waiting on (BFS to the nearest pearl, never into an obstacle).
function pickKey() {
  const { S, view } = window.__arena; const G = S.game;
  if (!G || !G.awaiting || G.awaiting.team !== G.seat || G.paused) return null;
  const d = G.dragons.get(G.awaiting.id); if (!d) return null;
  const occ = view.occupancy(), nbr = view.nbr, w = G.map.w;
  const head = d.segs[1] * w + d.segs[0];
  const free = (t) => t >= 0 && occ[2 * t] < 0;
  const first = new Map(); const queue = [];
  for (let dir = 0; dir < 4; dir++) { const t = nbr[head * 4 + dir]; if (free(t) && !first.has(t)) { first.set(t, dir); queue.push(t); } }
  if (!queue.length) return null;
  let best = first.get(queue[0]);
  for (let qi = 0; qi < queue.length && qi < 3000; qi++) { const t = queue[qi]; if (G.pearls[t]) { best = first.get(t); break; } for (let dir = 0; dir < 4; dir++) { const nt = nbr[t * 4 + dir]; if (free(nt) && !first.has(nt)) { first.set(nt, first.get(t)); queue.push(nt); } } }
  return { key: ['w', 'd', 's', 'a'][best], id: d.id };
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT), REPLAY_DIR: path.join(__dirname, '..', 'replays-test') }), stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = ''; srv.stdout.on('data', (d) => { srvLog += d; }); srv.stderr.on('data', (d) => { srvLog += d; });
  await sleep(700);
  const browser = await chromium.launch();
  const errors = [];
  const mk = async (name) => { const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } }); const page = await ctx.newPage(); page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${name}] ${m.text()}`); }); page.on('pageerror', (e) => errors.push(`[${name}] PAGEERROR ${e.message}`)); return page; };
  let stopDriving = false;
  const drive = async (page, label, stats) => { while (!stopDriving) { try { const k = await page.evaluate(pickKey); if (k) { await page.keyboard.press(k.key); stats.presses++; } } catch (e) { /* page busy */ } await sleep(90); } };
  try {
    const host = await mk('host');
    await host.goto(`http://127.0.0.1:${PORT}/`);
    await host.fill('#nameInput', 'Wang');
    await host.screenshot({ path: path.join(SHOTS, '01-home.png') });
    await host.click('#createBtn');
    await host.waitForSelector('#lobby:not([hidden])');
    await sleep(400);
    const code = (await host.textContent('#roomCode')).trim();
    console.log('room code', code);

    const friend = await mk('friend');
    await friend.goto(`http://127.0.0.1:${PORT}/?room=${code}`);
    await sleep(500);
    console.log('friend sees home with code prefilled:', await friend.inputValue('#codeInput'));
    await friend.fill('#nameInput', 'Juno');
    await friend.click('#joinBtn');
    await friend.waitForSelector('#lobby:not([hidden])');
    await host.click('[data-map="default_small"]');
    await sleep(300);
    await host.selectOption('#setTurnTimer', '700');
    await host.selectOption('#setRoundMs', '250');
    await host.selectOption('#setMaxRounds', '150');
    await sleep(300);
    await host.screenshot({ path: path.join(SHOTS, '03-lobby-ready.png') });
    await host.click('#startBtn');
    await host.waitForSelector('#game:not([hidden])');
    await friend.waitForSelector('#game:not([hidden])');
    await sleep(3300);
    const hs = { presses: 0 }, fs_ = { presses: 0 };
    drive(host, 'host', hs); drive(friend, 'friend', fs_);
    await host.keyboard.press('t'); await host.keyboard.press('r'); await friend.keyboard.press('h');
    await sleep(9000);
    await host.screenshot({ path: path.join(SHOTS, '05-playing-host.png') });
    await friend.screenshot({ path: path.join(SHOTS, '05b-playing-friend.png') });
    console.log('after 9s:', await host.evaluate(() => document.getElementById('roundText').textContent + ' | ' + document.getElementById('teams').innerText.replace(/\s+/g, ' ')), '| key presses', hs.presses, fs_.presses);
    // host: split the longest, then queue a sprint with Shift
    stopDriving = true; await sleep(200);
    await host.keyboard.press('q'); await sleep(1200);
    await host.keyboard.press(' '); await sleep(400);                 // pause
    const dirKey = await host.evaluate(() => { const { S, view } = window.__arena; const G = S.game; const d = G.dragons.get(view.selected); return d ? ['w', 'd', 's', 'a'][d.segs[2]] : 'd'; });
    await host.keyboard.down('Shift'); await host.keyboard.press(dirKey); await host.keyboard.press(dirKey); await sleep(150);
    await host.screenshot({ path: path.join(SHOTS, '06-paused-sprint-building.png') });
    await host.keyboard.up('Shift'); await sleep(300);
    await host.keyboard.press('.'); await sleep(250); await host.keyboard.press(','); await sleep(500);
    await host.screenshot({ path: path.join(SHOTS, '07-paused-stepped.png') });
    await host.keyboard.press(' ');
    // finish on autopilot, fast
    await host.click('#allForage'); await friend.click('#allForage');
    await host.selectOption('#paceSel', '120'); await host.selectOption('#timerSel', '0');
    await host.waitForSelector('#overlay:not([hidden])', { timeout: 90000 });
    await sleep(700);
    await host.screenshot({ path: path.join(SHOTS, '08-result.png') });
    console.log('result:', (await host.textContent('#overlayCard')).replace(/\s+/g, ' ').slice(0, 300));
    await host.click('#ovReplay');
    await sleep(900);
    await host.click('#rpPlay'); await sleep(2500);
    await host.screenshot({ path: path.join(SHOTS, '09-replay.png') });
    console.log('replay meta:', (await host.textContent('#rpMeta')).replace(/\s+/g, ' '));
  } catch (e) { console.log('PLAYTEST ERROR', e.message.split('\n')[0]); process.exitCode = 1; }
  stopDriving = true;
  console.log('browser errors:', errors.length ? errors : 'none');
  console.log(srvLog.split('\n').filter(Boolean).slice(-5).join('\n'));
  await browser.close(); srv.kill('SIGTERM');
})();
