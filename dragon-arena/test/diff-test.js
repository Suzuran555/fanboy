/*
 * Differential test: play whole games on the OFFICIAL engine (unswbc_engine.wasm) and on
 * lib/engine.js in lockstep, with the same (seeded, chaotic) decisions, and require that
 *   - every view block the official engine sends a dragon is byte-identical to ours,
 *   - dragons spawn with the same ids/teams, die in the same round for the same reason,
 *   - the final result (rounds, winner, dragon counts, total lengths) matches.
 *
 * Pearl countdowns are random in the official engine (fixed internal seed we cannot
 * reproduce), so every map is rewritten to minGap == maxGap, which makes pearls
 * deterministic without touching any other rule.
 *
 *   node test/diff-test.js            # full suite
 *   node test/diff-test.js --quick    # fewer games
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { runOfficial } = require('./oracle');
const { parseBlock, makeMap, hEdge, vEdge } = require('./probe');
const Eng = require('../lib/engine');

const quick = process.argv.includes('--quick');

function fixGaps(mapText, mode) {
  return mapText.split('\n').map((line) => {
    const p = line.trim().split(/\s+/);
    if (p[0] !== 'TILE') return line;
    const min = +p[3], max = +p[4];
    if (max === 0) return line;
    let g;
    if (mode === 'dense') g = 2 + ((min * 7 + max * 13) % 5);
    else if (mode === 'sparse') g = 20 + ((min * 7 + max * 13) % 41);
    else g = 4 + ((min * 7 + max * 13) % 17);
    return `TILE ${p[1]} ${p[2]} ${g} ${g}`;
  }).join('\n');
}

function rngFrom(seed) { return Eng.mulberry32(seed); }

/** A chaotic but mostly-survivable policy that only looks at the official view block. */
function chaosPolicy(rand, chaos) {
  return function (id, b) {
    const hx = b.tiles[24].x, hy = b.tiles[24].y;
    const r = rand();
    if (r < chaos * 0.10) return pick(rand, ['', 'GARBAGE\n', 'move n\n', 'MOVE\n', 'MOVE X\n', 'SPLIT 1\n', 'SPLIT 99\n', 'SPLIT\n', 'MOVE N \n', ' MOVE\tE\r\n', 'MOVE N E\n', 'SPLIT +2\n', 'SPLIT -3\n', 'MOVE S\nENDTURN\nMOVE N\n', 'MOVE W\nMOVE', 'MOVE N', 'SONAR 5\n', 'MOVE E\nSONAR -1\n', 'MOVE S\nSONAR 99999999999999999999\n', 'MOVE N\nSPLIT 4294967298\n']);
    // occupancy inside the window, by window cell
    const occ = new Set(b.bodies.map((s) => { const p = s.split(' '); return p[2] + ',' + p[3]; }));
    const cell = (c, rr) => b.tiles[rr * 7 + c];
    const edgeOpen = (dir) => {
      // window centre is (3,3). hedges[r][c] = north edge of cell (c,r); vedges[r][c] = west edge of cell (c,r)
      const h = b.hedges.map((l) => l.split(' ')), v = b.vedges.map((l) => l.split(' '));
      const e = dir === 'N' ? h[3][3] : dir === 'S' ? h[4][3] : dir === 'W' ? v[3][3] : v[3][4];
      return e; // '.', 'w' or portal id
    };
    const safe = [];
    for (const dir of 'NESW') {
      const e = edgeOpen(dir);
      if (e === 'w') continue;
      if (e !== '.') { safe.push(dir); continue; } // portal: destination unknown, gamble
      const t = dir === 'N' ? cell(3, 2) : dir === 'S' ? cell(3, 4) : dir === 'W' ? cell(2, 3) : cell(4, 3);
      if (!occ.has(t.x + ',' + t.y)) safe.push(dir);
    }
    let out = '';
    const r2 = rand();
    if (r2 < 0.03 + chaos * 0.1 && b.length >= 4 && (chaos > 0 || b.length >= 8)) {
      const n = 2 + Math.floor(rand() * (b.length - 3));
      out = `SPLIT ${n}\n`;
    } else if (r2 < 0.05 + chaos * 0.25) {
      // sprint: 2-4 steps, random letters biased to safe first step
      const steps = 2 + Math.floor(rand() * 3);
      let s = safe.length ? pick(rand, safe) : pick(rand, 'NESW'.split(''));
      for (let k = 1; k < steps; k++) {
        // at low chaos keep sprinting straight (rarely fatal); at high chaos pick anything
        s += rand() < chaos ? pick(rand, 'NESW'.split('')) : s[s.length - 1];
      }
      out = `MOVE ${s}\n`;
    } else if (safe.length && rand() > chaos * 0.15) {
      // prefer a pearl if adjacent
      const pearly = safe.filter((dir) => { const t = dir === 'N' ? cell(3, 2) : dir === 'S' ? cell(3, 4) : dir === 'W' ? cell(2, 3) : cell(4, 3); return t.p === 1; });
      out = `MOVE ${pearly.length && rand() < 0.8 ? pick(rand, pearly) : pick(rand, safe)}\n`;
    } else {
      out = `MOVE ${pick(rand, 'NESW'.split(''))}\n`;
    }
    if (rand() < 0.15) out += `SONAR ${Math.floor(rand() * 4294967296)}\n`;
    if (rand() < 0.03) out = `MOVE N\n` + out;       // overwritten action
    if (rand() < 0.03) out += 'LOG hello\nINDICATOR hi\n';
    return out;
  };
}
function pick(rand, arr) { return arr[Math.floor(rand() * arr.length)]; }

