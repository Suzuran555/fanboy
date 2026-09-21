// Trace one dragon's decisions around a given round: node test/ai-trace.js map a b seed dragonId round
const fs = require('fs'), path = require('path');
const Eng = require('../lib/engine'), AI = require('../lib/ai');
const [mapName, a, b, seed, id, round] = process.argv.slice(2);
const map = Eng.parseMap(fs.readFileSync(path.join(__dirname, '..', 'maps', mapName + '.map'), 'utf8'));
const g = Eng.createGame(map, { seed: +seed });
const brains = [AI.createBrain(a), AI.createBrain(b)];
function draw(g, d, R = 4) {
  const hx = d.segs[0].x, hy = d.segs[0].y; const rows = [];
  for (let dy = -R; dy <= R; dy++) { let row = ''; for (let dx = -R; dx <= R; dx++) { const x = (hx + dx + g.w) % g.w, y = (hy + dy + g.h) % g.h, i = y * g.w + x; const o = g.occ[i];
      let c = g.pearl[i] ? '*' : '.'; if (o !== -1) { const od = g.dragons.get(o); const isHead = od.segs[0].x === x && od.segs[0].y === y; c = o === d.id ? (isHead ? '@' : 'o') : (od.team === d.team ? (isHead ? 'F' : 'f') : (isHead ? 'E' : 'e')); }
      const kN = g.edgeN[i] === 1 ? '‾' : (g.edgeN[i] === 2 ? '^' : ' '), kW = g.edgeW[i] === 1 ? '|' : (g.edgeW[i] === 2 ? ':' : ' '); row += kW + c + kN; } rows.push(row); }
  return rows.join('\n');
}
while (!g.over && g.round <= +round) { Eng.beginRound(g); let d; while ((d = Eng.currentDragon(g))) {
  if (d.id === +id && g.round >= +round - 3) {
    const dbg = []; const act = AI.forage(g, d, { debug: dbg });
    console.log(`round ${g.round} dragon ${d.id} len ${d.segs.length} head ${d.segs[0].x},${d.segs[0].y} facing ${'NESW'[d.segs[0].dir]} -> ${JSON.stringify(act)}`); console.log(dbg); console.log(draw(g, d));
  }
  Eng.act(g, brains[d.team].decide(g, d)); } Eng.endRound(g); }
