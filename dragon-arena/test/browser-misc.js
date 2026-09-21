// Misc browser checks: access key gate, help overlay, replay deep link, reconnect mid-game.
'use strict';
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const path = require('path');
const PORT = 19900 + Math.floor(Math.random() * 90); const SHOTS = path.join(__dirname, 'shots'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0; const check = (n, ok, extra = '') => { console.log((ok ? 'ok   ' : 'FAIL ') + n + (extra ? ' — ' + extra : '')); if (!ok) failed++; };
(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT), ACCESS_KEY: 'pearls', REPLAY_DIR: path.join(__dirname, '..', 'replays-test') }), stdio: 'ignore' });
  await sleep(700);
  const browser = await chromium.launch(); const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
    const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${PORT}/`); await sleep(600);
    check('without the key the server refuses and says why', /access key/i.test(await page.textContent('#homeStatus')));
    await page.goto(`http://127.0.0.1:${PORT}/?key=pearls`); await sleep(500);
    await page.fill('#nameInput', 'Wang'); await page.click('#createBtn'); await page.waitForSelector('#lobby:not([hidden])'); await sleep(300);
    check('with ?key= the lobby opens', true);
    await page.click('[data-act="ai"][data-seat="1"]'); await sleep(150);
    await page.click('[data-map="trophy"]'); await page.selectOption('#setRoundMs', '250'); await page.selectOption('#setTurnTimer', '0'); await page.selectOption('#setMaxRounds', '150'); await sleep(200);
    await page.click('#startBtn'); await page.waitForSelector('#game:not([hidden])'); await sleep(3400);
    await page.click('#allForage'); await sleep(2500);
    await page.keyboard.press('?'); await sleep(300);
    await page.screenshot({ path: path.join(SHOTS, '14-help.png') });
    check('help overlay opens with ?', await page.isVisible('#help')); await page.keyboard.press('Escape');
    // reload mid-game: same token -> same seat, state resynced, game auto-paused on disconnect
    const roundBefore = await page.textContent('#roundText');
    await page.reload(); await page.waitForSelector('#game:not([hidden])', { timeout: 8000 }); await sleep(800);
    const st = await page.evaluate(() => { const G = window.__arena.S.game; return { seat: G.seat, paused: G.paused, dragons: G.dragons.size, ctl: G.ctl.size, round: G.round }; });
    check('reload mid-game resumes the same seat with full state', st.seat === 0 && st.dragons > 0 && st.ctl > 0, JSON.stringify(st) + ' (was ' + roundBefore.trim() + ')');
    check('the game paused itself when the player dropped', st.paused === true);
    await page.keyboard.press(' '); await sleep(1500);
    const r2 = await page.evaluate(() => window.__arena.S.game.round);
    check('resume continues the game', r2 > st.round, `${st.round} -> ${r2}`);
    // client state must equal server truth: compare dragon count/lengths with a fresh sync after some play
    await page.selectOption('#paceSel', '120'); await sleep(5000);
    const live = await page.evaluate(() => { const G = window.__arena.S.game; let pearls = 0; for (const p of G.pearls) pearls += p; return { round: G.round, dragons: [...G.dragons.values()].map((d) => d.id + ':' + d.segs.length / 3).sort().join(','), pearls, paused: G.paused }; });
    await page.keyboard.press(' '); await sleep(400);              // pause so the state stands still
    const frozen = await page.evaluate(() => { const G = window.__arena.S.game; let pearls = 0; for (const p of G.pearls) pearls += p; return { round: G.round, dragons: [...G.dragons.values()].map((d) => d.id + ':' + d.segs.length / 3).sort().join(','), pearls, cd: Array.from(G.cd).join(',') }; });
    await page.reload(); await page.waitForSelector('#game:not([hidden])'); await sleep(800);
    const fresh = await page.evaluate(() => { const G = window.__arena.S.game; let pearls = 0; for (const p of G.pearls) pearls += p; return { round: G.round, dragons: [...G.dragons.values()].map((d) => d.id + ':' + d.segs.length / 3).sort().join(','), pearls, cd: Array.from(G.cd).join(',') }; });
    check('incrementally updated client state equals a fresh server snapshot (dragons, pearls, countdowns)', JSON.stringify(frozen) === JSON.stringify(fresh), `round ${frozen.round}, ${frozen.pearls} pearls, ${frozen.dragons.split(',').length} dragons`);
    await page.keyboard.press(' ');
    await page.waitForSelector('#overlay:not([hidden])', { timeout: 90000 }); await sleep(600);
    const replayId = await page.evaluate(() => window.__arena.S.room.lastReplay);
    const p2 = await ctx.newPage(); await p2.goto(`http://127.0.0.1:${PORT}/?key=pearls&replay=${replayId}`); await p2.waitForSelector('#replayPanel:not([hidden])', { timeout: 8000 }); await sleep(500);
    check('replay deep link opens the viewer', (await p2.textContent('#rpMeta')).includes('Trophy'));
    await p2.screenshot({ path: path.join(SHOTS, '15-replay-link.png') });
  } catch (e) { console.log('FAIL exception', e.message.split('\n')[0]); failed++; }
  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close(); srv.kill('SIGTERM');
  console.log(failed ? `\n${failed} FAILED` : '\nALL OK'); process.exit(failed ? 1 : 0);
})();
