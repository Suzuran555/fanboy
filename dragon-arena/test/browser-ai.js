// Browser playtest 2: human vs AI on a 32x32 map, then AI vs AI on the 64x64 map as a spectator; measures client FPS.
'use strict';
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const PORT = 19500 + Math.floor(Math.random() * 400);
const SHOTS = path.join(__dirname, 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fps = (page) => page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else res(Math.round(n / 2)); }; requestAnimationFrame(f); }));
(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT), REPLAY_DIR: path.join(__dirname, '..', 'replays-test') }), stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = ''; srv.stdout.on('data', (d) => { srvLog += d; }); srv.stderr.on('data', (d) => { srvLog += d; });
  await sleep(700);
  const browser = await chromium.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.fill('#nameInput', 'Wang'); await page.click('#createBtn');
    await page.waitForSelector('#lobby:not([hidden])'); await sleep(300);
    await page.selectOption('select[data-style="1"]', 'swarm');
    await page.click('[data-act="ai"][data-seat="1"]'); await sleep(200);
    await page.click('[data-map="default"]'); await sleep(200);
    await page.selectOption('#setRoundMs', '120'); await page.selectOption('#setTurnTimer', '0'); await page.selectOption('#setMaxRounds', '300');
    await sleep(300);
    await page.screenshot({ path: path.join(SHOTS, '10-lobby-vs-ai.png') });
    await page.click('#startBtn'); await page.waitForSelector('#game:not([hidden])');
    await sleep(3200);
    await page.click('#allForage');
    await page.keyboard.press('h');
    await sleep(14000);
    await page.screenshot({ path: path.join(SHOTS, '11-vs-ai-32.png') });
    console.log('32x32 vs swarm:', await page.evaluate(() => document.getElementById('roundText').textContent + ' | ' + document.getElementById('teams').innerText.replace(/\s+/g, ' ')), '| fps', await fps(page));
    await page.waitForSelector('#overlay:not([hidden])', { timeout: 120000 });
    console.log('result:', (await page.textContent('#overlayCard')).replace(/\s+/g, ' ').slice(0, 120));
    await page.click('#ovLobby'); await page.waitForSelector('#lobby:not([hidden])'); await sleep(300);
    // AI vs AI on the biggest map, host spectating
    await page.click('[data-act="spec"]'); await sleep(200);
    await page.selectOption('select[data-style="0"]', 'balanced'); await page.click('[data-act="ai"][data-seat="0"]'); await sleep(200);
    await page.click('[data-map="help"]'); await sleep(300);
    await page.click('#startBtn'); await page.waitForSelector('#game:not([hidden])');
    await sleep(3200 + 20000);
    await page.keyboard.press('t');
    await sleep(500);
    await page.screenshot({ path: path.join(SHOTS, '12-ai-vs-ai-64.png') });
    console.log('64x64 ai vs ai:', await page.evaluate(() => document.getElementById('roundText').textContent + ' | ' + document.getElementById('teams').innerText.replace(/\s+/g, ' ')), '| fps', await fps(page));
    // narrow viewport sanity
    await page.setViewportSize({ width: 820, height: 1000 }); await sleep(600);
    await page.screenshot({ path: path.join(SHOTS, '13-narrow.png') });
  } catch (e) { console.log('PLAYTEST ERROR', e.message.split('\n')[0]); process.exitCode = 1; }
  console.log('browser errors:', errors.length ? errors.slice(0, 5) : 'none');
  console.log(srvLog.split('\n').filter(Boolean).slice(-4).join('\n'));
  await browser.close(); srv.kill('SIGTERM');
})();
