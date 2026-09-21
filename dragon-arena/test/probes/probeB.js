const { makeMap, trace, hEdge, vEdge, parseBlock } = require('../probe');
const { runOfficial } = require('../oracle');
const W = 12, H = 10;
function showEdges(map, title) {
  console.log('=== ' + title);
  runOfficial(map, { debug: 15, onNotice: l => console.log('   NOTICE', l), reply: (id, block) => {
    const b = parseBlock(block);
    if (b.round === 0) { console.log(`d${id} head window edges:`); console.log('  H:\n   ' + b.hedges.join('\n   ')); console.log('  V:\n   ' + b.vedges.join('\n   ')); }
    return '';
  } });
}
// B1: kelp only on the WEST border index of tile (0,5): vEdge(W,0,5). Dragon 0 near x=0, dragon 1 near x=W-1.
showEdges(makeMap({ w: W, h: H, edges: [[vEdge(W, 0, 5), 1]], dragons: [
  { team: 0, segs: [[1, 5], [1, 6]] }, { team: 1, segs: [[10, 5], [10, 6]] } ] }), 'B1: kelp only at vEdge(x=0,y=5) (west border index)');
// B2: kelp only on the EAST border index x==W
showEdges(makeMap({ w: W, h: H, edges: [[vEdge(W, W, 5), 1]], dragons: [
  { team: 0, segs: [[1, 5], [1, 6]] }, { team: 1, segs: [[10, 5], [10, 6]] } ] }), 'B2: kelp only at vEdge(x=W,y=5) (east border index)');
// B3: horizontal: north border index y=0 vs south border index y=H
showEdges(makeMap({ w: W, h: H, edges: [[hEdge(W, 5, 0), 1]], dragons: [
  { team: 0, segs: [[5, 1], [4, 1]] }, { team: 1, segs: [[5, 8], [4, 8]] } ] }), 'B3: kelp only at hEdge(x=5,y=0)');
showEdges(makeMap({ w: W, h: H, edges: [[hEdge(W, 5, H), 1]], dragons: [
  { team: 0, segs: [[5, 1], [4, 1]] }, { team: 1, segs: [[5, 8], [4, 8]] } ] }), 'B4: kelp only at hEdge(x=5,y=H)');
// B5: conflicting: west says kelp, east says open explicitly
showEdges(makeMap({ w: W, h: H, edges: [[vEdge(W, 0, 5), 1], [vEdge(W, W, 5), 0]], dragons: [
  { team: 0, segs: [[1, 5], [1, 6]] }, { team: 1, segs: [[10, 5], [10, 6]] } ] }), 'B5: west=kelp, east=open explicit');
