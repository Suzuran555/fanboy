const fs = require('fs'), path = require('path');
const Eng = require('../lib/engine'), AI = require('../lib/ai');
const [mapName = 'default', a = 'gatherer', b = 'gatherer', showN = '5'] = process.argv.slice(2);
const map = Eng.parseMap(fs.readFileSync(path.join(__dirname, '..', 'maps', mapName + '.map'), 'utf8'));
let cat = { newborn: 0, corridor: 0, blockedByFriendBody: 0, blockedByEnemyBody: 0, other: 0, total: 0 }, shown = 0;
function draw(g, d, R = 4) {
  const hx = d.segs[0].x, hy = d.segs[0].y; const rows = [];
  for (let dy = -R; dy <= R; dy++) { let row = ''; for (let dx = -R; dx <= R; dx++) { const x = (hx + dx + g.w) % g.w, y = (hy + dy + g.h) % g.h, i = y * g.w + x; const o = g.occ[i];
      let c = g.pearl[i] ? '*' : '.'; if (o !== -1) { const od = g.dragons.get(o); const isHead = od.segs[0].x === x && od.segs[0].y === y; c = o === d.id ? (isHead ? '@' : 'o') : (od.team === d.team ? (isHead ? 'F' : 'f') : (isHead ? 'E' : 'e')); }
      const kN = g.edgeN[i] === 1 ? '‾' : (g.edgeN[i] === 2 ? '^' : ' '), kW = g.edgeW[i] === 1 ? '|' : (g.edgeW[i] === 2 ? ':' : ' '); row += kW + c + kN; } rows.push(row); }
  return rows.join('\n');
}
for (let k = 0; k < 4; k++) {
  const g = Eng.createGame(map, { seed: 900 + k });
  const brains = [AI.createBrain(a), AI.createBrain(b)];
  const hist = new Map();
  while (!g.over) { Eng.beginRound(g); let d; while ((d = Eng.currentDragon(g))) {
    const act = brains[d.team].decide(g, d);
    if (AI.survivableDirs(g, d).length === 0 && act.type === 'move') {
      cat.total++;
      const nbr = AI.neighbours(g), head = d.segs[0].y * g.w + d.segs[0].x;
      let kelp = 0, fb = 0, eb = 0;
      for (let dir = 0; dir < 4; dir++) { const nt = nbr[head * 4 + dir]; if (nt < 0) kelp++; else if (g.occ[nt] !== -1 && g.occ[nt] !== d.id) { (g.dragons.get(g.occ[nt]).team === d.team ? fb++ : eb++); } }
      if (g.round - d.bornRound <= 1) cat.newborn++; else if (kelp >= 2) cat.corridor++; else if (fb > eb) cat.blockedByFriendBody++; else if (eb > 0) cat.blockedByEnemyBody++; else cat.other++;
      if (shown < +showN && g.round - d.bornRound > 1) { shown++; console.log(`round ${g.round} dragon ${d.id} team ${d.team} len ${d.segs.length} age ${g.round - d.bornRound} facing ${'NESW'[d.segs[0].dir]} prev: ${JSON.stringify(hist.get(d.id))}\n` + draw(g, d) + '\n'); }
    }
    hist.set(d.id, { round: g.round, act, head: [d.segs[0].x, d.segs[0].y] });
    Eng.act(g, act); } Eng.endRound(g); }
}
console.log(cat);