function firstDiff(a, b) {
  const la = a.split('\n'), lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) if (la[i] !== lb[i]) return `line ${i + 1}: official=${JSON.stringify(lb[i])} ours=${JSON.stringify(la[i])}`;
  return 'identical?';
}

function playBoth(name, mapText, seed, chaos) {
  const rand = rngFrom(seed);
  const policy = chaosPolicy(rand, chaos);
  const mine = Eng.createGame(Eng.parseMap(mapText), { seed: 1 });
  const offSpawns = [], offDeaths = [];
  let turns = 0, started = false, error = null;
  const res = runOfficial(mapText, {
    onSpawn: (id, init) => offSpawns.push(`${id}:${/TEAM (\w)/.exec(init)[1]}`),
    onDeath: (id, round, reason) => offDeaths.push(`${id}@${round}:${reason}`),
    reply: (id, block) => {
      if (error) return '';
      try {
        if (!started) { Eng.beginRound(mine); started = true; }
        let d = Eng.currentDragon(mine);
        while (!d) {
          if (Eng.endRound(mine)) throw new Error(`our engine ended the game at round ${mine.round} but the official engine asks dragon ${id} to move`);
          Eng.beginRound(mine);
          d = Eng.currentDragon(mine);
        }
        if (d.id !== id) throw new Error(`turn order: official asks dragon ${id}, ours expects ${d.id} (round ${mine.round})`);
        const ours = Eng.viewBlock(mine, d);
        // The official block ends with one extra blank line.
        if (ours + '\n' !== block && ours !== block) throw new Error(`view block mismatch for dragon ${id}, round ${mine.round}: ${firstDiff(ours, block)}`);
        const b = parseBlock(block);
        const reply = policy(id, b);
        Eng.act(mine, Eng.parseReply(reply));
        turns++;
        return reply;
      } catch (e) { error = e; return ''; }
    },
  });
  if (error) throw new Error(`[${name} seed=${seed}] ${error.message}`);
  while (Eng.currentDragon(mine)) throw new Error(`[${name}] official engine stopped but ours still has dragons to act`);
  if (!mine.over) Eng.endRound(mine);
  if (!mine.over) throw new Error(`[${name} seed=${seed}] official engine finished (rounds=${res.rounds}) but ours is still running at round ${mine.round}`);
  const r = mine.result;
  const ourWinner = r.winner === null ? null : 'AB'[r.winner];
  const mineDeaths = mine.deaths.map((x) => `${x.id}@${x.round}:${x.reason}`);
  const mineSpawns = Array.from(mine.dragons.values()).map((d) => `${d.id}:${'AB'[d.team]}`);
  const cmp = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`[${name} seed=${seed}] ${label}: official=${JSON.stringify(b)} ours=${JSON.stringify(a)}`); };
  cmp('rounds', r.rounds, res.rounds);
  cmp('winner', ourWinner, res.winner);
  cmp('dragon counts', [r.teams[0].count, r.teams[1].count], [res.aDragons, res.bDragons]);
  cmp('total lengths', [r.teams[0].total, r.teams[1].total], [res.aLength, res.bLength]);
  cmp('spawns', mineSpawns, offSpawns);
  cmp('deaths', mineDeaths, offDeaths);
  return { turns, rounds: res.rounds, deaths: offDeaths.length, spawns: offSpawns.length, winner: res.winner };
}

