const { makeMap } = require('../probe');
const { runOfficial } = require('../oracle');
const { parseBlock } = require('../probe');
const W = 14, H = 12;
// For each candidate reply, run a one-round game and report: did dragon 0 survive, where is its head, length, children.
const cands = ['MOVE N \n', ' MOVE N\n', 'MOVE  N\n', 'MOVE\tN\n', 'MOVE N E\n', 'MOVE NE x\n', 'MOVE N\r\n', 'MOVE n\n', 'MOVE NEN\n', 'MOVE N,E\n',
  'SPLIT 3 \n', 'SPLIT  3\n', 'SPLIT +3\n', 'SPLIT 03\n', 'SPLIT 3x\n', 'SPLIT 3 4\n', 'SPLIT 3.0\n', 'SPLIT -3\n',
  'MOVE N\nSONAR 12 \n', 'MOVE N\nSONAR +12\n', 'MOVE N\nSONAR 012\n', 'MOVE N\nSONAR 0x10\n', 'MOVE N\nSONAR 12 13\n', 'MOVE N\nSONAR 1e3\n', 'MOVE N\nSONAR 99999999999999999999\n', 'MOVE N\nSONAR -1\n', 'MOVE N\nSONAR 4294967296\n', 'MOVE N\nSONAR\n',
  'MOVE N\nENDTURN\nMOVE S\n', 'ENDTURN\n', 'MOVE N', 'MOVE N\nMOVE', 'MOVE N\nMOVE \n', 'MOVE N\nSPLIT\n', 'MOVE N\nSPLIT x\n', 'MOVEN\n', 'MOVE N\nmove S\n'];
for (const c of cands) {
  // dragon 0 len 6 heading E at (5,5); dragon 1 sits north so a sonar cast N from (5,4) hits it at (5,1)
  const map = makeMap({ w: W, h: H, dragons: [{ team: 0, segs: [[5, 5], [4, 5], [3, 5], [2, 5], [1, 5], [0, 5]] }, { team: 1, segs: [[5, 1], [6, 1], [7, 1]] }] });
  let out = '', death = '';
  runOfficial(map, { onDeath: (id, r, why) => { if (id === 0 && r === 0) death = why; },
    reply: (id, block) => { const b = parseBlock(block);
      if (b.round === 0) return id === 0 ? c : 'MOVE W\n';
      if (b.round === 1 && id === 0) out += `head=${b.tiles[24].x},${b.tiles[24].y} len=${b.length} units=${b.units}`;
      if (b.round === 1 && id === 1) out += ` d1msgs=[${b.msgs.join(',')}]`;
      return ''; } });
  console.log(JSON.stringify(c).padEnd(44), death ? `DEAD(${death})` : out);
}
