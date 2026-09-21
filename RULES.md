# UNSW Battlecode: game and bot reference

This document describes the rules and programming interface published by the [official documentation](https://game.battlecode.au/docs/overview), checked on 21 September 2026. It is written for this repository's Python bot (`main.py`, `bot.toml`). The game engine's rules govern if a local observation or replay appears inconsistent with an example here.

## 1. Objective, rounds, and scoring

- Two teams control snake-like dragons. Each dragon runs **its own instance of the team's one bot program**. Program memory is private to that dragon; splitting starts a fresh process for the child. Dragons communicate in-game only through sonar.
- Each team may have at most **64 living dragons**. The unit limit is also supplied in the game input; use that value when checking a split. The helper's published spawn length is **3 segments**, and the minimum living dragon length is **2**. Custom map files may specify initial dragons of length at least 2.
- A game lasts at most **500 rounds**. At the start of a round, pearl spawn timers tick. Living dragons then take one turn each in **ascending dragon ID** order. A newly split child receives the next unused ID and takes its first turn later in that same round. A dragon killed before its scheduled turn is skipped.
- After the round, elimination ends the game. If exactly one team has no living dragons, the other wins; if both teams were eliminated in the same round, it is a draw. If both survive through round 500, compare (1) their **longest living dragon**, then (2) **total length of all living dragons**, then declare a draw if still tied. Dead dragons do not count.

Sources: [overview](https://game.battlecode.au/docs/overview), [structure](https://game.battlecode.au/docs/structure), [execution order](https://game.battlecode.au/docs/execution-order), [helper reference](https://game.battlecode.au/docs/helper).

## 2. Map and information available

- The map is a rectangular grid, **10–64 tiles in each dimension**. `(0, 0)` is the top-left; `x` increases east and `y` increases south. North decreases `y`. Both axes **wrap around**: crossing a border enters the opposite side. Maps have horizontal, vertical, or 180-degree rotational symmetry, although the symmetry type is not directly provided to the bot.
- Tiles may contain a pearl, a dragon segment, or neither, and have a pearl countdown. Special features are on the **edges between tiles**, including border edges. An edge is `EMPTY`, `KELP`, or `PORTAL`.
- Crossing a kelp edge kills the dragon. A portal edge has a non-negative ID; exactly one other edge shares it. Paired edges have the same orientation. Portals work from either side: crossing one exits across the paired edge on the corresponding side. Ordinary vision does not extend through a portal, but movement and sonar do.
- A dragon sees the **7 × 7 square** centered on its head, including wraparound tiles: Chebyshev distance at most 3. Each visible tile supplies absolute wrapped coordinates, whether it has a pearl, its spawn countdown, any dragon segment, and its four edges. A segment supplies team, dragon ID, head flag, and facing; body facing points toward the head. `get_tile` returns `None` outside the current vision window. The bot also knows its own length, team, ID, head position, facing at the start of this turn, team unit count, round number, and map dimensions.
- The board shown by a replay viewer is global information for humans; a bot receives only the window and metadata above, plus its sonar inbox.

Sources: [map](https://game.battlecode.au/docs/map-info), [kelp and portals](https://game.battlecode.au/docs/kelp-and-portals), [vision](https://game.battlecode.au/docs/vision), [helper reference](https://game.battlecode.au/docs/helper).

## 3. Pearls and growth

- Pearls are the resource that grows dragons. When the head enters a tile containing a pearl, it eats the pearl and the tail **does not advance** for that movement step, increasing length by one.
- At the beginning of every round, each tile's countdown decreases by one, in row-major order. On reaching zero, a pearl appears **only if the tile is empty** of both pearls and dragon segments. The countdown is reset even if spawning was blocked, choosing uniformly from the tile's hidden inclusive `[min_gap, max_gap]` range. A tile whose `max_gap` is zero never spawns and reports `-1`. Mirror tiles share a countdown, but a blocked mirror tile can fail to spawn while its partner succeeds.
- Death creates additional pearls as described in section 7. These drops do not reset tile countdowns.

Source: [pearls](https://game.battlecode.au/docs/pearls).

## 4. Exactly what counts as a turn action

**A dragon must supply one legal action per turn.** The action is either one `MOVE` command or one `SPLIT` command. Outputting several action commands does **not** perform them all: the **last parseable `MOVE` or `SPLIT` command** replaces the previous action. A later parseable but illegal split or unaffordable sprint therefore replaces an earlier safe move and kills the dragon as `No Valid Action`. A malformed line is skipped; if no action remains after parsing, the default suicide action kills the dragon.

`MOVE NNE` is **one action** containing three sequential steps, north, north, east. Each step is resolved in order. It is different from outputting `MOVE N` followed by `MOVE N` followed by `MOVE E`, which selects only the final eastward one-step move. There is no fixed one-step maximum, but each step after the first consumes one segment, so a long sprint can kill the dragon.

`SONAR` is a **separate optional per-turn command**, not the action slot. Therefore **sonar and movement can be requested in the same turn**, as can sonar and splitting. `INDICATOR` is another separate optional setting. Each newer `SONAR` overwrites the previous sonar value, and each newer `INDICATOR` overwrites the previous label. `LOG`, `DOT`, and `LINE` are replay/debug commands applied as read; they consume no game action, but do consume computational budget through output.

The engine collects commands until `ENDTURN` and then applies the action. **Only after that, if the dragon survives,** it casts the selected sonar from the head along its **new facing**. Thus a dragon that dies while moving does not transmit sonar. A split can also be followed by sonar if the parent survives.

Source: [execution order](https://game.battlecode.au/docs/execution-order), [movement](https://game.battlecode.au/docs/movement), [sonar](https://game.battlecode.au/docs/sonar), [wire protocol](https://game.battlecode.au/docs/protocol).

## 5. Movement and collisions

- A normal `MOVE` steps one tile north, east, south, or west. The head enters the destination and the body follows; the tail advances unless a pearl was eaten. Moving backwards is permitted as a command but usually collides with the dragon's own neck.
- A sprint is a **single move action with a sequence of directions**, such as `NNE`. For `x` steps, it normally removes `x - 1` tail segments in addition to ordinary movement. Before every step after the first, the engine checks whether the dragon can pay for that extra step. The published Python helper warns that, absent growth, the dragon must be **longer than the number of steps**. A sprint is not truncated to a safe prefix: failure to pay kills it. Pearls eaten on earlier steps can change length before later checks.
- Each sprint step updates facing, crosses the relevant edge (including a possible portal), checks collisions, moves the head, eats any pearl, advances the tail if appropriate, and removes the extra segment if this was not the first step. Steps that succeeded before a later fatal step remain in effect. The remaining steps and sonar are discarded on death.
- Kelp kills on edge crossing. Entering **any own segment, including the tail's current tile**, kills the mover; collision is checked **before** that step's tail movement. Entering another dragon's body kills the mover. Entering another dragon's **head** kills **both**, regardless of team. The other head dies first in the engine's death sequence.
- Because the board and body change between sprint steps, direction order matters. `NNE` and `ENN` may have different outcomes even if they target the same final tile. Earlier dragons in the ID order can also change the board before later dragons act.

Sources: [movement](https://game.battlecode.au/docs/movement), [execution order](https://game.battlecode.au/docs/execution-order), [death](https://game.battlecode.au/docs/death).

## 6. Splitting and sonar

**Split.** `SPLIT n` gives the rear `n` segments to a child. Those segments reverse order, making the old tail the child's head facing away from the parent. The child has the next ID, a fresh program instance and no inherited memory, and acts later in the same round. The split is legal only if **child length ≥ 2**, **remaining parent length ≥ 2**, and the team currently has fewer than its unit limit (normally 64) living dragons. An illegal split kills the parent. Use `ct.can_split(n)` before `ct.do_split(n)`.

**Sonar.** A living dragon may send one **unsigned 32-bit integer** (`0` through `4,294,967,295`) per turn. After its action, the signal leaves its head in its current facing direction, wraps around the map and travels through portals. It stops at the first kelp edge or dragon segment; on hitting a dragon, the value enters that dragon's inbox, even if it is an enemy or the sender itself. It is lost if it meets no dragon within **map width + map height tiles**. There is no sender identity or team in the message. A recipient reads all values at the start of its next turn, in send order: a higher-ID recipient may receive one in the **same round**, while a lower-ID recipient receives it in the **next round**. The inbox is then emptied.

Sources: [splitting](https://game.battlecode.au/docs/splitting), [sonar](https://game.battlecode.au/docs/sonar), [execution order](https://game.battlecode.au/docs/execution-order).

## 7. Death and precise turn sequence

Death reasons are `Hit Wall` (kelp), `Hit Self`, `Hit Other Body`, `Head to Head`, and `No Valid Action` (including no action after parsing, illegal split, or oversprinting). A malformed line alone does not cancel an earlier parseable action. When a dragon dies, every second segment **as its body stands at that instant**, starting with its head, becomes a pearl: a length-`L` dragon drops `ceil(L / 2)` pearls. The dragon is then removed. In a head-on collision, the other dragon's death sequence runs before the moving dragon's.

For each round the engine: (1) ticks pearl timers; (2) gives each living dragon a turn in ID order, including children appended by splits; (3) checks elimination or the 500-round limit. For a turn it: (1) supplies and clears the sonar inbox; (2) defaults to suicide action, no sonar, no indicator; (3) reads bot commands; (4) applies the final action; (5) casts sonar if selected and alive.

A normal turn ends when the bot prints `ENDTURN` or blocks trying to read its next turn. If the bot exits or reaches its limit instead, **that turn's output is not delivered**, the default suicide applies, and the engine restarts the bot process with a fresh init block. Therefore always finish each turn cleanly and within budget.

Sources: [death](https://game.battlecode.au/docs/death), [execution order](https://game.battlecode.au/docs/execution-order), [timeouts](https://game.battlecode.au/docs/timeouts).

## 8. Python bot API used in this repository

`main.py` uses the supplied `helper.py` interface. The minimal pattern is:

```python
import helper as unswbc

ct, game = unswbc.init()  # read this dragon's process init block
while unswbc.update(ct, game):  # read a new turn
    ct.make_move(unswbc.Direction.NORTH)  # required action
    # Optional in the SAME turn: ct.send_sonar(1806)
    unswbc.end_turn()  # emits ENDTURN and flushes the commands
```

The exact movement and communication calls are:

| Python call | Argument and result | Wire command / effect |
| --- | --- | --- |
| `ct.make_move(direction)` | `unswbc.Direction` (`NORTH`, `EAST`, `SOUTH`, `WEST`) | Emits one `MOVE N/E/S/W` action. |
| `ct.make_moves(directions)` | `list[unswbc.Direction]` | Emits one `MOVE` action with concatenated direction letters, e.g. `MOVE NNE`; the helper does not check sprint affordability. |
| `ct.can_split(child_size)` | `int -> bool` | Checks whether a split is legal for the current state. |
| `ct.do_split(child_size)` | `int` | Emits `SPLIT n` action. |
| `ct.send_sonar(message)` | `int -> bool` | Emits `SONAR n`; returns `False` unless `message` is an unsigned 32-bit integer. |
| `ct.get_sonar_messages()` | `-> list[int]` | Values received since the previous turn, in send order. |

This loop is the official starter pattern. The published helper reference says `update()` returns `False` on game end or death, while some toolkit helper versions raise `EOFError` when stdin closes; check the `helper.py` bundled with the project before adding special shutdown handling. The helper also exposes `unswbc.Direction.get_direction_list()`, `direction.get_offset()/get_opposite()/get_left()/get_right()`, and `Position.add_dir(direction)` (wrapped neighbor). Relevant read-only calls are:

| Object | Useful methods and values |
| --- | --- |
| `game: unswbc.Game` | `get_round_num() -> int`, `get_map_size() -> tuple[int, int]`, `get_unit_limit() -> int`. |
| `ct: unswbc.Controller` | `get_id()`, `get_team()`, `get_length()`, `get_unit_count()`, `get_dir()`, `get_position()`, `get_head()`, `get_vision()`, `get_tiles()`, `get_tile(pos)`. |
| `tile: unswbc.Tile` | `get_position()`, `has_pearl()`, `get_pearl_time()`, `get_dragon()`, `get_edge(direction)`, `edges()`. |
| `part: unswbc.DragonPart` | `get_position()`, `get_id()`, `get_team()`, `get_dir()`, `is_head()`. |
| `edge: unswbc.Edge` | `get_edge_type() -> EdgeType`, `get_portal_id() -> int` (`-1` for non-portal). |

`unswbc.Team` is `A` or `B`; `unswbc.EdgeType` is `EMPTY`, `KELP`, or `PORTAL`. `ct.output_log(...)`, `ct.set_indicator_string(text)`, `ct.draw_indicator_dot(pos, r, g, b)`, and `ct.draw_indicator_line(start, end, r, g, b)` affect the replay only. Helpers format the wire output; raw `print` debugging to stdout can create invalid commands and waste points, so use the helper log call sparingly. The helper may be edited or replaced with a raw protocol reader.

Sources: [helper reference](https://game.battlecode.au/docs/helper), [quickstart](https://game.battlecode.au/docs/quickstart), [wire protocol](https://game.battlecode.au/docs/protocol).

## 9. Raw I/O protocol (version 2.1.0)

The engine sends **plain text on stdin**; the bot sends **plain text commands on stdout**. The process gets one init block with `ID <int>`, `TEAM A|B`, `MAP <width> <height>`, and `UNIT_LIMIT <int>`. A split child or restarted process gets its own init block. Then each turn's input, in order, is:

1. `ROUND <int>`, `DIR N|E|S|W`, `LENGTH <int>`, `UNIT_COUNT <int>`, `NUM_MSGS <int>`, then exactly that many unsigned 32-bit sonar values, one per line.
2. **49 tile lines** in 7 rows by 7 columns, starting three tiles north and west of the head. Each line is `x y hasPearl pearlIn`; coordinates are already wrapped; `hasPearl` is `0` or `1`, and `pearlIn = -1` means never spawns.
3. `DRAGON_BODIES <count>`, then `count` lines of `team id x y facing isHead` for all visible segments, including the bot's own. `team` is `A` or `B`, `facing` is `N/E/S/W`, and `isHead` is `0` or `1`.
4. **8 rows of 7 horizontal-edge tokens** (north edge of each tile row, then the south edge of the last row), followed by **7 rows of 8 vertical-edge tokens** (west edge of each tile column, then the east edge of the last column). `.` means open, `w` means kelp, and a decimal integer is a portal ID. Split on whitespace because an ID may have multiple digits.

The reply is one or more lines, **ending in `ENDTURN` followed by a flush**. Valid commands are `MOVE <N/E/S/W letters>`, `SPLIT <segment count>`, `SONAR <uint32>`, `INDICATOR <text>`, `LOG <text>`, `DOT <x> <y> <r> <g> <b>`, and `LINE <x1> <y1> <x2> <y2> <r> <g> <b>`. For example, `MOVE NNE` followed by `SONAR 90210` and `ENDTURN` is a three-step move and a sonar attempt on the **same turn**. `MOVE` and `SPLIT` share the one action slot; `SONAR` and `INDICATOR` each have their own last-value slot. Malformed lines are skipped with an engine log entry and do not replace an already valid action. The helper handles all formatting and flushing when used as above.

Source: [wire protocol](https://game.battlecode.au/docs/protocol), [execution order](https://game.battlecode.au/docs/execution-order).

## 10. Computational resources and judge environment

The overview's “approximately 25 ms” is an intuition, **not the enforced budget**. The judge runs each dragon in a WebAssembly sandbox and meters deterministic **CPU points**:

| Limit | Exact value |
| --- | --- |
| CPU points | **100,000,000 per dragon per turn**, including helper parsing, your first-turn imports/setup, command output, and other charged work. |
| Memory | **48 MB per dragon**. |
| Threads | **1 per dragon**; spawning another is denied. |
| Safety backstop | **1 second CPU time and 10 seconds wall time**, for code that evades the point meter. |

Exhausting the point budget stops the turn **without delivering any reply**, so that dragon dies; leave margin. The first turn has the same limit. Python helper parsing a round costs about **10 million points**. As scale examples, a 32 × 32 flood fill costs about **19 million in Python** versus **0.3 million in C++**, according to the official documentation.

Instruction prices are in points. Unlisted instructions cost **2**. Simple constants, local/global get/set, comparisons, ordinary arithmetic/bit operations, conversions, and reference-null operations cost **1**. Loads/stores and ordinary branches/returns cost **2**; integer or float division/remainder and `br_table` cost **3**; direct `call` costs **4**; indirect/reference/tail calls cost **6**. `memory.copy/fill/init` costs **10 + 1 per 8 bytes**. Table get/set/size/copy/fill/init and data/element drop cost **10**. `memory.grow` and `table.grow` cost **50**. Every 128-bit SIMD instruction costs **2**.

Host work is charged to the **same** budget: each write to stdout **or stderr** costs **2,500,000 + 4,000 per byte**; drawing random bytes costs **40,000 + 3 per byte**; opening a file or looking up a path costs **40,000**. Avoid flushing/logging each line: the helper buffers commands and flushes once in `end_turn()`. The judge reports stdout as a terminal, which affects buffering if bypassing the helpers.

The judge uses **CPython 3.13 with NumPy 2.5.3** for Python, and Clang 20 C17 or C++20 with `-O2 -msimd128` for C/C++. No other third-party packages are installed; pure-Python dependencies or C/C++ source dependencies must be bundled. The sandbox has **no network, child processes, additional threads, or writable filesystem**; the bot files are readable under `/bot`. Some standard-library modules requiring these services are absent. Randomness is seeded per dragon/game, and the virtual clock advances with points spent, making runs reproducible.

`unswbc run` on your machine uses local processes and **does not meter points**; it imposes only **10 seconds wall time per turn**. For Python, use `unswbc run --sandbox -v ...` to price turns like the judge and print point/memory use. C/C++ cannot currently be sandboxed locally. A normal local win does not prove judge-budget compliance.

Sources: [timeouts](https://game.battlecode.au/docs/timeouts), [standard library](https://game.battlecode.au/docs/libraries), [CLI](https://game.battlecode.au/docs/cli).

## 11. Project, testing, submissions, and matches

- The toolkit command is `unswbc`; its Python package needs **Python 3.11+** locally. `unswbc init python <project>` creates `main.py`, `helper.py`, and `bot.toml`. This checkout includes the Python `helper.py` generated by `unswbc 0.3.3`, with its `hasPearl` `0`/`1` conversion corrected. The `bot.toml` `include` list must include every submitted source file, including the helper; the current `include = ["*.py"]` does so.
- A local match is `unswbc run <map.map> <bot-project-A> <bot-project-B>`; the same project may play itself. `-v` reports rounds; with `--sandbox` on Python it also reports CPU points and memory. Test on multiple maps and inspect the replay. Map files are plain text; the toolkit and website map editor can create them.
- Submit a top-level zip containing `bot.toml` and all included source files, or run `unswbc submit <project>` after authenticating. The zip limit is **4 MB**, with **12 submissions per hour**. Only one built submission is active at a time; a successful new build becomes active, and an earlier ready build may be reactivated.
- Ranked battles are **five games** on randomly chosen maps and update team Elo once per battle. Unranked battles play one game per selected map and do not affect Elo. Autoscrims are ranked five-game battles drawn every two hours. The same active submission plays both. All battle results are public, and replays are available after a battle.
- Elo starts at **1500** and uses **K = 96** per ranked battle. Expected score is `1 / (1 + 10 ** ((opponent_rating - own_rating) / 400))`; actual score is the fraction of games won, with each draw worth one-half. The rounded change is `96 * (actual - expected)`, with the opponents' changes summing to zero.

Sources: [quickstart](https://game.battlecode.au/docs/quickstart), [submitting](https://game.battlecode.au/docs/submitting), [game format](https://game.battlecode.au/docs/game-format), [Elo](https://game.battlecode.au/docs/elo).

## 12. Custom map file essentials

A `.map` file has one directive per line. `MAP width height` is required first. Optional `MAP_NAME name` labels replays, and optional `SYMMETRY x|y|xy` specifies the mirror relationship used by pearl timers. `TILE_COUNT n` precedes exactly `n` lines of `TILE x y minGap maxGap`. `EDGE_COUNT n` precedes exactly `n` lines of `EDGE index kind portalId`, where `kind` is `0` open, `1` kelp (portal ID `-1`), or `2` portal (exactly two same-orientation edges per ID). `DRAGON_COUNT n` precedes exactly `n` lines of `DRAGON team segmentCount x y x y ...`, with team `0` for A or `1` for B and segment coordinates **head first**. Initial segments must be adjacent, non-overlapping, on the map, and length at least 2; dragon IDs are assigned in file order. The map editor is the practical way to generate edge indices.

Source: [map files](https://game.battlecode.au/docs/map-files).
