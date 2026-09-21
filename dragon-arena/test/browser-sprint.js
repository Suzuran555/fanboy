// Shift-click sprint / ram in a real browser, two tabs playing both sides with an unlimited turn timer.
'use strict';
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const path = require('path');
const PORT = 19700 + Math.floor(Math.random() * 90); const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const SHOTS = path.join(__dirname, 'shots');
let failed = 0; const check = (n, ok, extra = '') => { console.log((ok ? 'ok   ' : 'FAIL ') + n + (extra ? ' — ' + extra : '')); if (!ok) failed++; };
(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT), REPLAY_DIR: path.join(__dirname, '..', 'replays-test') }), stdio: 'ignore' });
  await sleep(700);
  const browser = await chromium.launch(); const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
    const a = await ctx.newPage(); a.on('pageerror', (e) => errors.push(e.message));
    await a.goto(`http://127.0.0.1:${PORT}/`); await a.fill('#nameInput', 'Wang'); await a.click('#createBtn'); await a.waitForSelector('#lobby:not([hidden])'); await sleep(300);
    const code = (await a.textContent('#roomCode')).trim();
    const b = await ctx.newPage(); b.on('pageerror', (e) => errors.push(e.message)); await b.goto(`http://127.0.0.1:${PORT}/?room=${code}`); await b.waitForSelector('#lobby:not([hidden])'); await sleep(300);
    // Arena: A#0 head (3,5) facing E, B#1 head (7,5) facing W, both length 3 -> A can reach 2 tiles; after one step each they are adjacent.
    await a.click('[data-map="arena"]'); await a.selectOption('#setTurnTimer', '-1'); await sleep(200); await a.click('#startBtn');
    await a.waitForSelector('#game:not([hidden])'); await b.waitForSelector('#game:not([hidden])'); await sleep(3400);
    const clickTile = async (page, x, y, mods) => { const box = await page.evaluate(([x, y]) => { const v = window.__arena.view, r = v.canvas.getBoundingClientRect(); return { px: r.left + v.sx(x) + v.cell / 2, py: r.top + v.sy(y) + v.cell / 2 }; }, [x, y]); await page.mouse.click(box.px, box.py, mods); };
    await a.keyboard.press('r');
    await a.keyboard.press('d'); await sleep(300);           // A#0 -> (4,5)
    await b.keyboard.press('s'); await sleep(300);           // B#1 -> (7,6): steps aside, now 3 columns away diagonally
    // A shift-clicks a tile out of range: refused with an explanation
    await a.keyboard.down('Shift'); await clickTile(a, 9, 9); await a.keyboard.up('Shift'); await sleep(200);
    check('out-of-range shift-click is refused', /Not reachable/.test(await a.textContent('#toast')));
    // A shift-clicks 2 tiles ahead (6,5): a 2-step sprint costing one segment
    await a.keyboard.down('Shift'); await clickTile(a, 6, 5); await a.keyboard.up('Shift'); await sleep(400);
    let st = await a.evaluate(() => { const d = window.__arena.S.game.dragons.get(0); return { head: [d.segs[0], d.segs[1]], len: d.segs.length / 3 }; });
    check('shift-click sprints two tiles for one segment', String(st.head) === '6,5' && st.len === 2, JSON.stringify(st));
    await a.screenshot({ path: path.join(SHOTS, '16-sprint.png') });
    // B rams A's head: B head (7,6), A head (6,5) -> path W then N (2 steps, B is length 3)
    await b.keyboard.down('Shift'); await clickTile(b, 6, 5); await b.keyboard.up('Shift'); await sleep(600);
    const over = await a.evaluate(() => window.__arena.S.game.result);
    check('shift-click on an enemy head rams it: both dragons die, the game is a draw by elimination', over && over.winner === null && over.reason === 'elimination', JSON.stringify(over && { winner: over.winner, reason: over.reason }));
    await a.screenshot({ path: path.join(SHOTS, '17-ram-result.png') });
  } catch (e) { console.log('FAIL exception', e.message.split('\n')[0]); failed++; }
  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close(); srv.kill('SIGTERM'); console.log(failed ? `\n${failed} FAILED` : '\nALL OK'); process.exit(failed ? 1 : 0);
})();
