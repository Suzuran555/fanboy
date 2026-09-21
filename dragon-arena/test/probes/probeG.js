const { makeMap, trace, vEdge, hEdge } = require('../probe');
const W = 14, H = 12;
// Portal pair id 7 on two vertical edges: west edge of (6,5) and west edge of (11,2).
console.log('=== G1: vertical portal pair: enter moving E across west edge of (6,5): expect emerge on the east side of partner edge i.e. tile (11,2)');
trace(makeMap({ w: W, h: H, edges: [[vEdge(W, 6, 5), 2, 7], [vEdge(W, 11, 2), 2, 7]], dragons: [
  { team: 0, segs: [[4, 5], [3, 5], [2, 5]] }, { team: 1, segs: [[1, 10], [1, 11]] } ] }),
  { 0: ['MOVE E', 'MOVE E', 'MOVE E', 'MOVE E'], 1: [] }, { maxRounds: 5 });
console.log('=== G2: enter moving W across west edge of (6,5) from tile (6,5): expect emerge at (10,2) heading W');
trace(makeMap({ w: W, h: H, edges: [[vEdge(W, 6, 5), 2, 7], [vEdge(W, 11, 2), 2, 7]], dragons: [
  { team: 0, segs: [[7, 5], [8, 5], [9, 5]] }, { team: 1, segs: [[1, 10], [1, 11]] } ] }),
  { 0: ['MOVE W', 'MOVE W', 'MOVE W'], 1: [] }, { maxRounds: 4 });
console.log('=== G3: horizontal portal pair: north edge of (5,5) <-> north edge of (9,9); moving N from (5,5)');
trace(makeMap({ w: W, h: H, edges: [[hEdge(W, 5, 5), 2, 3], [hEdge(W, 9, 9), 2, 3]], dragons: [
  { team: 0, segs: [[5, 6], [5, 7], [5, 8]] }, { team: 1, segs: [[1, 10], [1, 11]] } ] }),
  { 0: ['MOVE N', 'MOVE N', 'MOVE N', 'MOVE N\nSONAR 9\n'], 1: [] }, { maxRounds: 5 });
console.log('=== G4: sonar through portal: d0 faces E toward portal west of (6,5); partner west of (11,2); d1 sits at (12,2)');
trace(makeMap({ w: W, h: H, edges: [[vEdge(W, 6, 5), 2, 7], [vEdge(W, 11, 2), 2, 7]], dragons: [
  { team: 0, segs: [[2, 5], [1, 5], [0, 5]] }, { team: 1, segs: [[12, 3], [12, 4], [12, 5]] } ] }),
  { 0: ['MOVE E\nSONAR 42\n'], 1: ['MOVE N'] }, { maxRounds: 3 });
