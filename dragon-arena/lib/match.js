/*
 * One running game: the real-time scheduler around the rules engine.
 *
 * Dragons ALWAYS act one at a time in ascending id order (children of a split act later in
 * the same round), exactly as in the competition. "Real time" comes from the clock:
 *   - roundMs   : the minimum wall-clock length of a round; the dragons' turns are spread
 *                 evenly across it, so you can watch the id order ripple through the board.
 *   - turnTimer : when the dragon whose turn it is belongs to a human, is in manual mode and
 *                 has nothing queued, the game waits this long for a command.
 *                 0 = never wait (pure real-time), < 0 = wait forever (turn-based study mode).
 * A manual dragon that gets no command keeps swimming straight (optionally swerving if the
 * next tile is fatal). Illegal queued actions are dropped instead of killing the dragon:
 * "no valid action" deaths are a bot-crash rule, not a human strategy.
 */
'use strict';
const { EventEmitter } = require('events');
const Eng = require('./engine');
const AI = require('./ai');

const MODES = ['manual', 'forage', 'coil', 'hunt', 'goto'];
const MAX_QUEUE = 16;
const MAX_STEPS = 32;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Match extends EventEmitter {
  /**
   * opts: { map (parsed), seats: [{kind:'human'|'ai', style}, x2], settings }
   * settings: { roundMs, turnTimer, maxRounds, assist, countdownMs, seed }
   */
  constructor(opts) {
    super();
    this.settings = Object.assign({ roundMs: 400, turnTimer: 1500, maxRounds: 500, assist: true, countdownMs: 3000 }, opts.settings);
    this.seats = opts.seats;
    this.g = Eng.createGame(opts.map, { seed: this.settings.seed, maxRounds: this.settings.maxRounds });
    this.brains = this.seats.map((s) => (s.kind === 'ai' ? AI.createBrain(s.style) : null));
    this.ctl = [new Map(), new Map()];          // per team: dragon id -> { mode, arg, queue }
    this.childMode = ['forage', 'forage'];
    this.connected = [true, true];
    this.ctlDirty = [false, false];
    this.paused = false;
    this.stepBudget = 0;
    this.awaiting = null;                       // { id, team, resolve, timer, deadline }
    this.aborted = false;
    this.started = false;
    this.pending = [];                          // deltas waiting to be flushed
    this.flushTimer = null;
    this.pauseWaiters = [];
    this.replay = { v: 1, map: null, settings: null, seats: null, frames: [], result: null, startedAt: Date.now() };
    this.turnLog = [];                          // events of the current round, for the replay
    for (const d of this.g.dragons.values()) if (this.seats[d.team].kind === 'human') this.ctl[d.team].set(d.id, { mode: 'manual', arg: null, queue: [] });
  }

  // ------------------------------------------------------------ public state
  staticMap() { return Eng.staticMap(this.g); }

  /** Everything a (re)joining client needs. `team` is 0/1 for a player, null for a spectator. */
  sync(team) {
    const g = this.g;
    return {
      map: this.staticMap(),
      state: Eng.snapshot(g),
      settings: this.publicSettings(),
      seats: this.seats.map((s) => ({ kind: s.kind, style: s.style || null, name: s.name || null })),
      paused: this.paused,
      awaiting: this.awaiting ? { id: this.awaiting.id, team: this.awaiting.team, ms: this.awaitRemaining() } : null,
      ctl: team === null || team === undefined ? null : this.ctlState(team),
    };
  }

  publicSettings() {
    const s = this.settings;
    return { roundMs: s.roundMs, turnTimer: s.turnTimer, maxRounds: s.maxRounds, assist: s.assist };
  }

  ctlState(team) {
    const list = [];
    for (const [id, c] of this.ctl[team]) list.push({ id, mode: c.mode, arg: c.arg, q: c.queue });
    return { list, childMode: this.childMode[team] };
  }

  // ------------------------------------------------------------ player input
  /** action: { k:'m', d:[0..3,...] } | { k:'s', n } ; opts.replace clears the queue first. */
  command(team, id, action, opts) {
    const c = this.ctl[team] && this.ctl[team].get(id);
    const d = this.g.dragons.get(id);
    if (!c || !d || !d.alive || d.team !== team) return 'That dragon is not yours to command.';
    const act = normalise(action);
    if (!act) return 'Malformed command.';
    if (opts && opts.replace) c.queue.length = 0;
    if (c.queue.length >= MAX_QUEUE) return 'Queue is full.';
    c.mode = 'manual'; c.arg = null;
    c.queue.push(act);
    this.ctlDirty[team] = true;
    // While paused the order is only queued: nothing moves until resume or a step.
    if (this.awaiting && this.awaiting.id === id && !this.paused) this.resolveAwait('cmd');
    else this.scheduleFlush();
    return null;
  }

  clearQueue(team, id) {
    const c = this.ctl[team] && this.ctl[team].get(id);
    if (!c) return;
    c.queue.length = 0;
    this.ctlDirty[team] = true;
    this.scheduleFlush();
  }

  setMode(team, ids, mode, arg) {
    if (!MODES.includes(mode)) return 'Unknown mode.';
    if (mode === 'goto' && !(Number.isInteger(arg) && arg >= 0 && arg < this.g.n)) return 'Bad target.';
    for (const id of ids) {
      const c = this.ctl[team] && this.ctl[team].get(id);
      if (!c) continue;
      c.mode = mode; c.arg = mode === 'goto' ? arg : null;
      if (mode !== 'manual') c.queue.length = 0;
      if (this.awaiting && this.awaiting.id === id && mode !== 'manual') this.resolveAwait('mode');
    }
    this.ctlDirty[team] = true;
    this.scheduleFlush();
    return null;
  }

  setChildMode(team, mode) {
    if (!MODES.includes(mode) || mode === 'goto') return 'Unknown mode.';
    this.childMode[team] = mode;
    this.ctlDirty[team] = true;
    this.scheduleFlush();
    return null;
  }

  setConnected(team, on) {
    this.connected[team] = on;
    if (!on && this.awaiting && this.awaiting.team === team) this.resolveAwait('timeout');
  }

  setPaused(on, by) {
    if (this.paused === on) return;
    this.paused = on;
    this.stepBudget = 0;
    this.push({ k: 'p', on, by: by || null });
    if (on) this.disarmAwait();
    else if (this.awaiting) {
      // The turn clock stood still during the pause; orders queued meanwhile are used right away.
      const c = this.ctl[this.awaiting.team].get(this.awaiting.id);
      if (c && c.queue.length) this.resolveAwait('cmd');
      else { this.armAwait(); this.push({ k: 'w', id: this.awaiting.id, team: this.awaiting.team, ms: this.awaitRemaining() }); }
    }
    this.flush();
    if (!on) { const w = this.pauseWaiters; this.pauseWaiters = []; for (const r of w) r(); }
  }

  /** While paused: let exactly `turns` dragon turns through. */
  step(turns) {
    if (!this.paused) return;
    turns = Math.max(1, Math.min(200, turns | 0));
    if (this.awaiting) {
      // The dragon being waited on is already past the gate: its turn is the first step.
      const c = this.ctl[this.awaiting.team].get(this.awaiting.id);
      this.resolveAwait(c && c.queue.length ? 'cmd' : 'timeout');
      turns--;
    }
    this.stepBudget += turns;
    const w = this.pauseWaiters; this.pauseWaiters = []; for (const r of w) r();
  }

  /** How many dragon turns until the current round is complete (a whole round if none has begun). */
  turnsLeftInRound() {
    const g = this.g;
    if (!g.inRound) return Math.max(1, Eng.living(g).length);
    let left = 0;
    for (let k = g.turnIdx; k < g.order.length; k++) { const d = g.dragons.get(g.order[k]); if (d && d.alive) left++; }
    return Math.max(1, left);
  }

  setPace(p) {
    if (Number.isFinite(p.roundMs)) this.settings.roundMs = Math.max(40, Math.min(5000, p.roundMs | 0));
    if (Number.isFinite(p.turnTimer)) this.settings.turnTimer = p.turnTimer < 0 ? -1 : Math.min(60000, p.turnTimer | 0);
    if (typeof p.assist === 'boolean') this.settings.assist = p.assist;
    this.push({ k: 'c', settings: this.publicSettings() });
    // A shorter timer applies to the turn already being waited on.
    if (this.awaiting && this.settings.turnTimer === 0) this.resolveAwait('timeout');
    this.scheduleFlush();
  }

  abort() {
    this.aborted = true;
    if (this.awaiting) this.resolveAwait('timeout');
    const w = this.pauseWaiters; this.pauseWaiters = []; for (const r of w) r();
    clearTimeout(this.flushTimer);
  }

  // ------------------------------------------------------------ delta plumbing
  push(delta) { this.pending.push(delta); }

  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, 30);
  }

  flush() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.pending.length) { const list = this.pending; this.pending = []; this.emit('deltas', list); }
    for (const team of [0, 1]) if (this.ctlDirty[team]) { this.ctlDirty[team] = false; this.emit('ctl', team, this.ctlState(team)); }
  }

  // ------------------------------------------------------------ the loop
  async run() {
    if (this.started) return;
    this.started = true;
    const g = this.g;
    this.replay.map = this.staticMap();
    this.replay.settings = this.publicSettings();
    this.replay.seats = this.seats.map((s) => ({ kind: s.kind, style: s.style || null, name: s.name || null }));
    this.replay.seed = g.seed;
    this.replay.initial = Eng.snapshot(g);
    try {
      if (this.settings.countdownMs > 0) {
        this.push({ k: 'n', ms: this.settings.countdownMs }); this.flush();
        await sleep(this.settings.countdownMs);
      }
      let clock = Date.now();
      while (!g.over && !this.aborted) {
        const ev = Eng.beginRound(g);
        this.turnLog = [];
        this.push({ k: 'r', r: g.round, sp: ev.spawned, rs: ev.resets, order: g.order.slice() });
        const frame = { r: g.round, sp: ev.spawned, rs: ev.resets, ev: this.turnLog };
        const slots = Math.max(1, g.order.length);
        const roundStart = Math.max(clock, Date.now() - 50);
        let turnNo = 0;
        let d;
        while ((d = Eng.currentDragon(g)) && !this.aborted) {
          await this.gate();
          if (this.aborted) break;
          const decided = await this.decide(d);
          if (this.aborted) break;
          this.applyTurn(d, decided);
          turnNo++;
          // Spread the turns across the round so the id order is visible.
          const due = roundStart + (this.settings.roundMs * Math.min(turnNo, slots)) / slots;
          const wait = due - Date.now();
          if (wait >= 4 && !this.paused) { this.scheduleFlush(); await sleep(wait); }
        }
        if (this.aborted) break;
        const over = Eng.endRound(g);
        const teams = [Eng.summary(g, 0), Eng.summary(g, 1)];
        this.push({ k: 'e', r: over ? g.round : g.round - 1, teams });
        frame.d = Eng.living(g).map((x) => [x.id, x.team].concat(flatSegs(x)));
        frame.teams = teams.map((t) => [t.count, t.longest, t.total]);
        this.replay.frames.push(frame);
        const rest = roundStart + this.settings.roundMs - Date.now();
        clock = Date.now() + Math.max(0, rest);
        this.scheduleFlush();
        if (rest >= 4 && !this.paused) await sleep(rest);
        else await sleep(0); // always yield once per round so sockets get served
      }
      if (!this.aborted) {
        this.replay.result = g.result;
        this.replay.deaths = g.deaths;
        this.push({ k: 'o', result: g.result, deaths: g.deaths.length });
        this.flush();
        this.emit('over', g.result);
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  /** Blocks while paused, unless a step was requested. */
  async gate() {
    while (this.paused && !this.aborted) {
      if (this.stepBudget > 0) { this.stepBudget--; return; }
      this.flush();
      await new Promise((resolve) => this.pauseWaiters.push(resolve));
    }
  }

  async decide(d) {
    const g = this.g, team = d.team;
    if (this.brains[team]) return { action: this.brains[team].decide(g, d), by: 'ai' };
    const c = this.ctl[team].get(d.id);
    if (!c) return { action: AI.straight(g, d, this.settings.assist), by: 'auto' };
    let queued = this.popQueue(d, c);
    if (queued) return { action: queued, by: 'queue' };
    if (c.mode !== 'manual') return { action: AI.runPolicy(g, d, c.mode, c.arg, {}), by: c.mode };
    const timer = this.settings.turnTimer;
    if (timer !== 0 && this.connected[team]) {
      const why = await this.awaitCommand(d, timer);
      if (this.aborted) return null;
      if (why === 'cmd') { queued = this.popQueue(d, c); if (queued) return { action: queued, by: 'manual' }; }
      if (why === 'mode' && c.mode !== 'manual') return { action: AI.runPolicy(g, d, c.mode, c.arg, {}), by: c.mode };
    }
    return { action: AI.straight(g, d, this.settings.assist), by: 'straight' };
  }

  /** Next legal queued action, skipping ones that would be a "no valid action" death. */
  popQueue(d, c) {
    while (c.queue.length) {
      const a = c.queue.shift();
      this.ctlDirty[d.team] = true;
      if (a.k === 's') {
        const n = a.n === 'half' ? Math.floor(d.segs.length / 2) : a.n;
        if (n >= 2 && d.segs.length - n >= 2 && Eng.teamCount(this.g, d.team) < this.g.unitLimit) return { type: 'split', n };
        this.emit('notice', d.team, `Dragon ${d.id}: split of ${n} is not legal at length ${d.segs.length} — skipped.`);
        continue;
      }
      // A sprint longer than the dragon can pay for is trimmed (each extra step costs a segment).
      const afford = Math.max(1, d.segs.length - 1);
      const dirs = a.d.length > afford ? a.d.slice(0, afford) : a.d;
      return { type: 'move', dirs };
    }
    return null;
  }

  awaitCommand(d, timer) {
    return new Promise((resolve) => {
      this.awaiting = { id: d.id, team: d.team, resolve, remaining: timer < 0 ? -1 : timer, deadline: -1, timer: null };
      if (!this.paused) this.armAwait();
      this.push({ k: 'w', id: d.id, team: d.team, ms: timer < 0 ? -1 : timer });
      this.flush();
    });
  }

  armAwait() {
    const a = this.awaiting;
    if (!a || a.remaining < 0 || a.timer) return;
    a.deadline = Date.now() + a.remaining;
    a.timer = setTimeout(() => this.resolveAwait('timeout'), a.remaining);
  }

  /** Freeze the turn clock (pause). */
  disarmAwait() {
    const a = this.awaiting;
    if (!a || !a.timer) return;
    clearTimeout(a.timer); a.timer = null;
    a.remaining = Math.max(0, a.deadline - Date.now());
  }

  awaitRemaining() {
    const a = this.awaiting;
    if (!a || a.remaining < 0) return -1;
    return a.timer ? Math.max(0, a.deadline - Date.now()) : a.remaining;
  }

  resolveAwait(why) {
    const a = this.awaiting;
    if (!a) return;
    this.awaiting = null;
    if (a.timer) clearTimeout(a.timer);
    a.resolve(why);
  }

  applyTurn(d, decided) {
    const g = this.g;
    const action = decided.action;
    const events = Eng.act(g, action);
    const delta = { k: 't', id: d.id, by: decided.by, a: action.type === 'split' ? 's' + action.n : action.type === 'move' ? action.dirs.map((x) => Eng.DIR_NAMES[x]).join('') : 'x' };
    if (action.note) delta.note = action.note;
    const up = [], dead = [], pa = [], pd = [];
    for (const e of events) {
      if (e.t === 'step') { if (e.ate) pd.push(e.y * g.w + e.x); }
      else if (e.t === 'death') {
        dead.push({ id: e.id, team: e.team, why: e.reason, by: e.by, len: e.length });
        for (const p of e.pearls) pa.push(p);
        this.ctl[e.team].delete(e.id);
        this.ctlDirty[e.team] = true;
        this.turnLog.push(['x', e.id, e.team, e.reason, e.by, e.length]);
      } else if (e.t === 'split') {
        const child = g.dragons.get(e.child);
        up.push(Eng.snapshotDragon(child));
        delta.child = e.child;
        if (this.seats[child.team].kind === 'human') { this.ctl[child.team].set(child.id, { mode: this.childMode[child.team], arg: null, queue: [] }); this.ctlDirty[child.team] = true; }
        this.turnLog.push(['s', e.id, e.child, e.n]);
      }
    }
    if (d.alive) up.push(Eng.snapshotDragon(d));
    if (up.length) delta.up = up;
    if (dead.length) delta.dead = dead;
    if (pa.length) delta.pa = pa;
    if (pd.length) delta.pd = pd;
    if (pa.length || pd.length) this.turnLog.push(['p', pa, pd]);
    this.push(delta);
    if (dead.length || delta.child !== undefined) this.scheduleFlush();
  }
}

function flatSegs(d) {
  const out = new Array(d.segs.length * 3);
  for (let k = 0; k < d.segs.length; k++) { const s = d.segs[k]; out[3 * k] = s.x; out[3 * k + 1] = s.y; out[3 * k + 2] = s.dir; }
  return out;
}

function normalise(a) {
  if (!a || typeof a !== 'object') return null;
  if (a.k === 'm') {
    if (!Array.isArray(a.d) || a.d.length < 1 || a.d.length > MAX_STEPS) return null;
    for (const x of a.d) if (!(x === 0 || x === 1 || x === 2 || x === 3)) return null;
    return { k: 'm', d: a.d.slice() };
  }
  if (a.k === 's') {
    if (a.n === 'half') return { k: 's', n: 'half' };
    if (!Number.isInteger(a.n) || a.n < 2 || a.n > 4096) return null;
    return { k: 's', n: a.n };
  }
  return null;
}

module.exports = { Match, MODES };
