// Generic probe: run the official engine on a custom map with scripted replies and print a compact trace.
const { runOfficial } = require('./oracle');

function parseBlock(block) {
  const lines = block.split('\n');
  let i = 0;
  const out = { round: +lines[i++].split(' ')[1], dir: lines[i++].split(' ')[1], length: +lines[i++].split(' ')[1], units: +lines[i++].split(' ')[1] };
  const nm = +lines[i++].split(' ')[1];
  out.msgs = []; for (let k = 0; k < nm; k++) out.msgs.push(lines[i++]);
  out.tiles = []; for (let k = 0; k < 49; k++) { const [x, y, p, t] = lines[i++].split(' ').map(Number); out.tiles.push({ x, y, p, t }); }
  const nb = +lines[i++].split(' ')[1];
  out.bodies = []; for (let k = 0; k < nb; k++) out.bodies.push(lines[i++]);
  out.hedges = []; for (let k = 0; k < 8; k++) out.hedges.push(lines[i++]);
  out.vedges = []; for (let k = 0; k < 7; k++) out.vedges.push(lines[i++]);
  out.rest = lines.slice(i);
  return out;
}

function makeMap({ w, h, name = 'probe', symmetry = null, tiles = [], defaultGap = null, edges = [], dragons = [] }) {
  const L = [`MAP ${w} ${h}`];
  if (symmetry) L.push(`SYMMETRY ${symmetry}`);
  L.push(`MAP_NAME ${name}`);
  const tl = [];
  if (defaultGap) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tl.push(`TILE ${x} ${y} ${defaultGap[0]} ${defaultGap[1]}`);
  for (const t of tiles) tl.push(`TILE ${t[0]} ${t[1]} ${t[2]} ${t[3]}`);
  L.push(`TILE_COUNT ${tl.length}`, ...tl);
  L.push(`EDGE_COUNT ${edges.length}`);
  for (const e of edges) L.push(`EDGE ${e[0]} ${e[1]} ${e[2] === undefined ? -1 : e[2]}`);
  L.push(`DRAGON_COUNT ${dragons.length}`);
  for (const d of dragons) L.push(`DRAGON ${d.team} ${d.segs.length} ${d.segs.map(s => s.join(' ')).join(' ')}`);
  L.push('END');
  return L.join('\n') + '\n';
}
// edge index helpers: row length w+1; row 2y = horizontal edges north of tile row y; row 2y+1 = vertical edges west of tile (x,y); x==w is the east border.
const hEdge = (w, x, y) => (2 * y) * (w + 1) + x;         // north edge of tile (x,y); y==h is the south border
const vEdge = (w, x, y) => (2 * y + 1) * (w + 1) + x;     // west edge of tile (x,y); x==w is the east border

function trace(mapText, script, { maxRounds = 12, show = ['bodies'], quiet = false } = {}) {
  const log = [];
  const say = (s) => { log.push(s); if (!quiet) console.log(s); };
  let stop = false;
  const res = runOfficial(mapText, {
    reply: (id, block) => {
      const b = parseBlock(block);
      if (b.round >= maxRounds) return '';
      const r = typeof script === 'function' ? script(id, b, block) : ((script[id] || [])[b.round]);
      let rep = r === undefined ? 'MOVE ' + b.dir : r; if (rep && !rep.endsWith('\n')) rep += '\n';
      let s = `R${b.round} d${id} dir=${b.dir} len=${b.length} units=${b.units}` + (b.msgs.length ? ` msgs=[${b.msgs.join(',')}]` : '');
      if (show.includes('bodies')) s += ' bodies=[' + b.bodies.join(' ; ') + ']';
      if (show.includes('pearls')) s += ' pearls=[' + b.tiles.filter(t => t.p).map(t => `${t.x},${t.y}`).join(' ') + ']';
      if (show.includes('times')) s += ' times=[' + b.tiles.filter(t => t.t >= 0).map(t => `${t.x},${t.y}:${t.t}`).join(' ') + ']';
      s += `  -> ${JSON.stringify(rep)}`;
      say(s);
      return rep;
    },
    onSpawn: (id, init) => say(`   SPAWN d${id} ${init.trim().replace(/\n/g, ' | ')}`),
    onDeath: (id, round, reason) => say(`   DEATH d${id} round=${round} reason=${reason}`),
    onNotice: (line) => say('   NOTICE ' + line),
    debug: 15,
  });
  say(`   RESULT rounds=${res.rounds} winner=${res.winner} endReason=${res.endReason} A=${res.aDragons}/${res.aLength} B=${res.bDragons}/${res.bLength}`);
  return { res, log };
}
module.exports = { parseBlock, makeMap, trace, hEdge, vEdge };