// ---------------------------------------------------------------- suite
const mapsDir = path.join(__dirname, '..', 'official', 'maps');
const suite = [];
for (const f of fs.readdirSync(mapsDir).filter((f) => f.endsWith('.map')).sort()) {
  const text = fs.readFileSync(path.join(mapsDir, f), 'utf8');
  for (const mode of ['normal', 'dense', 'sparse']) suite.push({ name: `${f}[${mode}]`, text: fixGaps(text, mode) });
}
// Synthetic maps that stress portals, seams and symmetry.
(function synthetic() {
  const W = 12, H = 10;
  const edges = [
    [vEdge(W, 6, 5), 2, 7], [vEdge(W, 11, 2), 2, 7],       // vertical portal pair
    [hEdge(W, 3, 3), 2, 1], [hEdge(W, 8, 8), 2, 1],         // horizontal portal pair
    [vEdge(W, 0, 4), 2, 9], [vEdge(W, 0, 7), 2, 9],         // portal pair ON the wrap seam
    [hEdge(W, 5, 0), 1], [hEdge(W, 6, 0), 1], [vEdge(W, 0, 1), 1], [vEdge(W, 4, 4), 1], [hEdge(W, 9, 5), 1],
  ];
  const dragons = [
    { team: 0, segs: [[3, 5], [2, 5], [1, 5], [0, 5]] }, { team: 1, segs: [[8, 4], [9, 4], [10, 4], [11, 4]] },
    { team: 0, segs: [[3, 7], [3, 8], [3, 9]] }, { team: 1, segs: [[8, 2], [8, 1], [8, 0]] },
  ];
  for (const sym of [null, 'x', 'y', 'xy']) {
    suite.push({ name: `synthetic-portals[sym=${sym}]`, text: makeMap({ w: W, h: H, symmetry: sym, defaultGap: [3, 3], edges, dragons }) });
  }
  suite.push({ name: 'synthetic-crowded', text: makeMap({ w: 10, h: 10, defaultGap: [2, 2], edges: [], dragons: [
    { team: 0, segs: [[1, 1], [1, 2], [1, 3], [1, 4], [1, 5], [1, 6]] }, { team: 1, segs: [[8, 8], [8, 7], [8, 6], [8, 5], [8, 4], [8, 3]] },
    { team: 0, segs: [[3, 1], [3, 2], [3, 3], [3, 4], [3, 5], [3, 6]] }, { team: 1, segs: [[6, 8], [6, 7], [6, 6], [6, 5], [6, 4], [6, 3]] },
    { team: 0, segs: [[5, 1], [5, 2], [5, 3], [5, 4]] }, { team: 1, segs: [[4, 8], [4, 7], [4, 6], [4, 5]] },
  ] }) });
})();


