const { makeMap, trace } = require('../probe');
// A: countdown semantics, min==max=5, pearl eaten => no tail advance, spawn blocked when occupied.
console.log('=== A: countdown min=max=5; dragon walks east along y=5 on 12x10');
const map = makeMap({ w: 12, h: 10, defaultGap: [5, 5], dragons: [
  { team: 0, segs: [[3, 5], [2, 5], [1, 5]] }, { team: 1, segs: [[8, 8], [9, 8], [10, 8]] } ] });
trace(map, (id, b) => {
  if (id === 0 && b.round < 9) console.log(`      d0 sees: pearls=${b.tiles.filter(t => t.p).length} sample times (0..6,5): ${b.tiles.filter(t => t.y === 5).map(t => t.x + ':' + t.t + (t.p ? 'P' : '')).join(' ')}`);
  return undefined; // keep straight
}, { maxRounds: 9 });
