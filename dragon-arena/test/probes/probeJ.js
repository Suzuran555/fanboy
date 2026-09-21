const { makeMap, parseBlock } = require('../probe');
const { runOfficial } = require('../oracle');
const W = 14, H = 12;
const cands = ['MOVE N\nSPLIT -3\n', 'MOVE N\nSPLIT 99\n', 'MOVE N\nSPLIT 1\n', 'MOVE N\nSPLIT 0\n', 'MOVE N\nSPLIT 99999999999999999999\n', 'MOVE N\nSPLIT 4294967299\n',
  'MOVE N\nSONAR 12\n', 'MOVE N\nSONAR 12 \n', 'MOVE N\nSONAR +12\n', 'MOVE N\nSONAR 012\n', 'MOVE N\nSONAR 0x10\n', 'MOVE N\nSONAR 12 13\n', 'MOVE N\nSONAR 1e3\n',
  'MOVE N\nSONAR 99999999999999999999\n', 'MOVE N\nSONAR -1\n', 'MOVE N\nSONAR 4294967296\n', 'MOVE N\nSONAR 18446744073709551617\n', 'MOVE N\nSONAR 9223372036854775808\n', 'MOVE N\nSONAR\n', 'MOVE N\nSONAR 5\nSONAR x\n', 'MOVE N\nSONAR 5\nSONAR 6\n', 'SONAR 5\n'];
for (const c of cands) {
  const map = makeMap({ w: W, h: H, dragons: [{ team: 0, segs: [[5, 5], [4, 5], [3, 5], [2, 5], [1, 5], [0, 5]] }, { team: 1, segs: [[5, 1], [6, 1], [7, 1]] }] });
  let out = '', death = '';
  runOfficial(map, { onDeath: (id, r, why) => { if (id === 0 && r === 0) death = why; },
    reply: (id, block) => { const b = parseBlock(block);
      if (b.round === 0 && id === 0) return c;
      if (b.round === 0 && id === 1) { out += `d1msgs=[${b.msgs.join(',')}]`; return 'MOVE W\n'; }
      if (b.round === 1 && id === 0) out += ` head=${b.tiles[24].x},${b.tiles[24].y} len=${b.length}`;
      return ''; } });
  console.log(JSON.stringify(c).padEnd(48), death ? `DEAD(${death}) ` + out : out);
}
