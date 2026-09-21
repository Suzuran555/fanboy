// Scheduler tests (no network): strict id order, turn timer, queues, pause/step, assist.
'use strict';
const fs = require('fs'), path = require('path');
const Eng = require('../lib/engine');
const { Match } = require('../lib/match');
const { makeMap, hEdge } = require('./probe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0; const check = (name, ok, extra = '') => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); if (!ok) failed++; };
const loadMap = (name) => Eng.parseMap(fs.readFileSync(path.join(__dirname, '..', 'maps', name + '.map'), 'utf8'));
function collect(match) { const all = []; match.on('deltas', (l) => all.push(...l)); return all; }
const human = { kind: 'human' }, ai = (style) => ({ kind: 'ai', style });

(async () => {
  // 1. Strict ascending id order every round, children act later in the round they are born.
  {
    const m = new Match({ map: loadMap('default'), seats: [ai('swarm'), ai('balanced')], settings: { roundMs: 1, turnTimer: 0, maxRounds: 120, countdownMs: 0, seed: 7 } });
    const all = collect(m); await m.run();
    let ok = true, rounds = 0, sameRoundChildren = 0, last = -1, born = new Set();
    for (const x of all) {
      if (x.k === 'r') { rounds++; last = -1; born = new Set(); }
      if (x.k === 't') { if (x.id <= last) ok = false; last = x.id; if (born.has(x.id)) sameRoundChildren++; if (x.child !== undefined) born.add(x.child); }
    }
    check('turns are strictly ascending by id within every round', ok, `${rounds} rounds, ${all.filter((x) => x.k === 't').length} turns`);
    check('children of a split act later in the same round', sameRoundChildren > 0, `${sameRoundChildren} same-round first turns`);
    check('replay has one frame per round and a result', m.replay.frames.length === rounds && !!m.replay.result);
  }
  // A tiny open map: A#0 heads east along y=5; B#1 far away.
  const open = () => Eng.parseMap(makeMap({ w: 14, h: 12, dragons: [{ team: 0, segs: [[5, 5], [4, 5], [3, 5], [2, 5], [1, 5], [0, 5]] }, { team: 1, segs: [[8, 9], [9, 9], [10, 9]] }] }));
  const head = (m, id) => { const d = m.g.dragons.get(id); return d && d.alive ? [d.segs[0].x, d.segs[0].y] : null; };
  // 2. Turn timer: the game waits for a manual dragon, a command ends the wait at once, a timeout goes straight.
  {
    const m = new Match({ map: open(), seats: [human, ai('gatherer')], settings: { roundMs: 1, turnTimer: 300, maxRounds: 50, countdownMs: 0 } });
    const all = collect(m); m.run();
    await sleep(60);
    check('waits on the manual dragon (nothing has moved)', m.awaiting && m.awaiting.id === 0 && String(head(m, 0)) === '5,5' && all.some((x) => x.k === 'w' && x.id === 0));
    const t0 = Date.now(); m.command(0, 0, { k: 'm', d: [0] }); await sleep(30);
    check('a command is applied immediately, not at the deadline', String(head(m, 0)) === '5,4', `after ${Date.now() - t0} ms`);
    const turn = all.filter((x) => x.k === 't' && x.id === 0)[0];
    check('that turn is reported as manual', turn && turn.by === 'manual' && turn.a === 'N');
    await sleep(420); // round 1: no command -> timeout -> straight (north)
    check('timeout keeps the dragon going straight', head(m, 0)[0] === 5 && head(m, 0)[1] < 4 && all.some((x) => x.k === 't' && x.id === 0 && x.by === 'straight'));
    // 3. Queue: three moves queued -> executed one per round without waiting
    m.setPaused(true, 'test'); await sleep(350);
    const before = head(m, 0), roundBefore = m.g.round;
    for (const dir of [1, 1, 2]) m.command(0, 0, { k: 'm', d: [dir] });
    check('queue holds three orders while paused', m.ctlState(0).list[0].q.length === 3);
    await sleep(150);
    check('nothing advances while paused', m.g.round === roundBefore && String(head(m, 0)) === String(before));
    // 4. Step exactly one dragon turn
    const turnsBefore = all.filter((x) => x.k === 't').length;
    m.step(1); await sleep(80);
    check('step(1) lets exactly one dragon act', all.filter((x) => x.k === 't').length === turnsBefore + 1);
    m.step(m.turnsLeftInRound()); await sleep(120);
    m.setPaused(false); await sleep(200);
    // (the first of the three is taken by the turn that was being waited on, the other two from the queue)
    const mine = all.filter((x) => x.k === 't' && x.id === 0);
    check('queued orders ran one per turn, in order', m.ctlState(0).list[0].q.length === 0 && mine.filter((x) => x.by === 'queue').length === 2 && mine.filter((x) => x.by === 'manual').length === 2 && mine.slice(2, 5).map((x) => x.a).join('') === 'EES', mine.slice(0, 6).map((x) => x.by + ':' + x.a).join(' '));
    // 5. Switching the awaited dragon to autopilot ends the wait
    await sleep(320);
    const waitingNow = m.awaiting && m.awaiting.id === 0; const n0 = all.filter((x) => x.k === 't' && x.id === 0).length;
    m.setMode(0, [0], 'forage'); await sleep(40);
    check('switching the awaited dragon to Forage ends the wait', waitingNow && all.filter((x) => x.k === 't' && x.id === 0).length > n0 && all.filter((x) => x.k === 't' && x.id === 0).pop().by === 'forage');
    // 6. Illegal split is skipped, sprint is trimmed to what the dragon can pay
    m.setMode(0, [0], 'manual'); m.setPaused(true); await sleep(60);
    const L = m.g.dragons.get(0).segs.length;
    const notices = []; m.on('notice', (team, text) => notices.push(text));
    m.command(0, 0, { k: 's', n: L - 1 });          // parent would be length 1: illegal
    const facing = m.g.dragons.get(0).segs[0].dir;
    m.command(0, 0, { k: 'm', d: new Array(20).fill(facing) });
    m.setPaused(false); await sleep(400);
    const d0 = m.g.dragons.get(0);
    check('illegal split skipped instead of killing the dragon', d0.alive && notices.length === 1, notices[0]);
    check('over-long sprint trimmed to the affordable length, dragon survives at length 2', d0.alive && d0.segs.length === 2, `length ${L} -> ${d0.segs.length}`);
    // 7. A disconnected player is never waited on
    m.setConnected(0, false); const r0 = m.g.round; await sleep(300);
    check('disconnected player is not waited on', m.g.round > r0 + 5, `${m.g.round - r0} rounds in 300 ms`);
    m.abort();
  }
  // 8. Swerve assist
  for (const assist of [true, false]) {
    const map = Eng.parseMap(makeMap({ w: 14, h: 12, edges: [[hEdge(14, 5, 3), 1]], dragons: [{ team: 0, segs: [[5, 5], [5, 6], [5, 7]] }, { team: 1, segs: [[10, 9], [11, 9], [12, 9]] }] }));
    const m = new Match({ map, seats: [human, human], settings: { roundMs: 1, turnTimer: 0, maxRounds: 6, countdownMs: 0, assist } });
    await m.run();
    const d = m.g.dragons.get(0);
    check(`idle manual dragon facing kelp ${assist ? 'swerves with assist on' : 'dies with assist off'}`, assist ? d.alive : !d.alive && m.g.deaths[0].reason === 'W');
  }
  // 8b. Pausing freezes the turn clock; an order given while paused is only used on resume
  {
    const m = new Match({ map: open(), seats: [human, ai('gatherer')], settings: { roundMs: 1, turnTimer: 250, maxRounds: 50, countdownMs: 0 } });
    const all = collect(m); m.run(); await sleep(50);
    m.setPaused(true, 'test'); await sleep(450);
    check('turn clock stands still while paused', m.awaiting && m.awaiting.id === 0 && String(head(m, 0)) === '5,5' && m.awaitRemaining() > 150, `remaining ${m.awaitRemaining()} ms`);
    m.command(0, 0, { k: 'm', d: [2] }); await sleep(60);
    check('an order given while paused does not move the dragon yet', String(head(m, 0)) === '5,5');
    m.setPaused(false); await sleep(40);
    check('on resume the queued order is used at once', String(head(m, 0)) === '5,6');
    m.abort();
  }
  // 9. Unlimited timer really waits
  {
    const m = new Match({ map: open(), seats: [human, ai('gatherer')], settings: { roundMs: 1, turnTimer: -1, maxRounds: 50, countdownMs: 0 } });
    m.run(); await sleep(500);
    check('unlimited timer: still on round 0 after 500 ms', m.g.round === 0 && m.awaiting && m.awaiting.deadline === -1);
    m.abort();
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL OK'); process.exit(failed ? 1 : 0);
})();
