const { makeMap, trace, hEdge, vEdge } = require('../probe');
const W = 14, H = 12;
const far = { team: 1, segs: [[12, 10], [12, 11]] };
const farScript = () => undefined;
console.log('=== D1: sprint MOVE EEN with length 5 (cost 2)');
trace(makeMap({ w: W, h: H, dragons: [{ team: 0, segs: [[5, 5], [4, 5], [3, 5], [2, 5], [1, 5]] }, far] }),
  { 0: ['MOVE EEN', 'MOVE N', 'MOVE NNNN', 'MOVE N'] }, { maxRounds: 5 });
console.log('=== D2: sprint unaffordable: length 3, MOVE EEEE (needs 3 extra) -> performs payable steps then dies?');
trace(makeMap({ w: W, h: H, dragons: [{ team: 0, segs: [[5, 5], [4, 5], [3, 5]] }, far] }),
  { 0: ['MOVE EEEE'] }, { maxRounds: 3 });
console.log('=== D3: length 2 sprint MOVE EE');
trace(makeMap({ w: W, h: H, dragons: [{ team: 0, segs: [[5, 5], [4, 5]] }, far] }),
  { 0: ['MOVE EE'] }, { maxRounds: 3 });
console.log('=== D4: reverse move (into own neck) MOVE W');
trace(makeMap({ w: W, h: H, dragons: [{ team: 0, segs: [[5, 5], [4, 5], [3, 5]] }, far] }),
  { 0: ['MOVE W'] }, { maxRounds: 3 });
console.log('=== D5: two MOVE lines, last wins; garbage line ignored; lowercase?');
trace(makeMap({ w: W, h: H, dragons: [{ team: 0, segs: [[5, 5], [4, 5], [3, 5]] }, far] }),
  { 0: ['MOVE N\nGARBAGE\nMOVE S\n', 'move e\n', ''] }, { maxRounds: 4 });
console.log('=== D6: sprint eating pearls on the way; pearls at fixed gap 1 (every round)');
trace(makeMap({ w: W, h: H, tiles: [[6, 5, 1, 1], [7, 5, 1, 1], [8, 5, 1, 1]], dragons: [{ team: 0, segs: [[5, 5], [4, 5], [3, 5], [2, 5]] }, far] }),
  { 0: ['MOVE EEE', 'MOVE N'] }, { maxRounds: 3, show: ['bodies', 'pearls'] });
