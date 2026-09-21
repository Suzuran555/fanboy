# Rule probes

Small experiments run against the official engine (`../oracle.js` drives `official/unswbc_engine.wasm`)
to pin down details the docs leave open. Each prints a trace; run e.g. `node test/probes/probeE.js`.

| Probe | Question answered |
| --- | --- |
| A | Pearl countdowns: initial draw, tick before round 0, spawn blocked by a body still redraws, eating stops the tail |
| B | Which edge indices are real: the seam column `x == w` and row `y == h` are ignored |
| C | `SYMMETRY x / y / xy` — which tiles share a countdown (x: flip rows, y: flip columns, xy: rotate 180°) |
| D | Sprints: cost, unaffordable sprints, reversing, last action wins, eating while sprinting |
| E | Where a dragon dies and drops pearls; head-on order; entering a tail's tile; chasing your own tail |
| F | Splits (child ids, facing, same-round turn), illegal splits, sonar delivery and wrap-around to self |
| G | Portals: exit tile and heading for both orientations; sonar through portals |
| H | Order of the sprint payment check versus collision checks |
| I, J | How tolerant the official command parser is (whitespace, integer overflow, ENDTURN, unterminated lines) |
