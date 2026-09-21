const fs = require('fs'), path = require('path');
const Eng = require('../lib/engine'), AI = require('../lib/ai');
const [mapName = 'default', a = 'balanced', b = 'swarm', games = '6'] = process.argv.slice(2);
const map = Eng.parseMap(fs.readFileSync(path.join(__dirname, '..', 'maps', mapName + '.map'), 'utf8'));
const tally = [{}, {}];
for (let k = 0; k < +games; k++) {
  const g = Eng.createGame(map, { seed: 500 + k });
  const brains = [AI.createBrain(a), AI.createBrain(b)];
  while (!g.over) { Eng.beginRound(g); let d; while ((d = Eng.currentDragon(g))) Eng.act(g, brains[d.team].decide(g, d)); Eng.endRound(g); }
  for (const x of g.deaths) { const key = x.reason + (x.reason === 'H' ? (x.by !== null && g.dragons.get(x.by).team === x.team ? '(friendly)' : '') : ''); tally[x.team][key] = (tally[x.team][key] || 0) + 1; }
}
console.log(`${a} (A) deaths:`, tally[0]); console.log(`${b} (B) deaths:`, tally[1]);