// Deterministic 500-round tiebreak scenarios: everyone swims straight on an open torus.
function playStraight(name, dragons, expectWinner) {
  const text = makeMap({ w: 16, h: 12, defaultGap: null, dragons });
  const mine = Eng.createGame(Eng.parseMap(text), { seed: 1 });
  const res = runOfficial(text, { reply: (id, block) => `MOVE ${parseBlock(block).dir}\n` });
  while (!mine.over) { Eng.beginRound(mine); let d; while ((d = Eng.currentDragon(mine))) Eng.act(mine, { type: 'move', dirs: [d.segs[0].dir] }); Eng.endRound(mine); }
  const ours = mine.result.winner === null ? null : 'AB'[mine.result.winner];
  if (ours !== res.winner || ours !== expectWinner || mine.result.rounds !== res.rounds) {
    throw new Error(`[${name}] expected ${expectWinner}, official=${res.winner} (rounds ${res.rounds}), ours=${ours} (rounds ${mine.result.rounds}, ${mine.result.reason})`);
  }
  return mine.result;
}
const row = (team, y, len, x0 = 2) => ({ team, segs: Array.from({ length: len }, (_, k) => [x0 + len - 1 - k, y]) });
const tiebreaks = [
  ['longest decides', [row(0, 1, 5), row(1, 3, 4), row(1, 5, 4)], 'A'],
  ['longest decides (B)', [row(0, 1, 3), row(1, 3, 6), row(0, 5, 5)], 'B'],
  ['total decides', [row(0, 1, 4), row(1, 3, 4), row(0, 5, 4), row(1, 7, 3)], 'A'],
  ['total decides (B)', [row(0, 1, 4), row(1, 3, 4), row(0, 5, 2), row(1, 7, 3)], 'B'],
  ['dead even is a draw', [row(0, 1, 4), row(1, 3, 4), row(0, 5, 3), row(1, 7, 3)], null],
];
let tb = 0;
for (const [name, dragons, expect] of tiebreaks) {
  try { const r = playStraight(name, dragons, expect); tb++; if (r.rounds !== 499) throw new Error(`[${name}] ended at round ${r.rounds}`); }
  catch (e) { console.log('FAIL ' + e.message); process.exitCode = 1; }
}
console.log(`tiebreak scenarios matching the official engine: ${tb}/${tiebreaks.length}`);

const seeds = quick ? [1, 2] : [1, 2, 3, 4, 5, 6];
const chaosLevels = quick ? [0, 0.2] : [0, 0.05, 0.3, 1.0];
let games = 0, turns = 0, deaths = 0, spawns = 0, longest = 0, failures = 0;
const lengths = { '<50': 0, '50-199': 0, '200-498': 0, 'full 500': 0 };
const t0 = Date.now();
for (const m of suite) {
  for (const chaos of chaosLevels) {
    for (const seed of seeds) {
      try {
        const r = playBoth(m.name, m.text, seed * 7919 + Math.round(chaos * 100), chaos);
        games++; lengths[r.rounds < 49 ? '<50' : r.rounds < 199 ? '50-199' : r.rounds < 499 ? '200-498' : 'full 500']++; turns += r.turns; deaths += r.deaths; spawns += r.spawns; longest = Math.max(longest, r.rounds);
      } catch (e) {
        failures++;
        console.log('FAIL ' + e.message);
        if (failures >= 8) { console.log('too many failures, stopping'); process.exit(1); }
      }
    }
  }
}
console.log(`game lengths (rounds): ${JSON.stringify(lengths)}`);
console.log(`\n${failures ? 'FAILED' : 'OK'}: ${games} games matched the official engine exactly ` +
  `(${turns} dragon turns, ${spawns} dragons spawned, ${deaths} deaths, longest game ${longest + 1} rounds) in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
  (failures ? `, ${failures} failures` : ''));
process.exit(failures ? 1 : 0);
