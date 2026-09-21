# Dragon Arena

UNSW Battlecode 2026 (the dragons-and-pearls game), playable by hand in a browser, in real time,
against a friend or a built-in AI. It exists for one purpose: **finding out what actually works**
before you write it into a bot.

* Same rules as the competition — the engine in `lib/engine.js` is verified turn for turn against
  the official engine (see *Fidelity* below).
* Same maps — the 11 maps bundled with the official toolkit, plus any `.map` file you paste in.
* Same turn order — dragons act **one at a time, in ascending id order**, and the child of a split
  acts later in the round it was born in. The clock only decides how long you get to think.
* Full-map vision for the humans (a deliberate departure: you are looking for strategy, not
  simulating a bot's 7×7 window — though you can overlay that window on any dragon).

## Run it

Needs Node.js 18 or newer. There are no npm dependencies.

```sh
node server.js              # http://localhost:8080
PORT=9000 node server.js
```

### On a server (Ubuntu / Debian)

```sh
unzip dragon-arena.zip && cd dragon-arena
sudo bash deploy.sh                          # installs to /opt/dragon-arena, runs as a systemd service on :8080
sudo PORT=auto bash deploy.sh                # port 80 if nothing else uses it (open by default on Lightsail), else 8080
sudo PORT=9000 ACCESS_KEY=pearls bash deploy.sh   # other port; only links containing ?key=pearls can connect
```

The script installs Node.js if the machine has none (apt where it is new enough, otherwise the
official build from nodejs.org). The service runs as its own unprivileged user inside a systemd
sandbox (it can write its `replays/` folder and cannot see `/root` or `/home`). It listens on IPv6
and IPv4 alike; on an IPv6-only machine the address goes in brackets: `http://[2001:db8::1]:8080/`.
Remember to open the TCP port in your cloud provider's firewall / security group.
Logs: `journalctl -u dragon-arena -f`.

## Playing

Create a room, send your friend the invite link (or add an AI), pick a map, start.

### The clock

| Setting | Meaning |
| --- | --- |
| **Turn timer** | When the dragon whose turn it is belongs to a human, is in *Manual* mode and has nothing queued, the game waits this long for an order. `Off` never waits (pure real-time), `Unlimited` waits forever (turn-based study). |
| **Round pace** | Minimum wall-clock length of a round. The dragons' turns are spread across it, so you can watch the id order ripple over the board. |
| **Rounds** | 500 is competition length. |
| **Swerve assist** | A manual dragon that receives no order keeps going straight; with assist on it turns away if the tile ahead is fatal. |

Both can be changed mid-game, and either player can pause. While paused you can still queue
orders, and step the game one dragon turn (`.`) or one round (`,`) at a time.

### Controls

| Keys | |
| --- | --- |
| `W A S D` / arrows | Order the selected dragon to move. Applied at once if the game is waiting on that dragon, otherwise queued (one order per turn). Orders straight into kelp or back into your own neck are refused unless you hold `Ctrl`. |
| `Shift` + directions | Build a **sprint** — several steps in one turn, each extra step costs a segment. Release `Shift` to send. |
| `Shift` + click | Sprint to that tile — or into that enemy head — by the shortest open path, this turn. |
| `Q` / `E` / `X` | Split in half / split off a 2-segment child / click a segment to choose the cut. |
| `1` `2` `3` `4` | Mode of the selected dragon: Manual · Forage · Coil · Hunt. Right-click a tile: swim there, then coil. |
| `Tab`, click | Select. `F` toggles auto-selecting the dragon the game is waiting on. |
| `Backspace` | Clear the selected dragon's queue. |
| `Space` `.` `,` | Pause · step one turn · step one round. |
| `I` `T` `V` `R` `H` `C` | Ids · pearl spawn timers · 7×7 bot vision · sprint range of the selection · tiles enemy heads can reach this turn · centre on selection. Middle-drag (or Alt-drag) slides the wrap-around map. |

Autopilot modes decide at the moment of the dragon's turn, from the live board, exactly when a bot
would be asked. New dragons born from a split start in the mode chosen under *new:* (Forage by default).

### Things worth trying

* A dragon of length L can move **L − 1 tiles in one turn**. Moving into a head kills both dragons,
  whatever their sizes. Turn on *Enemy reach* and watch what that means for your long dragon.
* A split does not move the head — it is a legal way to stand still — and the child swims off in
  the opposite direction. That gets length out of a dead end.
* A dead dragon drops ⌈L/2⌉ pearls. Feeding a team-mate is lossy but possible.
* Lower ids act first. Look at who gets to a contested tile first, and who can react to whom.
* Brighter water spawns pearls more often; *Timers* shows tiles about to spawn.

## AI opponents

`Gatherer` (easy), `Hunter` (medium), `Balanced` (hard), `Swarm` (brutal). They are heuristics, not
search: time-aware BFS, Voronoi-style territory, a two-ply "can I be pinned" check, ram detection.
All of it is in `lib/ai.js` and is meant to be read and edited.

Test an idea over many games without opening a browser:

```sh
node sim.js --list
node sim.js --a swarm --b balanced --map default --games 20
node sim.js --all --map default_small --games 10     # round robin
```

## Replays

Every finished game is stored under `replays/` (gzipped JSON, the newest 80 are kept) and can be
watched in the browser: *Watch the replay* after a game, the list on the home page, or
`http://host:8080/?replay=<id>` — a link you can send to a friend.

## Fidelity

`test/diff-test.js` plays whole games on the **official engine** (`official/unswbc_engine.wasm`, from
the MIT-licensed `unswbc` toolkit on PyPI) and on `lib/engine.js` in lockstep, feeding both the same
seeded, chaotic decisions — sprints, splits, sonar, fatal moves, malformed commands — and requires

* every view block the official engine sends a dragon to be **byte-identical** to ours,
* identical spawns, identical deaths (dragon, round, reason), identical final result.

The full run is 900+ games and ~180 000 dragon turns on all official maps plus synthetic maps that
stress portals, the wrap seam and the three symmetry types; five more scenarios pin the 500-round
tie-breaks. Pearl countdowns are random in both engines, so the test rewrites each map to
`minGap == maxGap`, which makes pearls deterministic without touching any other rule.

Deliberate differences from the competition, all in the scheduler or the UI, none in the rules:

* humans see the whole map;
* a queued order that would be a "no valid action" death (illegal split, unaffordable sprint) is
  skipped or trimmed instead of killing the dragon — that rule exists for crashed bots;
* sonar is implemented in the engine but not exposed in the UI (humans can just talk).

The server itself runs on Node 18+; the comparison tests need Node 22+, because the official
engine's WebAssembly uses features older V8 versions reject.

```sh
npm test                      # quick diff test + scheduler tests + WebSocket protocol tests
node test/diff-test.js        # the full differential suite (about 25 s)
node test/stress.js           # every AI pairing on every map, engine invariants checked after every turn
node test/browser-play.js     # two real browsers play a game (needs Playwright), screenshots in test/shots
```

## Layout

```
server.js        HTTP + WebSocket rooms, replay storage
lib/engine.js    the rules (also loaded by the browser for geometry)
lib/match.js     the real-time scheduler: id order, turn timer, queues, pause/step, replay recording
lib/ai.js        autopilot policies and AI team brains
lib/ws.js        a small RFC 6455 WebSocket server
public/          the browser client (no build step)
maps/            official maps
sim.js           headless AI-vs-AI simulator
test/, official/ tests and the official engine they are checked against
```

## Credits

Game design, maps and the reference engine: UNSW CPMSoc Battlecode (https://battlecode.au), MIT
licence — see `maps/LICENSE-official-maps.txt`. This project is an unofficial practice tool.
