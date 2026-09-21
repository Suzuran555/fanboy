const { makeMap, parseBlock } = require('../probe');
const { runOfficial } = require('../oracle');
// C: which tiles share a countdown under SYMMETRY x / y / xy ? Use random gaps [1,1000] on a 10x10 map, several dragons of length 2 to cover the map.
const W = 10, H = 10;
for (const sym of ['x', 'y', 'xy', null]) {
  const dragons = [];
  let t = 0;
  for (const cy of [3, 9]) for (const cx of [3, 9]) { dragons.push({ team: t++ % 2, segs: [[cx % W, cy % H], [(cx + 1) % W, cy % H]] }); }
  const map = makeMap({ w: W, h: H, symmetry: sym, defaultGap: [1, 1000], dragons });
  const times = new Map();
  runOfficial(map, { debug: 15, onNotice: l => console.log('   NOTICE', l), reply: (id, block) => { const b = parseBlock(block); if (b.round === 0) for (const t of b.tiles) times.set(t.x + ',' + t.y, t.t); return ''; } });
  console.log(`=== SYMMETRY ${sym}: tiles seen=${times.size}`);
  // find partner sharing same countdown for a few tiles
  const groups = new Map();
  for (const [k, v] of times) { if (!groups.has(v)) groups.set(v, []); groups.get(v).push(k); }
  let shown = 0, pairs = 0, singles = 0;
  for (const [v, ks] of groups) { if (ks.length >= 2) pairs++; else singles++; if (ks.length >= 2 && shown < 6) { console.log(`   t=${v}: ${ks.join('  ')}`); shown++; } }
  console.log(`   groups with >=2 tiles: ${pairs}, singletons: ${singles}`);
  // test hypotheses
  const hyp = { flipX: (x, y) => [W - 1 - x, y], flipY: (x, y) => [x, H - 1 - y], rot180: (x, y) => [W - 1 - x, H - 1 - y] };
  for (const [name, f] of Object.entries(hyp)) { let ok = 0, tot = 0; for (const [k, v] of times) { const [x, y] = k.split(',').map(Number); const [mx, my] = f(x, y); const mv = times.get(mx + ',' + my); if (mv === undefined) continue; tot++; if (mv === v) ok++; } console.log(`   hypothesis ${name}: ${ok}/${tot} mirrored tiles share countdown`); }
}
