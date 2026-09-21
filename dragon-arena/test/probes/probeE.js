const { makeMap, trace } = require('../probe');
const W = 14, H = 12;
// observer: length-2 team B dragon cycling in a 2x2 loop near the action; its window shows pearls/bodies.
const obs = { team: 1, segs: [[6, 8], [6, 9]] }; // head (6,8) facing N; loop: E,S? can't go S into own tail... use N,E,S,W cycle
const cyc = ['MOVE E', 'MOVE S', 'MOVE W', 'MOVE N'];
function run(title, actors, scripts, maxRounds = 4) {
  console.log('=== ' + title);
  const dragons = [...actors, obs];
  const obsId = dragons.length - 1;
  trace(makeMap({ w: W, h: H, dragons }), (id, b) => {
    if (id === obsId) return cyc[b.round % 4];
    return (scripts[id] || [])[b.round];
  }, { maxRounds, show: ['bodies', 'pearls'] });
}
run('E1: len 3 MOVE EEEE: where does it die / drop?', [{ team: 0, segs: [[5, 5], [4, 5], [3, 5]] }], { 0: ['MOVE EEEE'] }, 3);
run('E2: len 2 MOVE EE', [{ team: 0, segs: [[5, 5], [4, 5]] }], { 0: ['MOVE EE'] }, 3);
run('E3: death drop pattern: len 6 reverses into neck', [{ team: 0, segs: [[8, 5], [7, 5], [6, 5], [5, 5], [4, 5], [3, 5]] }], { 0: ['MOVE W'] }, 3);
run('E4: len 5 drop pattern (odd)', [{ team: 0, segs: [[8, 5], [7, 5], [6, 5], [5, 5], [4, 5]] }], { 0: ['MOVE W'] }, 3);
run('E5: head-to-head: d0 moves into d1 head', [{ team: 0, segs: [[5, 5], [4, 5], [3, 5]] }, { team: 1, segs: [[6, 5], [7, 5], [8, 5], [9, 5]] }], { 0: ['MOVE E'], 1: ['MOVE W'] }, 3);
run('E6: move into other dragon tail cell (tail would move later)', [{ team: 0, segs: [[5, 5], [5, 6], [5, 7]] }, { team: 1, segs: [[8, 4], [7, 4], [6, 4], [5, 4]] }], { 0: ['MOVE N'], 1: ['MOVE E'] }, 3);
run('E7: lower-id dragon vacates tail first, then higher id enters that cell', [{ team: 0, segs: [[8, 4], [7, 4], [6, 4], [5, 4]] }, { team: 1, segs: [[5, 5], [5, 6], [5, 7]] }], { 0: ['MOVE E'], 1: ['MOVE N'] }, 3);
run('E8: own tail chase: len 4 in 2x2 square moves into own tail cell', [{ team: 0, segs: [[5, 5], [6, 5], [6, 6], [5, 6]] }], { 0: ['MOVE S'] }, 3);
