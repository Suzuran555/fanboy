const { makeMap, trace, vEdge, hEdge } = require('../probe');
const W = 14, H = 12;
const far = { team: 1, segs: [[12, 10], [12, 11]] };
// kelp on north edge of (6,5): moving N from (6,5) hits kelp
const edges = [[hEdge(W, 6, 5), 1]];
console.log('=== H1: len 2, MOVE EN, 2nd step into kelp (cannot pay AND kelp)');
trace(makeMap({ w: W, h: H, edges, dragons: [{ team: 0, segs: [[5, 5], [4, 5]] }, far] }), { 0: ['MOVE EN'] }, { maxRounds: 2 });
console.log('=== H2: len 2, MOVE EW, 2nd step into own neck');
trace(makeMap({ w: W, h: H, edges, dragons: [{ team: 0, segs: [[5, 5], [4, 5]] }, far] }), { 0: ['MOVE EW'] }, { maxRounds: 2 });
console.log('=== H3: len 2, MOVE EE, 2nd step free tile');
trace(makeMap({ w: W, h: H, edges, dragons: [{ team: 0, segs: [[5, 5], [4, 5]] }, far] }), { 0: ['MOVE EE'] }, { maxRounds: 2 });
console.log('=== H4: len 3, MOVE ENN: 2nd step kelp');
trace(makeMap({ w: W, h: H, edges, dragons: [{ team: 0, segs: [[5, 5], [4, 5], [3, 5]] }, far] }), { 0: ['MOVE ENN'] }, { maxRounds: 2 });
console.log('=== H5: len 2, MOVE E + pearl on (6,5) then N kelp: eats first so len 3 at step 2');
trace(makeMap({ w: W, h: H, edges, tiles: [[6, 5, 1, 1]], dragons: [{ team: 0, segs: [[5, 5], [4, 5]] }, far] }), { 0: ['MOVE ES', 'MOVE E'] }, { maxRounds: 3 });
