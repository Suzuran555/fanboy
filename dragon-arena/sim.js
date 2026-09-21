#!/usr/bin/env node
/*
 * Headless AI-vs-AI simulator — a quick way to test a strategic idea over many games.
 *
 *   node sim.js --a swarm --b hunter --map default --games 20
 *   node sim.js --all --map default_small --games 10        # round-robin of every style
 *   node sim.js --list
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Eng = require('./lib/engine');
const AI = require('./lib/ai');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? dflt : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true);
}

const MAP_DIR = path.join(__dirname, 'maps');
function loadMap(name) {
  const file = [name, path.join(MAP_DIR, name), path.join(MAP_DIR, name + '.map')].find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  if (!file) throw new Error(`map not found: ${name} (try --list)`);
  return Eng.parseMap(fs.readFileSync(file, 'utf8'));
}

function playGame(map, styleA, styleB, seed, maxRounds) {
  const g = Eng.createGame(map, { seed, maxRounds });
  const brains = [AI.createBrain(styleA), AI.createBrain(styleB)];
  while (!g.over) {
    Eng.beginRound(g);
    let d;
    while ((d = Eng.currentDragon(g))) Eng.act(g, brains[d.team].decide(g, d));
    Eng.endRound(g);
  }
  return g;
}

function series(map, a, b, games, maxRounds, verbose) {
  const tally = { a: 0, b: 0, draw: 0, reasons: {}, longest: [0, 0], total: [0, 0], count: [0, 0], rounds: 0, kills: [0, 0], ms: 0 };
  for (let k = 0; k < games; k++) {
    const t0 = Date.now();
    const g = playGame(map, a, b, 1000 + k, maxRounds);
    tally.ms += Date.now() - t0;
    const r = g.result;
    if (r.winner === 0) tally.a++; else if (r.winner === 1) tally.b++; else tally.draw++;
    tally.reasons[r.reason] = (tally.reasons[r.reason] || 0) + 1;
    tally.rounds += r.rounds + 1;
    for (const t of [0, 1]) { tally.longest[t] += r.teams[t].longest; tally.total[t] += r.teams[t].total; tally.count[t] += r.teams[t].count; tally.kills[t] += r.teams[t].stats.kills; }
    if (verbose) console.log(`  game ${k + 1}: ${r.winner === null ? 'draw' : 'AB'[r.winner] + ' wins'} (${r.reason}) after ${r.rounds + 1} rounds — longest ${r.teams[0].longest} vs ${r.teams[1].longest}, total ${r.teams[0].total} vs ${r.teams[1].total}, dragons ${r.teams[0].count} vs ${r.teams[1].count}`);
  }
  return tally;
}

if (arg('list')) {
  console.log('maps:   ' + fs.readdirSync(MAP_DIR).filter((f) => f.endsWith('.map')).map((f) => f.replace(/\.map$/, '')).join(', '));
  console.log('styles: ' + Object.keys(AI.STYLES).join(', '));
  process.exit(0);
}

const mapName = arg('map', 'default_small');
const games = parseInt(arg('games', '10'), 10);
const maxRounds = parseInt(arg('rounds', '500'), 10);
const map = loadMap(mapName);
const fmt = (n, games) => (n / games).toFixed(1);

if (arg('all')) {
  const styles = Object.keys(AI.STYLES);
  console.log(`Round-robin on ${mapName} (${map.w}x${map.h}), ${games} games per pairing, team A listed first\n`);
  for (const a of styles) {
    for (const b of styles) {
      const t = series(map, a, b, games, maxRounds, false);
      console.log(`${a.padEnd(9)} vs ${b.padEnd(9)}  A ${String(t.a).padStart(2)}  B ${String(t.b).padStart(2)}  draw ${String(t.draw).padStart(2)}   avg longest ${fmt(t.longest[0], games)} / ${fmt(t.longest[1], games)}   avg rounds ${fmt(t.rounds, games)}   ${(t.ms / games).toFixed(0)} ms/game`);
    }
  }
} else {
  const a = arg('a', 'balanced'), b = arg('b', 'balanced');
  console.log(`${a} (A) vs ${b} (B) on ${mapName} (${map.w}x${map.h}), ${games} games`);
  const t = series(map, a, b, games, maxRounds, true);
  console.log(`\nA wins ${t.a}, B wins ${t.b}, draws ${t.draw}   reasons ${JSON.stringify(t.reasons)}`);
  console.log(`averages — longest ${fmt(t.longest[0], games)} / ${fmt(t.longest[1], games)}, total length ${fmt(t.total[0], games)} / ${fmt(t.total[1], games)}, dragons ${fmt(t.count[0], games)} / ${fmt(t.count[1], games)}, kills ${fmt(t.kills[0], games)} / ${fmt(t.kills[1], games)}, rounds ${fmt(t.rounds, games)}, ${(t.ms / games).toFixed(0)} ms per game`);
}
