/*
 * Dragon engine — a from-scratch JavaScript implementation of the UNSW Battlecode 2026
 * game rules (https://game.battlecode.au/docs), verified turn-for-turn against the
 * official engine (see test/diff-test.js).
 *
 * The engine is deliberately "one dragon at a time": a round is
 *     beginRound()  -> pearls tick
 *     for each living dragon in ascending id order:  act(id, action)
 *     endRound()    -> elimination / round-limit check
 * which is exactly the official execution order. Children created by a split are
 * appended to the current round's turn list and act later in the same round.
 *
 * Works in Node (require) and in the browser (window.DragonEngine).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DragonEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Directions are small integers everywhere inside the engine.
  const N = 0, E = 1, S = 2, W = 3;
  const DIR_NAMES = 'NESW';
  const DX = [0, 1, 0, -1];
  const DY = [-1, 0, 1, 0];
  const opposite = (d) => (d + 2) & 3;
  const dirFromChar = (c) => DIR_NAMES.indexOf(c);

  const EDGE_OPEN = 0, EDGE_KELP = 1, EDGE_PORTAL = 2;

  // Death reasons use the official single-letter codes.
  const DEATH = { WALL: 'W', SELF: 'S', OTHER: 'O', HEAD: 'H', NO_ACTION: 'A' };
  const DEATH_TEXT = {
    W: 'hit kelp', S: 'hit itself', O: 'hit another dragon', H: 'head-to-head', A: 'no valid action',
  };

  const DEFAULT_MAX_ROUNDS = 500;
  const DEFAULT_UNIT_LIMIT = 64;

  // ---------------------------------------------------------------- RNG
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------- map files
  class MapError extends Error {}

  /**
   * Parse the official plain-text .map format.
   *   MAP w h | MAP_NAME name | SYMMETRY x|y|xy | TILE x y minGap maxGap
   *   EDGE index kind portalId | DRAGON team count x y x y ... | *_COUNT n | END
   * Edge indices: rows of length w+1 alternating horizontal/vertical. Row 2y holds the
   * north edges of tile row y, row 2y+1 the west edges of tile row y. The extra column
   * (x == w) and the extra row (y == h) duplicate the wrap seam and are ignored by the
   * official engine, so they are ignored here too.
   */
  function parseMap(text) {
    const map = { w: 0, h: 0, name: '', symmetry: null, tiles: [], edges: [], dragons: [] };
    const lines = String(text).split(/\r?\n/);
    let seenMap = false;
    for (let ln = 0; ln < lines.length; ln++) {
      const line = lines[ln].trim();
      if (!line || line[0] === '#') continue;
      const parts = line.split(/\s+/);
      const key = parts[0];
      const fail = (msg) => { throw new MapError(`map line ${ln + 1}: ${msg} ("${line.slice(0, 60)}")`); };
      const int = (s) => { if (!/^-?\d+$/.test(s || '')) fail('expected an integer'); return parseInt(s, 10); };
      if (!seenMap && key !== 'MAP') fail('the first directive must be MAP');
      switch (key) {
        case 'MAP':
          map.w = int(parts[1]); map.h = int(parts[2]); seenMap = true;
          if (map.w < 7 || map.h < 7 || map.w > 64 || map.h > 64) fail('width and height must be between 7 and 64');
          break;
        case 'MAP_NAME': map.name = line.slice(key.length).trim(); break;
        case 'SYMMETRY':
          if (!['x', 'y', 'xy'].includes(parts[1])) fail('SYMMETRY must be x, y or xy');
          map.symmetry = parts[1];
          break;
        case 'TILE': {
          const x = int(parts[1]), y = int(parts[2]), min = int(parts[3]), max = int(parts[4]);
          if (x < 0 || y < 0 || x >= map.w || y >= map.h) fail('tile is off the board');
          if (min < 0 || max < min) fail('bad spawn gap range');
          map.tiles.push({ x, y, min, max });
          break;
        }
        case 'EDGE': {
          const index = int(parts[1]), kind = int(parts[2]), portal = parts.length > 3 ? int(parts[3]) : -1;
          if (kind < 0 || kind > 2) fail('edge kind must be 0, 1 or 2');
          if (index < 0 || index >= (2 * map.h + 1) * (map.w + 1)) fail('edge index out of range');
          map.edges.push({ index, kind, portal });
          break;
        }
        case 'DRAGON': {
          const team = int(parts[1]), count = int(parts[2]);
          if (team !== 0 && team !== 1) fail('team must be 0 or 1');
          if (count < 2) fail('a dragon needs at least 2 segments');
          if (parts.length < 3 + 2 * count) fail('not enough coordinates');
          const segs = [];
          for (let i = 0; i < count; i++) {
            const x = int(parts[3 + 2 * i]), y = int(parts[4 + 2 * i]);
            if (x < 0 || y < 0 || x >= map.w || y >= map.h) fail('segment is off the board');
            segs.push([x, y]);
          }
          map.dragons.push({ team, segs });
          break;
        }
        case 'TILE_COUNT': case 'EDGE_COUNT': case 'DRAGON_COUNT': case 'END': break;
        default: fail('unknown directive');
      }
    }
    if (!seenMap) throw new MapError('map: missing MAP directive');
    if (!map.dragons.some((d) => d.team === 0) || !map.dragons.some((d) => d.team === 1)) {
      throw new MapError('map: each team needs at least one dragon');
    }
    return map;
  }

  // ---------------------------------------------------------------- game state
  /**
   * Build a fresh game from a parsed map.
   * opts: { seed, maxRounds, unitLimit }
   */
  function createGame(map, opts) {
    opts = opts || {};
    const w = map.w, h = map.h, n = w * h;
    const g = {
      w, h, n,
      name: map.name || 'Untitled',
      symmetry: map.symmetry || null,
      maxRounds: opts.maxRounds || DEFAULT_MAX_ROUNDS,
      unitLimit: opts.unitLimit || DEFAULT_UNIT_LIMIT,
      seed: (opts.seed === undefined ? (Math.random() * 0xffffffff) >>> 0 : opts.seed >>> 0),
      round: 0,
      over: false,
      result: null,
      // per tile
      minGap: new Int32Array(n), maxGap: new Int32Array(n),
      cdGroup: new Int32Array(n),      // canonical tile index that owns this tile's countdown
      cd: new Int32Array(n).fill(-1),  // countdown, stored at the canonical tile (-1: never spawns)
      pearl: new Uint8Array(n),
      occ: new Int32Array(n).fill(-1), // id of the dragon occupying the tile, -1 if none
      // per tile edges: north edge and west edge (the torus has exactly 2 edges per tile)
      edgeN: new Uint8Array(n), edgeW: new Uint8Array(n),
      portalN: new Int32Array(n).fill(-1), portalW: new Int32Array(n).fill(-1),
      partnerN: new Int32Array(n).fill(-1), partnerW: new Int32Array(n).fill(-1), // partner tile index (same orientation)
      dragons: new Map(),
      nextId: 0,
      order: [], turnIdx: 0, inRound: false,
      stats: [newTeamStats(), newTeamStats()],
      deaths: [],   // {id, team, round, reason, length}
    };
    g.rng = mulberry32(g.seed);

    for (const t of map.tiles) { const i = t.y * w + t.x; g.minGap[i] = t.min; g.maxGap[i] = t.max; }

    // Edges. Ignore the duplicated seam column/row.
    const rowLen = w + 1;
    const portalEdges = new Map(); // portal id -> [{vertical, tile}]
    for (const e of map.edges) {
      const row = Math.floor(e.index / rowLen), col = e.index % rowLen;
      if (col >= w) continue;
      const vertical = (row & 1) === 1;
      const ty = vertical ? (row - 1) / 2 : row / 2;
      if (ty >= h) continue;
      const i = ty * w + col;
      if (vertical) { g.edgeW[i] = e.kind; g.portalW[i] = e.kind === EDGE_PORTAL ? e.portal : -1; }
      else { g.edgeN[i] = e.kind; g.portalN[i] = e.kind === EDGE_PORTAL ? e.portal : -1; }
    }
    for (let i = 0; i < n; i++) {
      if (g.edgeN[i] === EDGE_PORTAL) pushPortal(portalEdges, g.portalN[i], false, i);
      if (g.edgeW[i] === EDGE_PORTAL) pushPortal(portalEdges, g.portalW[i], true, i);
    }
    for (const [pid, list] of portalEdges) {
      if (list.length !== 2 || list[0].vertical !== list[1].vertical) {
        throw new MapError(`map: portal ${pid} must sit on exactly two edges of the same orientation`);
      }
      const [a, b] = list;
      if (a.vertical) { g.partnerW[a.tile] = b.tile; g.partnerW[b.tile] = a.tile; }
      else { g.partnerN[a.tile] = b.tile; g.partnerN[b.tile] = a.tile; }
    }

    // Pearl countdown groups: mirrored tiles share one countdown.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let mx = x, my = y;
        if (g.symmetry === 'y' || g.symmetry === 'xy') mx = w - 1 - x;
        if (g.symmetry === 'x' || g.symmetry === 'xy') my = h - 1 - y;
        g.cdGroup[i] = Math.min(i, my * w + mx);
      }
    }
    g.groupTiles = new Map(); // canonical -> [tiles]
    for (let i = 0; i < n; i++) {
      const c = g.cdGroup[i];
      if (!g.groupTiles.has(c)) g.groupTiles.set(c, []);
      g.groupTiles.get(c).push(i);
    }
    for (let i = 0; i < n; i++) {
      if (g.cdGroup[i] === i && g.maxGap[i] > 0) g.cd[i] = drawGap(g, i);
    }

    // Dragons, ids in file order.
    for (const d of map.dragons) {
      const segs = d.segs.map(([x, y]) => ({ x, y, dir: N }));
      for (let k = 1; k < segs.length; k++) {
        const dir = adjacentDir(g, segs[k], segs[k - 1]);
        if (dir < 0) throw new MapError('map: dragon segments must be adjacent');
        segs[k].dir = dir;
      }
      segs[0].dir = segs[1].dir;
      for (const s of segs) {
        const i = s.y * w + s.x;
        if (g.occ[i] !== -1) throw new MapError('map: dragons overlap');
      }
      addDragon(g, d.team, segs, null);
    }
    return g;
  }

  function newTeamStats() { return { pearls: 0, kills: 0, deaths: 0, splits: 0, sprintCost: 0, lostLength: 0 }; }

  function pushPortal(m, pid, vertical, tile) {
    if (!m.has(pid)) m.set(pid, []);
    m.get(pid).push({ vertical, tile });
  }

  function drawGap(g, i) {
    const lo = Math.max(1, g.minGap[i]), hi = Math.max(lo, g.maxGap[i]);
    return lo + Math.floor(g.rng() * (hi - lo + 1));
  }

  function adjacentDir(g, from, to) {
    for (let d = 0; d < 4; d++) {
      if ((from.x + DX[d] + g.w) % g.w === to.x && (from.y + DY[d] + g.h) % g.h === to.y) return d;
    }
    return -1;
  }

  function addDragon(g, team, segs, parentId) {
    const d = { id: g.nextId++, team, segs, alive: true, inbox: [], parent: parentId, bornRound: g.round, eaten: 0, kills: 0 };
    for (const s of segs) g.occ[s.y * g.w + s.x] = d.id;
    g.dragons.set(d.id, d);
    return d;
  }

  // ---------------------------------------------------------------- geometry
  /**
   * What lies across the edge when leaving tile (x, y) in direction dir?
   * Returns { kind, x, y } — for kelp the coordinates are meaningless.
   */
  function look(g, x, y, dir) {
    const w = g.w, h = g.h;
    let kind, partner, et;
    if (dir === N) { et = y * w + x; kind = g.edgeN[et]; partner = g.partnerN[et]; }
    else if (dir === S) { et = ((y + 1) % h) * w + x; kind = g.edgeN[et]; partner = g.partnerN[et]; }
    else if (dir === W) { et = y * w + x; kind = g.edgeW[et]; partner = g.partnerW[et]; }
    else { et = y * w + ((x + 1) % w); kind = g.edgeW[et]; partner = g.partnerW[et]; }
    if (kind === EDGE_KELP) return { kind, x: -1, y: -1 };
    if (kind === EDGE_PORTAL && partner >= 0) {
      // Leave through the partner edge, still travelling in `dir`.
      const px = partner % w, py = (partner - px) / w;
      if (dir === N) return { kind, x: px, y: (py - 1 + h) % h };
      if (dir === S) return { kind, x: px, y: py };
      if (dir === W) return { kind, x: (px - 1 + w) % w, y: py };
      return { kind, x: px, y: py };
    }
    return { kind: EDGE_OPEN, x: (x + DX[dir] + w) % w, y: (y + DY[dir] + h) % h };
  }

  function teamCount(g, team) {
    let c = 0;
    for (const d of g.dragons.values()) if (d.alive && d.team === team) c++;
    return c;
  }

  function living(g) {
    const out = [];
    for (const d of g.dragons.values()) if (d.alive) out.push(d);
    return out; // Map preserves insertion order == ascending id
  }

  // ---------------------------------------------------------------- round structure
  function beginRound(g) {
    if (g.over) throw new Error('game is over');
    if (g.inRound) throw new Error('round already in progress');
    const ev = { spawned: [], resets: [] };
    // 1. Pearls tick, top row to bottom, left to right.
    for (let i = 0; i < g.n; i++) {
      if (g.cdGroup[i] !== i || g.cd[i] < 0) continue;
      g.cd[i] -= 1;
      if (g.cd[i] <= 0) {
        for (const t of g.groupTiles.get(i)) {
          if (g.occ[t] === -1 && !g.pearl[t]) { g.pearl[t] = 1; ev.spawned.push(t); }
        }
        g.cd[i] = drawGap(g, i);
        ev.resets.push(i, g.cd[i]);
      }
    }
    // 2. Turn list: living dragons, ascending id.
    g.order = living(g).map((d) => d.id);
    g.turnIdx = 0;
    g.inRound = true;
    return ev;
  }

  /** The dragon whose turn it is now (skipping any that died earlier this round), or null. */
  function currentDragon(g) {
    while (g.turnIdx < g.order.length) {
      const d = g.dragons.get(g.order[g.turnIdx]);
      if (d && d.alive) return d;
      g.turnIdx++;
    }
    return null;
  }

  /**
   * Apply the current dragon's action and advance to the next turn.
   * action: { type: 'move', dirs: [0..3, ...] } | { type: 'split', n } | { type: 'none' }
   *         optional  sonar: uint32
   * Returns a list of events describing what happened.
   */
  function act(g, action) {
    const d = currentDragon(g);
    if (!d) throw new Error('no dragon to act');
    const events = [];
    // The inbox is handed to the bot at the start of its turn, then emptied.
    d.inbox = [];
    if (!action || action.type === 'none') {
      kill(g, d, DEATH.NO_ACTION, events, null);
    } else if (action.type === 'move') {
      applyMove(g, d, action.dirs, events);
    } else if (action.type === 'split') {
      applySplit(g, d, action.n, events);
    } else {
      kill(g, d, DEATH.NO_ACTION, events, null);
    }
    if (d.alive && action && action.sonar !== undefined && action.sonar !== null) castSonar(g, d, action.sonar >>> 0, events);
    g.turnIdx++;
    return events;
  }

  function applyMove(g, d, dirs, events) {
    if (!Array.isArray(dirs) || dirs.length === 0) { kill(g, d, DEATH.NO_ACTION, events, null); return; }
    const w = g.w;
    for (let k = 0; k < dirs.length; k++) {
      const dir = dirs[k];
      if (!(dir >= 0 && dir <= 3)) { kill(g, d, DEATH.NO_ACTION, events, null); return; }
      // Every step after the first costs one segment; a dragon of length 2 cannot pay.
      if (k > 0 && d.segs.length < 3) { kill(g, d, DEATH.NO_ACTION, events, null); return; }
      const head = d.segs[0];
      head.dir = dir;
      const dest = look(g, head.x, head.y, dir);
      if (dest.kind === EDGE_KELP) { kill(g, d, DEATH.WALL, events, null); return; }
      const di = dest.y * w + dest.x;
      const occ = g.occ[di];
      if (occ === d.id) { kill(g, d, DEATH.SELF, events, null); return; }
      if (occ !== -1) {
        const other = g.dragons.get(occ);
        if (other.segs[0].x === dest.x && other.segs[0].y === dest.y) {
          // Head-on: the other dragon's death sequence runs first, then this dragon's.
          kill(g, other, DEATH.HEAD, events, d);
          kill(g, d, DEATH.HEAD, events, other);
        } else {
          kill(g, d, DEATH.OTHER, events, other);
        }
        return;
      }
      // The head moves.
      const ate = g.pearl[di] === 1;
      if (ate) { g.pearl[di] = 0; d.eaten++; g.stats[d.team].pearls++; }
      d.segs[0].dir = dir;                 // old head now points at the new head
      d.segs.unshift({ x: dest.x, y: dest.y, dir });
      g.occ[di] = d.id;
      if (!ate) dropTail(g, d);
      if (k > 0) { dropTail(g, d); g.stats[d.team].sprintCost++; }
      events.push({ t: 'step', id: d.id, x: dest.x, y: dest.y, dir, ate, portal: dest.kind === EDGE_PORTAL, sprint: k > 0 });
    }
  }

  function dropTail(g, d) {
    const t = d.segs.pop();
    g.occ[t.y * g.w + t.x] = -1;
  }

  function applySplit(g, d, n, events) {
    const len = d.segs.length;
    if (!Number.isInteger(n) || n < 2 || len - n < 2 || teamCount(g, d.team) >= g.unitLimit) {
      kill(g, d, DEATH.NO_ACTION, events, null);
      return;
    }
    // The child is the parent's rear n segments in reverse order: the old tail becomes the head.
    const rear = d.segs.splice(len - n, n);           // rear[j] was parent segment len-n+j
    const child = [];
    for (let j = 0; j < n; j++) {
      const src = rear[n - 1 - j];
      child.push({ x: src.x, y: src.y, dir: N });
    }
    // Child segment j (>=1) points at child segment j-1, i.e. the reverse of how the
    // parent segment nearer the tail pointed at it.
    for (let j = 1; j < n; j++) child[j].dir = opposite(rear[n - j].dir);
    child[0].dir = child[1].dir;
    const c = addDragon(g, d.team, child, d.id);
    g.order.push(c.id);                                // acts later this same round
    g.stats[d.team].splits++;
    events.push({ t: 'split', id: d.id, child: c.id, n });
  }

  function kill(g, d, reason, events, other) {
    if (!d.alive) return;
    d.alive = false;
    const pearls = [];
    // Starting from the head, every second segment crystallises into a pearl.
    for (let k = 0; k < d.segs.length; k++) {
      const s = d.segs[k], i = s.y * g.w + s.x;
      g.occ[i] = -1;
      if ((k & 1) === 0) { g.pearl[i] = 1; pearls.push(i); }
    }
    const st = g.stats[d.team];
    st.deaths++; st.lostLength += d.segs.length;
    if (other && other.team !== d.team && reason !== DEATH.NO_ACTION) { g.stats[other.team].kills++; other.kills++; }
    g.deaths.push({ id: d.id, team: d.team, round: g.round, reason, length: d.segs.length, by: other ? other.id : null });
    events.push({ t: 'death', id: d.id, team: d.team, reason, length: d.segs.length, by: other ? other.id : null, pearls });
  }

  /** Sonar: a ray from the head along the facing; through portals, around the wrap; stops at kelp or the first dragon part. */
  function castSonar(g, d, value, events) {
    let x = d.segs[0].x, y = d.segs[0].y;
    const dir = d.segs[0].dir;
    const seen = new Set();
    for (;;) {
      const key = y * g.w + x;
      if (seen.has(key)) return;        // looped without hitting anything: the signal is lost
      seen.add(key);
      const nx = look(g, x, y, dir);
      if (nx.kind === EDGE_KELP) return;
      x = nx.x; y = nx.y;
      const occ = g.occ[y * g.w + x];
      if (occ !== -1) {
        g.dragons.get(occ).inbox.push(value);
        events.push({ t: 'sonar', id: d.id, to: occ, value });
        return;
      }
    }
  }

  /** Close the round. Returns true if the game ended. */
  function endRound(g) {
    if (currentDragon(g)) throw new Error('round still has dragons to act');
    g.inRound = false;
    const a = teamCount(g, 0), b = teamCount(g, 1);
    if (a === 0 || b === 0) {
      finish(g, a === 0 && b === 0 ? null : (a > 0 ? 0 : 1), 'elimination');
    } else if (g.round >= g.maxRounds - 1) {
      const sa = summary(g, 0), sb = summary(g, 1);
      if (sa.longest !== sb.longest) finish(g, sa.longest > sb.longest ? 0 : 1, 'longest');
      else if (sa.total !== sb.total) finish(g, sa.total > sb.total ? 0 : 1, 'total');
      else finish(g, null, 'tie');
    } else {
      g.round++;
    }
    return g.over;
  }

  function finish(g, winner, reason) {
    g.over = true;
    g.result = { winner, reason, rounds: g.round, teams: [summary(g, 0), summary(g, 1)] };
  }

  function summary(g, team) {
    let count = 0, longest = 0, total = 0, longestId = -1;
    for (const d of g.dragons.values()) {
      if (!d.alive || d.team !== team) continue;
      count++; total += d.segs.length;
      if (d.segs.length > longest) { longest = d.segs.length; longestId = d.id; }
    }
    return { count, longest, total, longestId, stats: Object.assign({}, g.stats[team]) };
  }

  // ---------------------------------------------------------------- official wire protocol
  /** The exact text block the official engine sends a bot at the start of its turn. */
  function viewBlock(g, d) {
    const w = g.w, h = g.h;
    const hx = d.segs[0].x, hy = d.segs[0].y;
    const out = [];
    out.push('ROUND ' + g.round, 'DIR ' + DIR_NAMES[d.segs[0].dir], 'LENGTH ' + d.segs.length,
      'UNIT_COUNT ' + teamCount(g, d.team), 'NUM_MSGS ' + d.inbox.length);
    for (const m of d.inbox) out.push(String(m));
    const wx = (c) => (hx - 3 + c + 8 * w) % w, wy = (r) => (hy - 3 + r + 8 * h) % h;
    const inWin = new Set();
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const x = wx(c), y = wy(r), i = y * w + x;
        inWin.add(i);
        out.push(x + ' ' + y + ' ' + g.pearl[i] + ' ' + g.cd[g.cdGroup[i]]);
      }
    }
    const bodies = [];
    for (const o of g.dragons.values()) {
      if (!o.alive) continue;
      for (let k = 0; k < o.segs.length; k++) {
        const s = o.segs[k];
        if (inWin.has(s.y * w + s.x)) bodies.push((o.team === 0 ? 'A ' : 'B ') + o.id + ' ' + s.x + ' ' + s.y + ' ' + DIR_NAMES[s.dir] + ' ' + (k === 0 ? 1 : 0));
      }
    }
    out.push('DRAGON_BODIES ' + bodies.length);
    for (const b of bodies) out.push(b);
    const sym = (kind, pid) => (kind === EDGE_KELP ? 'w' : kind === EDGE_PORTAL ? String(pid) : '.');
    for (let r = 0; r < 8; r++) {
      const row = [];
      for (let c = 0; c < 7; c++) { const i = wy(r) * w + wx(c); row.push(sym(g.edgeN[i], g.portalN[i])); }
      out.push(row.join(' '));
    }
    for (let r = 0; r < 7; r++) {
      const row = [];
      for (let c = 0; c < 8; c++) { const i = wy(r) * w + wx(c); row.push(sym(g.edgeW[i], g.portalW[i])); }
      out.push(row.join(' '));
    }
    return out.join('\n') + '\n';
  }

  /**
   * Parse a bot's reply the way the official engine does: whitespace-tolerant tokens, the
   * last MOVE/SPLIT/SONAR wins, unparseable lines are skipped, nothing after ENDTURN is read,
   * and a final line without a newline is never seen. Integers follow strtoull + truncation
   * to 32 bits, which is what the official engine was observed to do.
   */
  function parseReply(text) {
    const action = { type: 'none' };
    const lines = String(text).split('\n');
    lines.pop(); // the part after the last newline is an unterminated line
    for (const raw of lines) {
      const tok = raw.trim().split(/\s+/);
      if (tok[0] === 'ENDTURN' && tok.length === 1) break;
      if (tok.length !== 2) continue;
      if (tok[0] === 'MOVE' && /^[NESW]+$/.test(tok[1])) {
        action.type = 'move'; action.dirs = Array.from(tok[1], dirFromChar); delete action.n;
      } else if (tok[0] === 'SPLIT' && /^[+-]?\d+$/.test(tok[1])) {
        action.type = 'split'; action.n = low32(tok[1]) | 0; delete action.dirs;
      } else if (tok[0] === 'SONAR' && /^[+-]?\d+$/.test(tok[1])) {
        action.sonar = low32(tok[1]);
      }
    }
    return action;
  }

  function low32(str) {
    const neg = str[0] === '-';
    let v = BigInt(str.replace(/^[+-]/, ''));
    const MAX = (1n << 64n) - 1n;
    if (v > MAX) v = MAX; else if (neg) v = ((1n << 64n) - v) & MAX;
    return Number(v & 0xffffffffn);
  }

  // ---------------------------------------------------------------- snapshots for the network / UI
  function snapshotDragon(d) {
    const flat = new Array(d.segs.length * 3);
    for (let k = 0; k < d.segs.length; k++) { const s = d.segs[k]; flat[3 * k] = s.x; flat[3 * k + 1] = s.y; flat[3 * k + 2] = s.dir; }
    return { id: d.id, team: d.team, segs: flat, parent: d.parent, eaten: d.eaten, kills: d.kills };
  }

  function snapshot(g) {
    const pearls = [];
    for (let i = 0; i < g.n; i++) if (g.pearl[i]) pearls.push(i);
    return {
      round: g.round, maxRounds: g.maxRounds,
      dragons: living(g).map(snapshotDragon),
      pearls,
      cd: Array.from(g.cd),
      order: g.order.slice(), turnIdx: g.turnIdx, inRound: g.inRound,
      teams: [summary(g, 0), summary(g, 1)],
      over: g.over, result: g.result,
    };
  }

  /** The static part of the map, sent to clients once. */
  function staticMap(g) {
    return {
      w: g.w, h: g.h, name: g.name, symmetry: g.symmetry,
      edgeN: Array.from(g.edgeN), edgeW: Array.from(g.edgeW),
      portalN: Array.from(g.portalN), portalW: Array.from(g.portalW),
      partnerN: Array.from(g.partnerN), partnerW: Array.from(g.partnerW),
      cdGroup: Array.from(g.cdGroup),
      spawns: Array.from(g.maxGap, (m) => (m > 0 ? 1 : 0)),
      minGap: Array.from(g.minGap), maxGap: Array.from(g.maxGap),
      unitLimit: g.unitLimit,
    };
  }

  return {
    N, E, S, W, DIR_NAMES, DX, DY, opposite, dirFromChar,
    EDGE_OPEN, EDGE_KELP, EDGE_PORTAL, DEATH, DEATH_TEXT, DEFAULT_MAX_ROUNDS, DEFAULT_UNIT_LIMIT,
    MapError, parseMap, createGame, look, teamCount, living, summary,
    beginRound, currentDragon, act, endRound, viewBlock, parseReply,
    snapshot, snapshotDragon, staticMap, mulberry32,
  };
});
