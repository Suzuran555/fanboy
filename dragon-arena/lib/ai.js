/*
 * Autopilot policies and built-in AI opponents.
 *
 * Everything here decides ONE dragon's action at the moment of its turn, from the live
 * game state — the same moment a real bot would be asked — so ascending-id turn order is
 * respected: a dragon acting later in the round sees what earlier dragons just did.
 *
 * Policies (used both by AI teams and as autopilot modes for human players):
 *   forage : collect pearls, avoid traps and bad trades
 *   coil   : stay alive in as little space as possible (chase own tail)
 *   hunt   : ram enemy heads when the trade is good (sprint-torpedo), otherwise close in
 *   goto   : travel to a tile, then coil
 *   straight: keep heading; swerve only if the next tile is fatal (the manual-mode fallback)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'));
  else root.DragonAI = factory(root.DragonEngine);
})(typeof self !== 'undefined' ? self : this, function (Eng) {
  'use strict';

  // ---------------------------------------------------------------- static neighbour table
  function neighbours(g) {
    if (g._nbr) return g._nbr;
    const nbr = new Int32Array(g.n * 4);
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        for (let dir = 0; dir < 4; dir++) {
          const r = Eng.look(g, x, y, dir);
          nbr[(y * g.w + x) * 4 + dir] = r.kind === Eng.EDGE_KELP ? -1 : r.y * g.w + r.x;
        }
      }
    }
    g._nbr = nbr;
    return nbr;
  }

  const tileOf = (g, s) => s.y * g.w + s.x;

  // ---------------------------------------------------------------- per-turn scratch analysis
  /**
   * freeAt[t]: a tile can be entered on my m-th move from now iff m > freeAt[t].
   * A body segment k of a dragon of length L clears after L-k moves of that dragon (the
   * tail's tile is still blocked for the very next step, exactly as in the rules).
   * Other dragons get one move of slack in case they eat.
   */
  function computeFreeAt(g, me) {
    const freeAt = new Int16Array(g.n);
    for (const o of g.dragons.values()) {
      if (!o.alive) continue;
      const L = o.segs.length, slack = o === me ? 0 : 1;
      for (let k = 0; k < L; k++) freeAt[tileOf(g, o.segs[k])] = L - k + slack;
    }
    return freeAt;
  }

  /** Time-aware BFS. Returns { dist, first } where first[t] is the first direction of a shortest path. */
  function bfs(g, start, startMoves, freeAt) {
    const nbr = neighbours(g), n = g.n;
    const dist = new Int16Array(n).fill(-1), first = new Int8Array(n).fill(-1);
    const queue = new Int32Array(n);
    let qh = 0, qt = 0;
    dist[start] = startMoves; queue[qt++] = start;
    while (qh < qt) {
      const t = queue[qh++], m = dist[t] + 1;
      for (let dir = 0; dir < 4; dir++) {
        const nt = nbr[t * 4 + dir];
        if (nt < 0 || dist[nt] !== -1 || m <= freeAt[nt]) continue;
        dist[nt] = m; first[nt] = t === start ? dir : first[t];
        queue[qt++] = nt;
      }
    }
    return { dist, first, reached: qt - 1 };
  }

  /** Multi-source BFS through currently free tiles: distance from the nearest head in `heads`. */
  function headDistances(g, dragons) {
    const nbr = neighbours(g), n = g.n;
    const dist = new Int16Array(n).fill(-1);
    const queue = new Int32Array(n);
    let qh = 0, qt = 0;
    for (const o of dragons) { const t = tileOf(g, o.segs[0]); dist[t] = 0; queue[qt++] = t; }
    while (qh < qt) {
      const t = queue[qh++];
      for (let dir = 0; dir < 4; dir++) {
        const nt = nbr[t * 4 + dir];
        if (nt < 0 || dist[nt] !== -1 || g.occ[nt] !== -1) continue;
        dist[nt] = dist[t] + 1; queue[qt++] = nt;
      }
    }
    return dist;
  }

  /**
   * threat[t] = length of the SHORTEST enemy dragon that could sprint its head onto tile t
   * in a single turn right now (0 if none). A dragon of length L can take up to L-1 steps.
   */
  function threatMap(g, team) {
    const nbr = neighbours(g), n = g.n;
    const threat = new Int16Array(n);
    const seen = new Int32Array(n).fill(-1);
    const queue = new Int32Array(n), depth = new Int16Array(n);
    for (const e of g.dragons.values()) {
      if (!e.alive || e.team === team) continue;
      const L = e.segs.length, range = L - 1;
      let qh = 0, qt = 0;
      const s = tileOf(g, e.segs[0]);
      queue[qt++] = s; depth[s] = 0; seen[s] = e.id;
      while (qh < qt) {
        const t = queue[qh++];
        if (depth[t] >= range) continue;
        for (let dir = 0; dir < 4; dir++) {
          const nt = nbr[t * 4 + dir];
          if (nt < 0 || seen[nt] === e.id || g.occ[nt] !== -1) continue;
          seen[nt] = e.id; depth[nt] = depth[t] + 1; queue[qt++] = nt;
          if (threat[nt] === 0 || L < threat[nt]) threat[nt] = L;
        }
      }
    }
    return threat;
  }

  function teamLongest(g, team) {
    let best = null;
    for (const o of g.dragons.values()) if (o.alive && o.team === team && (!best || o.segs.length > best.segs.length)) best = o;
    return best;
  }

  /** Directions that do not kill the dragon on the spot. */
  function survivableDirs(g, d) {
    const nbr = neighbours(g), head = tileOf(g, d.segs[0]), out = [];
    for (let dir = 0; dir < 4; dir++) {
      const nt = nbr[head * 4 + dir];
      if (nt >= 0 && g.occ[nt] === -1) out.push(dir);
    }
    return out;
  }

  // ---------------------------------------------------------------- two-ply "can they pin me?" check
  let stampCounter = 1;
  let stampBlocked = null, stampFreed = null, stampSeen = null;
  function ensureStamps(n) {
    if (!stampBlocked || stampBlocked.length < n) { stampBlocked = new Int32Array(n); stampFreed = new Int32Array(n); stampSeen = new Int32Array(n); }
  }

  /** Bounded flood fill over free tiles, honouring a temporary overlay. Returns tiles found (<= cap). */
  function boundedFill(g, start, cap, stamp) {
    const nbr = neighbours(g);
    const seenStamp = ++stampCounter;
    const stack = [start];
    stampSeen[start] = seenStamp;
    let count = 0;
    while (stack.length) {
      const t = stack.pop();
      if (++count >= cap) return count;
      for (let dir = 0; dir < 4; dir++) {
        const nt = nbr[t * 4 + dir];
        if (nt < 0 || stampSeen[nt] === seenStamp) continue;
        if (stampBlocked[nt] === stamp) continue;
        if (g.occ[nt] !== -1 && stampFreed[nt] !== stamp) continue;
        stampSeen[nt] = seenStamp;
        stack.push(nt);
      }
    }
    return count;
  }

  /**
   * After I step onto `t`, is there a single reply by a nearby head that leaves me without
   * any continuation into a reasonably sized area? (The classic "pin against the kelp".)
   */
  function canBePinned(g, d, t, rivals) {
    if (rivals.length === 0) return false;
    ensureStamps(g.n);
    const nbr = neighbours(g), L = d.segs.length;
    const cap = Math.max(L + 3, 10);
    const myTail = tileOf(g, d.segs[L - 1]);
    const ate = g.pearl[t] === 1;
    for (const e of rivals) {
      const eh = tileOf(g, e.segs[0]), eL = e.segs.length, eTail = tileOf(g, e.segs[eL - 1]);
      for (let ed = 0; ed < 4; ed++) {
        const u = nbr[eh * 4 + ed];
        if (u < 0 || u === t) continue;
        if (g.occ[u] !== -1 && !(u === myTail && !ate)) continue; // the reply must be legal for them
        const stamp = ++stampCounter;
        stampBlocked[t] = stamp; stampBlocked[u] = stamp;
        if (!ate) stampFreed[myTail] = stamp;
        if (!g.pearl[u]) stampFreed[eTail] = stamp;
        if (stampBlocked[myTail] === stamp) stampFreed[myTail] = 0;
        let escape = false;
        for (let md = 0; md < 4 && !escape; md++) {
          const v = nbr[t * 4 + md];
          if (v < 0 || stampBlocked[v] === stamp) continue;
          if (g.occ[v] !== -1 && stampFreed[v] !== stamp) continue;
          if (boundedFill(g, v, cap, stamp) >= cap) escape = true;
        }
        if (!escape) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- the movement core
  /**
   * Score each survivable first step and return the best action.
   * goalFn(r, t) -> attraction of stepping onto tile t, given r = BFS from t.
   *
   * Space is judged Voronoi-style: only tiles we can reach no later than any other head
   * count as ours. That is what keeps dragons out of corridors someone else is already
   * coming down, and out of pockets three team-mates are squeezing into.
   */
  function chooseStep(g, d, ctx, goalFn, opts) {
    opts = opts || {};
    const nbr = neighbours(g), head = tileOf(g, d.segs[0]);
    const L = d.segs.length, facing = d.segs[0].dir;
    const dirs = survivableDirs(g, d);
    if (dirs.length === 0) return lastResort(g, d);
    let best = dirs[0], bestScore = -Infinity;
    const other = ctx.otherDist;
    for (const dir of dirs) {
      const t = nbr[head * 4 + dir];
      const r = bfs(g, t, 1, ctx.freeAt);
      let score = 0;
      let mine = 0;
      const dist = r.dist;
      for (let i = 0; i < g.n; i++) { const m = dist[i]; if (m >= 1 && (other[i] < 0 || m <= other[i])) mine++; }
      const need = L + 2;
      if (mine < need) score -= 2000 - mine * (1500 / need);
      // Log scale: the difference between 5 and 20 safe tiles matters far more than 60 vs 200.
      score += 45 * Math.log(Math.min(mine, 80) + 1);
      // Trades: standing where a shorter enemy can ram our head is bad, worse the more we'd lose.
      const th = ctx.threat[t];
      if (th > 0 && th < L * (opts.bold ? 0.5 : 0.85)) score -= (opts.queen ? 400 : 60) + (L - th) * (opts.queen ? 30 : 6);
      // Stepping next to another head invites a collision on a tile we both want.
      if (other[t] === 1) score -= 25;
      // Two-ply look: can one reply from a nearby head seal us in?
      if (ctx.rivals.length && canBePinned(g, d, t, ctx.rivals)) score -= 900;
      if (g.pearl[t]) score += 30;
      score += goalFn(r, t);
      if (dir === facing) score += 0.4;
      if (opts.debug) opts.debug.push({ dir: 'NESW'[dir], score: +score.toFixed(1), mine, reached: r.reached + 1, threat: th, goal: +goalFn(r, t).toFixed(1) });
      if (score > bestScore) { bestScore = score; best = dir; }
    }
    // Cornered with almost no space left: a split lets most of the body leave backwards.
    if (bestScore < -1200 && L >= 4 && splitIsSane(g, d, L - 2)) return { type: 'split', n: L - 2, note: 'escape-split' };
    return { type: 'move', dirs: [best] };
  }

  /**
   * No survivable step exists. A split does not move the head, so a long enough dragon can
   * stall — and its rear half swims away as a new dragon. Otherwise pick the least bad
   * death: take an enemy head with us if we can, never a team-mate's.
   */
  function lastResort(g, d) {
    const L = d.segs.length;
    if (L >= 4 && splitIsSane(g, d, L - 2)) return { type: 'split', n: L - 2, note: 'escape-split' };
    const nbr = neighbours(g), head = tileOf(g, d.segs[0]);
    let best = d.segs[0].dir, bestScore = -Infinity;
    for (let dir = 0; dir < 4; dir++) {
      const nt = nbr[head * 4 + dir];
      let score = 0;
      if (nt >= 0 && g.occ[nt] !== -1 && g.occ[nt] !== d.id) {
        const o = g.dragons.get(g.occ[nt]);
        const isHead = tileOf(g, o.segs[0]) === nt;
        if (isHead) score = o.team === d.team ? -100 : 50 + o.segs.length;
      }
      if (dir === d.segs[0].dir) score += 0.5;
      if (score > bestScore) { bestScore = score; best = dir; }
    }
    return { type: 'move', dirs: [best], note: 'doomed' };
  }

  function pearlGoal(g, d, ctx) {
    const pearls = ctx.pearls;
    return function (r) {
      let bestV = 0, density = 0;
      for (let k = 0; k < pearls.length; k++) {
        const p = pearls[k], dist = r.dist[p];
        if (dist < 0) continue;
        let v = 100 / (dist + 1);
        const ed = ctx.enemyDist[p];
        if (ed >= 0 && ed < dist) v *= 0.25;          // an enemy gets there first
        const fd = ctx.friendDist ? ctx.friendDist[p] : -1;
        if (fd >= 0 && fd + 1 < dist) v *= 0.4;        // a team-mate is much closer: leave it
        if (v > bestV) bestV = v;
        density += 8 / ((dist + 2) * (dist + 2));
      }
      if (bestV === 0) {
        // Nothing to eat: drift towards tiles about to spawn.
        for (let t = 0; t < g.n; t += 1) {
          const cd = g.cd[g.cdGroup[t]];
          if (cd < 0 || cd > 40 || r.dist[t] < 0) continue;
          const v = 20 / (Math.max(cd, r.dist[t]) + 2);
          if (v > bestV) bestV = v;
        }
      }
      return bestV + Math.min(density, 25);
    };
  }

  function targetGoal(target, weight) {
    return function (r, t) {
      if (t === target) return weight;
      const dist = r.dist[target];
      return dist < 0 ? 0 : weight / (dist + 1);
    };
  }

  // ---------------------------------------------------------------- ramming
  /**
   * Find the best enemy head this dragon can ram THIS TURN (the whole sprint resolves inside
   * our own turn, so the current board is exact). Returns { dirs, enemy } or null.
   */
  function findRam(g, d, ratio) {
    const nbr = neighbours(g), n = g.n;
    const L = d.segs.length, range = L - 1;
    if (range < 1) return null;
    const start = tileOf(g, d.segs[0]);
    const prev = new Int32Array(n).fill(-1), pdir = new Int8Array(n), depth = new Int16Array(n).fill(-1);
    const queue = new Int32Array(n);
    let qh = 0, qt = 0;
    queue[qt++] = start; depth[start] = 0;
    const myBest = teamLongest(g, d.team), enemyBest = teamLongest(g, 1 - d.team);
    let best = null, bestValue = 0;
    while (qh < qt) {
      const t = queue[qh++];
      if (depth[t] >= range) continue;
      for (let dir = 0; dir < 4; dir++) {
        const nt = nbr[t * 4 + dir];
        if (nt < 0) continue;
        const occ = g.occ[nt];
        if (occ !== -1) {
          const e = g.dragons.get(occ);
          if (e.team === d.team || tileOf(g, e.segs[0]) !== nt) continue;
          // Value of the trade: what they lose against what we lose.
          const gain = e.segs.length * (e === enemyBest ? 2 : 1);
          const cost = L * (d === myBest ? 3 : 1);
          const value = gain / cost;
          if (value >= ratio && value > bestValue) {
            const dirs = [dir];
            for (let c = t; c !== start; c = prev[c]) dirs.unshift(pdir[c]);
            best = { dirs, enemy: e }; bestValue = value;
          }
          continue;
        }
        if (depth[nt] !== -1) continue;
        depth[nt] = depth[t] + 1; prev[nt] = t; pdir[nt] = dir; queue[qt++] = nt;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- context shared by one turn
  function turnContext(g, d) {
    const friends = [], enemies = [];
    for (const o of g.dragons.values()) {
      if (!o.alive || o === d) continue;
      (o.team === d.team ? friends : enemies).push(o);
    }
    const pearls = [];
    for (let i = 0; i < g.n; i++) if (g.pearl[i]) pearls.push(i);
    return {
      freeAt: computeFreeAt(g, d),
      threat: threatMap(g, d.team),
      enemyDist: headDistances(g, enemies),
      friendDist: friends.length ? headDistances(g, friends) : null,
      otherDist: headDistances(g, friends.concat(enemies)),
      rivals: nearbyHeads(g, d, friends.concat(enemies), 4),
      pearls, friends, enemies,
    };
  }

  /** Other dragons whose head is within `radius` steps (torus Manhattan distance) of mine. */
  function nearbyHeads(g, d, others, radius) {
    const hx = d.segs[0].x, hy = d.segs[0].y, out = [];
    for (const o of others) {
      let dx = Math.abs(o.segs[0].x - hx), dy = Math.abs(o.segs[0].y - hy);
      dx = Math.min(dx, g.w - dx); dy = Math.min(dy, g.h - dy);
      if (dx + dy <= radius) out.push(o);
    }
    return out;
  }

  // ---------------------------------------------------------------- policies
  const move = (dir) => ({ type: 'move', dirs: [dir] });

  function forage(g, d, opts) {
    const ctx = turnContext(g, d);
    return chooseStep(g, d, ctx, pearlGoal(g, d, ctx), opts);
  }

  function coil(g, d, opts) {
    const ctx = turnContext(g, d);
    const tail = tileOf(g, d.segs[d.segs.length - 1]);
    // Chasing our own tail is the classic always-safe loop; grab pearls only if adjacent.
    return chooseStep(g, d, ctx, targetGoal(tail, 40), Object.assign({ queen: true }, opts));
  }

  function hunt(g, d, opts) {
    const ram = findRam(g, d, (opts && opts.ratio) || 1.2);
    if (ram) return { type: 'move', dirs: ram.dirs, note: 'ram' };
    const ctx = turnContext(g, d);
    const prey = teamLongest(g, 1 - d.team);
    // Only stalk prey that is worth the trade; otherwise keep eating.
    if (!prey || prey.segs.length < d.segs.length * 1.3) return forage(g, d, opts);
    const target = tileOf(g, prey.segs[0]);
    // Close in on the prey's head: aim for the free tiles around it.
    const nbr = neighbours(g);
    const ring = [];
    for (let dir = 0; dir < 4; dir++) { const nt = nbr[target * 4 + dir]; if (nt >= 0 && g.occ[nt] === -1) ring.push(nt); }
    const pg = pearlGoal(g, d, ctx);
    const goal = function (r, t) {
      let v = 0;
      for (const q of ring) { const dist = t === q ? 0 : r.dist[q]; if (dist >= 0) v = Math.max(v, 120 / (dist + 1)); }
      return v + pg(r, t) * 0.3;
    };
    return chooseStep(g, d, ctx, goal, Object.assign({ bold: true }, opts));
  }

  function goTo(g, d, target, opts) {
    if (tileOf(g, d.segs[0]) === target) return coil(g, d, opts);
    const ctx = turnContext(g, d);
    const pg = pearlGoal(g, d, ctx);
    return chooseStep(g, d, ctx, (r, t) => targetGoal(target, 150)(r, t) + pg(r, t) * 0.1, opts);
  }

  /** Manual-mode fallback: keep heading; with assist, swerve only if going straight is fatal. */
  function straight(g, d, assist) {
    const facing = d.segs[0].dir;
    if (!assist) return move(facing);
    const dirs = survivableDirs(g, d);
    if (dirs.length === 0 || dirs.includes(facing)) return move(facing);
    const ctx = { freeAt: computeFreeAt(g, d), threat: new Int16Array(g.n), otherDist: new Int16Array(g.n).fill(-1), rivals: [] };
    const act = chooseStep(g, d, ctx, () => 0, {});
    return act.type === 'move' ? act : move(facing); // the assist only ever steers, it never splits for you
  }

  /** Is splitting n segments off the tail legal and not instantly fatal for the child? */
  function splitIsSane(g, d, n) {
    const L = d.segs.length;
    if (n < 2 || L - n < 2 || Eng.teamCount(g, d.team) >= g.unitLimit) return false;
    const nbr = neighbours(g), tail = tileOf(g, d.segs[L - 1]);
    for (let dir = 0; dir < 4; dir++) { const nt = nbr[tail * 4 + dir]; if (nt >= 0 && g.occ[nt] === -1) return true; }
    return false;
  }

  function runPolicy(g, d, mode, arg, opts) {
    switch (mode) {
      case 'forage': return forage(g, d, opts);
      case 'coil': return coil(g, d, opts);
      case 'hunt': return hunt(g, d, opts);
      case 'goto': return goTo(g, d, arg, opts);
      default: return straight(g, d, true);
    }
  }

  // ---------------------------------------------------------------- AI team brains
  const STYLES = {
    gatherer: {
      label: 'Gatherer', blurb: 'Easy. Splits steadily, spreads out and farms pearls. Never picks a fight.',
      density: 70, maxDragons: 20, splitAt: 6, childShare: 0.5, ramRatio: 99, hunters: 0, lateRound: 0.8,
    },
    swarm: {
      label: 'Swarm', blurb: 'Brutal. Splits as early and as often as it can; tiny dragons everywhere, and they ram anything much longer than themselves.',
      density: 28, maxDragons: 48, splitAt: 4, childShare: 0.5, ramRatio: 1.8, hunters: 0, lateRound: 0.85,
    },
    hunter: {
      label: 'Hunter', blurb: 'Medium. Farms with most of its dragons and sends the rest to sprint-ram your longest dragon\'s head.',
      density: 60, maxDragons: 24, splitAt: 6, childShare: 0.5, ramRatio: 1.15, hunters: 0.35, lateRound: 0.9,
    },
    balanced: {
      label: 'Balanced', blurb: 'Hard. Farms first, protects its longest dragon, takes any clearly good trade.',
      density: 55, maxDragons: 26, splitAt: 6, childShare: 0.5, ramRatio: 1.5, hunters: 0.2, lateRound: 0.8,
    },
  };

  function createBrain(styleName) {
    const style = STYLES[styleName] || STYLES.balanced;
    const roles = new Map(); // dragon id -> 'hunter' | 'forager'
    return {
      style: styleName,
      decide(g, d) {
        const L = d.segs.length;
        const count = Eng.teamCount(g, d.team);
        const queen = teamLongest(g, d.team);
        const isQueen = queen === d && count > 1;
        const late = g.round >= g.maxRounds * style.lateRound;
        const want = Math.max(2, Math.min(style.maxDragons, Math.round(g.n / style.density)));

        // 1. A good ram beats everything (the sprint resolves inside this turn, so it is certain).
        if (style.ramRatio < 50 && !isQueen) {
          const ram = findRam(g, d, style.ramRatio);
          if (ram) return { type: 'move', dirs: ram.dirs, note: 'ram' };
        }
        // 2. Growth by splitting while the team is small; never in the endgame, never the queen late on.
        if (!late && count < want && L >= style.splitAt && !(isQueen && g.round > g.maxRounds * 0.35 && L < style.splitAt * 2)) {
          const n = Math.max(2, Math.min(L - 2, Math.floor(L * style.childShare)));
          const ctx = threatMap(g, d.team);
          const headT = tileOf(g, d.segs[0]), tailT = tileOf(g, d.segs[L - 1]);
          if (splitIsSane(g, d, n) && !ctx[headT] && !ctx[tailT]) return { type: 'split', n, note: 'split' };
        }
        // 3. Roles.
        if (!roles.has(d.id)) {
          let hunters = 0;
          for (const [id, r] of roles) { const o = g.dragons.get(id); if (o && o.alive && r === 'hunter') hunters++; }
          roles.set(d.id, hunters < Math.floor(count * style.hunters) ? 'hunter' : 'forager');
        }
        if (isQueen) return forage(g, d, { queen: true });
        if (roles.get(d.id) === 'hunter' && L >= 3 && !late) return hunt(g, d, { ratio: style.ramRatio });
        return forage(g, d, {});
      },
    };
  }

  return { STYLES, createBrain, runPolicy, forage, coil, hunt, goTo, straight, findRam, splitIsSane, survivableDirs, neighbours, threatMap, teamLongest };
});
