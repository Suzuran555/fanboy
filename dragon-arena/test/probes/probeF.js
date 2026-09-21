const { makeMap, trace, vEdge, hEdge } = require('../probe');
const W = 14, H = 12;
console.log('=== F1: split 3 of len 6 with a bend; child acts same round');
trace(makeMap({ w: W, h: H, dragons: [
  { team: 0, segs: [[8, 5], [7, 5], [6, 5], [6, 6], [6, 7], [5, 7]] },
  { team: 1, segs: [[12, 10], [12, 11]] } ] }),
  { 0: ['SPLIT 3', 'MOVE E'], 1: [], 2: ['MOVE W'] }, { maxRounds: 3 });
console.log('=== F2: illegal split (SPLIT 1), (SPLIT 5 of 6)');
trace(makeMap({ w: W, h: H, dragons: [
  { team: 0, segs: [[8, 5], [7, 5], [6, 5], [5, 5], [4, 5], [3, 5]] },
  { team: 1, segs: [[12, 10], [12, 11], [12, 0], [12, 1]] } ] }),
  { 0: ['SPLIT 5'], 1: ['SPLIT 1'] }, { maxRounds: 2 });
console.log('=== F3: MOVE and SPLIT both given: last wins?');
trace(makeMap({ w: W, h: H, dragons: [
  { team: 0, segs: [[8, 5], [7, 5], [6, 5], [5, 5], [4, 5], [3, 5]] },
  { team: 1, segs: [[12, 10], [12, 11]] } ] }),
  { 0: ['MOVE N\nSPLIT 2\n', 'SPLIT 2\nMOVE N\n'] }, { maxRounds: 3 });
console.log('=== F4: sonar: d0 faces E, sends 1806; d1 sits to the east in same row; then d0 after moving N sends again (nothing hit -> lost? or wraps to self)');
trace(makeMap({ w: W, h: H, dragons: [
  { team: 0, segs: [[3, 5], [2, 5], [1, 5]] },
  { team: 1, segs: [[9, 5], [9, 6], [9, 7]] } ] }),
  { 0: ['MOVE E\nSONAR 1806\n', 'MOVE N\nSONAR 77\n', 'MOVE N\nSONAR 4294967295\n', 'MOVE N\nSONAR 4294967296\n', 'MOVE N\nSONAR -5\n'], 1: ['MOVE N', 'MOVE N\nSONAR 5\n', 'MOVE N'] }, { maxRounds: 6 });
