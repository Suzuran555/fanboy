// Stress: every AI pairing on every official map with engine invariants checked after every single turn.
'use strict';
const fs = require('fs'), path = require('path');
const Eng = require('../lib/engine'), AI = require('../lib/ai');
const quick = process.argv.includes('--quick');
const styles = Object.keys(AI.STYLES);
function invariants(g, where) {
  const seen = new Int32Array(g.n).fill(-1);
  for (const d of g.dragons.values()) {
    if (!d.alive) continue;
    if (d.segs.length < 2) throw new Error(`${where}: dragon ${d.id} has length ${d.segs.length}`);
    for (let k = 0; k < d.segs.length; k++) {
      const s = d.segs[k], i = s.y * g.w + s.x;
      if (s.x < 0 || s.y < 0 || s.x >= g.w || s.y >= g.h) throw new Error(`${where}: dragon ${d.id} off the board`);
      if (seen[i] !== -1) throw new Error(`${where}: tile ${s.x},${s.y} holds dragons ${seen[i]} and ${d.id}`);
      seen[i] = d.id;
      if (g.pearl[i]) throw new Error(`${where}: pearl under dragon ${d.id} at ${s.x},${s.y}`);
      if (k >= 1) { const to = Eng.look(g, s.x, s.y, s.dir), p = d.segs[k - 1]; if (to.x !== p.x || to.y !== p.y) throw new Error(`${where}: dragon ${d.id} segment ${k} does not lead to segment ${k - 1}`); }
    }
  }
  for (let i = 0; i < g.n; i++) if (g.occ[i] !== seen[i]) throw new Error(`${where}: occupancy grid is stale at tile ${i} (${g.occ[i]} vs ${seen[i]})`);
  for (const t of [0, 1]) if (Eng.teamCount(g, t) > g.unitLimit) throw new Error(`${where}: team ${t} exceeds the unit limit`);
}
let games = 0, turns = 0, maxDragons = 0, slowest = 0; const t0 = Date.now();
for (const f of fs.readdirSync(path.join(__dirname, '..', 'maps')).filter((x) => x.endsWith('.map')).sort()) {
  const map = Eng.parseMap(fs.readFileSync(path.join(__dirname, '..', 'maps', f), 'utf8'));
  const big = map.w * map.h > 2000;
  for (const a of styles) for (const b of styles) {
    if (quick && a !== b && !(a === 'swarm' || b === 'swarm')) continue;
    if (big && !(a === 'swarm' && b === 'balanced') && !(a === 'hunter' && b === 'gatherer')) continue;
    const g = Eng.createGame(map, { seed: 4242 + games, maxRounds: big ? 160 : 260 });
    const brains = [AI.createBrain(a), AI.createBrain(b)];
    while (!g.over) {
      Eng.beginRound(g); let d;
      while ((d = Eng.currentDragon(g))) {
        const t1 = process.hrtime.bigint();
        const act = brains[d.team].decide(g, d);
        slowest = Math.max(slowest, Number(process.hrtime.bigint() - t1) / 1e6);
        if (!act || (act.type === 'move' && !(act.dirs && act.dirs.length)) || (act.type === 'split' && !(act.n >= 2))) throw new Error(`${f} ${a} vs ${b}: brain returned ${JSON.stringify(act)}`);
        Eng.act(g, act); turns++;
        invariants(g, `${f} ${a} vs ${b} round ${g.round}`);
      }
      maxDragons = Math.max(maxDragons, Eng.living(g).length);
      Eng.endRound(g);
    }
    games++;
  }
}
console.log(`OK: ${games} AI games, ${turns} turns, invariants held after every turn; up to ${maxDragons} dragons alive at once; slowest single decision ${slowest.toFixed(1)} ms; ${((Date.now() - t0) / 1000).toFixed(0)} s`);
