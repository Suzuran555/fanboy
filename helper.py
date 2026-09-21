import sys
from enum import Enum

INT_SIZE = 32
game: "Game" = None
ct: "Controller" = None

UINT32_MIN = 0
UINT32_MAX = (1 << INT_SIZE) - 1

class Constants:
    MAX_ROUNDS: int = 500
    VISION_RADIUS: int = 3
    VISION_SIZE: int = 2 * VISION_RADIUS + 1
    INITIAL_LENGTH: int = 3
    MIN_SIZE: int = 2

_OFFSET_BY_VALUE = {"N": (0, -1), "E": (1, 0), "S": (0, 1), "W": (-1, 0)}
# where a tile keeps the edge on that side
_INDEX_BY_VALUE = {"N": 0, "E": 1, "S": 2, "W": 3}

class Direction(Enum):
    NORTH = "N"
    EAST = "E"
    SOUTH = "S"
    WEST = "W"

    __hash__ = object.__hash__
    def __init__(self, value: str) -> None:
        self._offset: tuple[int, int] = _OFFSET_BY_VALUE[value]
        self._index: int = _INDEX_BY_VALUE[value]
    @property
    def value(self) -> str:
        return self._value_

    @classmethod
    def get_direction_list(cls) -> list["Direction"]:
        return _DIRECTIONS[::]
        
    def get_offset(self) -> tuple[int, int]:
        return self._offset

    def get_opposite(self) -> "Direction":
        return _OPPOSITE[self]

    def get_left(self) -> "Direction":
        return _LEFT[self]

    def get_right(self) -> "Direction":
        return _RIGHT[self]

_DIRECTIONS = [Direction.NORTH, Direction.EAST, Direction.SOUTH, Direction.WEST]
_DIRECTION_BY_VALUE = {d.value: d for d in _DIRECTIONS}
_OPPOSITE = {d: _DIRECTIONS[(i + 2) % 4] for i, d in enumerate(_DIRECTIONS)}
_LEFT = {d: _DIRECTIONS[(i + 3) % 4] for i, d in enumerate(_DIRECTIONS)}
_RIGHT = {d: _DIRECTIONS[(i + 1) % 4] for i, d in enumerate(_DIRECTIONS)}

class Team(Enum):
    A = "A"
    B = "B"

    def get_enemy_team(self) -> "Team":
        return Team.A if self == Team.B else Team.B

_TEAM_BY_VALUE = {"A": Team.A, "B": Team.B}

class Position:
    __slots__ = ("x", "y")

    def __init__(self, x: int, y: int):
        self.x = x
        self.y = y

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Position):
            return NotImplemented
        return self.x == other.x and self.y == other.y

    def __hash__(self) -> int:
        return hash((self.x, self.y))

    def __repr__(self) -> str:
        return f"Position({self.x}, {self.y})"

    def add_dir(self, direction: Direction) -> "Position":
        active_game = game
        if active_game is None:
            raise RuntimeError("init() must be called before using wrapped positions")
        dx, dy = direction._offset
        return Position((self.x + dx) % active_game.width,
                        (self.y + dy) % active_game.height)

    def is_in_map(self):
        return self.x >= 0 and self.y >= 0 and self.x < game.width and self.y < game.height
    
    def is_in_vision(self):
        if game is None:
            raise RuntimeError("init() must be called before checking vision")
        width, height = game.width, game.height
        if ct is None:
            raise RuntimeError("init() must be called before checking vision")
        pos = ct.get_position()
        if not (0 <= self.x < width and 0 <= self.y < height):
            return False
        left, top = pos.x - Constants.VISION_RADIUS, pos.y - Constants.VISION_RADIUS
        column = (self.x - left) % width
        row = (self.y - top) % height
        if column >= Constants.VISION_SIZE or row >= Constants.VISION_SIZE:
            return False
        return True

class Game:
    round_num: int = 0
    width: int = 0
    height: int = 0
    unit_limit: int = 0

    def __init__(self, width: int, height: int, unit_limit: int):
        self.round_num = 1
        self.width = width
        self.height = height
        self.unit_limit = unit_limit

    def get_round_num(self) -> int:
        return self.round_num

    def get_map_size(self) -> tuple[int, int]:
        return self.width, self.height

    def get_unit_limit(self) -> int:
        return self.unit_limit

class Vision:
    """The tiles around the head. update() only stores the round's lines,
    and a tile is parsed the first time it is asked for."""
    __slots__ = ("_tile_lines", "_body_lines", "_edge_lines", "_head", "_game",
                 "_left", "_top", "_tiles", "_dragon_parts", "_horizontal_edges", "_vertical_edges")

    def __init__(self, tile_lines: list[str], body_lines: list[str], edge_lines: list[str],
                 head: "DragonPart", game_state: Game):
        self._tile_lines = tile_lines
        self._body_lines = body_lines
        self._edge_lines = edge_lines
        self._head = head
        self._game = game_state
        if tile_lines:
            self._left = head.position.x - Constants.VISION_RADIUS
            self._top = head.position.y - Constants.VISION_RADIUS
        self._tiles: list["Tile | None"] = [None] * len(tile_lines)
        self._dragon_parts: dict[tuple[int, int], "DragonPart"] = None

    def get_tiles(self) -> list["Tile"]:
        if None in self._tiles:
            for i in range(len(self._tiles)):
                self._tile(i)
        return self._tiles[::]

    def get_tile(self, pos: Position) -> "Tile | None":
        if not self._tiles:
            return None
        width, height = self._game.width, self._game.height
        if not (0 <= pos.x < width and 0 <= pos.y < height):
            return None
        column = (pos.x - self._left) % width
        row = (pos.y - self._top) % height
        if column >= Constants.VISION_SIZE or row >= Constants.VISION_SIZE:
            return None
        return self._tile(row * Constants.VISION_SIZE + column)

    def _tile(self, i: int) -> "Tile":
        tile = self._tiles[i]
        if tile is None:
            if self._dragon_parts is None:
                self._read_dragons_and_edges()
            x, y, has_pearl, pearl_time = self._tile_lines[i].split()
            x, y = int(x), int(y)
            position = Position(x, y)
            entity = self._dragon_parts.get((x, y))

            west = i + i // Constants.VISION_SIZE
            horizontal, vertical = self._horizontal_edges, self._vertical_edges
            tile = self._tiles[i] = Tile(position, entity, int(pearl_time), has_pearl == "1", (
                horizontal[i], vertical[west + 1], horizontal[i + Constants.VISION_SIZE], vertical[west]))
        return tile

    def _read_dragons_and_edges(self) -> None:
        head = self._head
        self._dragon_parts = dragon_parts = {}
        for line in self._body_lines:
            team, dragon_id, x, y, facing, is_dragon_head = line.split()
            dragon_id, x, y = int(dragon_id), int(x), int(y)
            if dragon_id == head.dragon_id and is_dragon_head == "1":
                dragon_parts[x, y] = head
            else:
                dragon_parts[x, y] = DragonPart(Position(x, y), dragon_id, _TEAM_BY_VALUE[team],
                                                _DIRECTION_BY_VALUE[facing], is_dragon_head == "1")

        # the horizontal edge rows come first, and there is one more of them than tile rows
        rows = Constants.VISION_SIZE + 1
        horizontal = "".join(self._edge_lines[:rows]).split()
        vertical = "".join(self._edge_lines[rows:]).split()
        self._horizontal_edges = [_HORIZONTAL_EDGES[text] for text in horizontal]
        self._vertical_edges = [_VERTICAL_EDGES[text] for text in vertical]

class Tile:
    __slots__ = ("position", "dragon_part", "pearl_time", "pearl", "_edges", "_edges_by_direction")

    def __init__(self, position: Position, dragon_part: "DragonPart", pearl_time: int, has_pearl: bool,
                 edges: tuple["Edge", "Edge", "Edge", "Edge"]):
        self.position = position
        self.dragon_part = dragon_part
        self.pearl_time = pearl_time
        self.pearl = has_pearl
        # north, east, south, west
        self._edges = edges
        self._edges_by_direction = None

    @property
    def edges(self) -> dict[Direction, "Edge"]:
        if self._edges_by_direction is None:
            self._edges_by_direction = dict(zip(_DIRECTIONS, self._edges))
        return self._edges_by_direction

    def get_edge(self, direction: Direction) -> "Edge":
        return self._edges[direction._index]

    def get_dragon(self) -> "DragonPart | None":
        return self.dragon_part

    def has_pearl(self) -> bool:
        return self.pearl
        
    def get_pearl_time(self) -> int:
        return self.pearl_time

    def get_position(self) -> Position:
        return self.position

class DragonPart:
    __slots__ = ("position", "dragon_id", "team", "dir", "is_dragon_head")

    def __init__(self, position: Position, dragon_id: int, team: Team,
                 direction: Direction, is_dragon_head: bool):
        self.position = position
        self.dragon_id = dragon_id
        self.team = team
        self.dir = direction
        self.is_dragon_head = is_dragon_head

    def __repr__(self) -> str:
        return f"DragonPart(id={self.dragon_id}, dir={self.dir})"

    def get_position(self) -> Position:
        return self.position

    def get_id(self) -> int:
        return self.dragon_id

    def get_team(self) -> Team:
        return self.team

    def get_dir(self) -> Direction:
        return self.dir

    def is_head(self) -> bool:
        return self.is_dragon_head

class EdgeType(Enum):
    EMPTY = 0
    KELP = 1
    PORTAL = 2

class Edge:
    __slots__ = ("is_horizontal", "edge_type", "portal_id")

    def __init__(self, is_horizontal: bool, edge_type: EdgeType, portal_id: int = -1):
        self.is_horizontal = is_horizontal
        self.edge_type = edge_type
        self.portal_id = portal_id

    def get_edge_type(self) -> EdgeType:
        return self.edge_type

    # returns portal id if portal, else -1
    def get_portal_id(self) -> int:
        return self.portal_id

class _Edges(dict):
    """Edge objects by their protocol text: "." empty, "w" kelp, a number for a portal id.
    Edges with the same text share one object, so treat them as read-only."""

    def __init__(self, is_horizontal: bool):
        self.is_horizontal = is_horizontal
        self["."] = Edge(is_horizontal, EdgeType.EMPTY)
        self["w"] = Edge(is_horizontal, EdgeType.KELP)

    def __missing__(self, text: str) -> Edge:
        edge = self[text] = Edge(self.is_horizontal, EdgeType.PORTAL, int(text))
        return edge

_HORIZONTAL_EDGES = _Edges(True)
_VERTICAL_EDGES = _Edges(False)

class Controller:
    length: int = 0
    unit_count: int = 0
    unit_limit: int = 0
    head: DragonPart = None
    vision: Vision = None

    def __init__(self, dragon_id: int, team: Team, direction: Direction,
                 vision: Vision, unit_limit: int, sonar_messages: list[int] = None):
        self.length = Constants.INITIAL_LENGTH
        self.unit_count = 1
        self.unit_limit = unit_limit
        self.head = DragonPart(None, dragon_id, team, direction, True)
        self.vision = vision
        self.sonar_messages = list(sonar_messages) if sonar_messages is not None else []

    def get_length(self) -> int:
        return self.length

    def get_unit_count(self) -> int:
        return self.unit_count

    def get_head(self) -> DragonPart:
        return self.head

    def get_id(self) -> int:
        return self.head.dragon_id

    def get_team(self) -> Team:
        return self.head.team

    def get_dir(self) -> Direction:
        return self.head.dir

    def get_vision(self) -> Vision:
        return self.vision

    def get_tiles(self) -> list[Tile]:
        return self.vision.get_tiles()

    def get_tile(self, pos: Position) -> "Tile | None":
        return self.vision.get_tile(pos)

    def get_position(self) -> Position:
        return self.head.position

    def make_move(self, direction: Direction):
        print(f"MOVE {direction.value}")

    def make_moves(self, directions: list[Direction]):
        moves = "".join(direction.value for direction in directions)
        print(f"MOVE {moves}")

    def can_split(self, child_size: int) -> bool:
        return (Constants.MIN_SIZE <= child_size
                and self.length - child_size >= Constants.MIN_SIZE
                and self.unit_count < self.unit_limit)

    def do_split(self, child_size: int):
        print(f"SPLIT {child_size}")

    def output_log(self, *message):
        print(f"LOG ", *message)

    def draw_indicator_dot(self, pos: Position, r: int, g: int, b: int):
        print(f"DOT {pos.x} {pos.y} {r} {g} {b}")

    def draw_indicator_line(self, start: Position, end: Position, r: int, g: int, b: int):
        print(f"LINE {start.x} {start.y} {end.x} {end.y} {r} {g} {b}")

    def set_indicator_string(self, message: str):
        print(f"INDICATOR {message}")

    def get_sonar_messages(self) -> list[int]:
        return self.sonar_messages[::]

    def send_sonar(self, message: int) -> bool:
        if not _is_uint32(message):
            return False
        print(f"SONAR {message}")
        return True

def _is_uint32(value: object) -> bool:
    return (isinstance(value, int) and not isinstance(value, bool)
            and UINT32_MIN <= value <= UINT32_MAX)

# Read initial data from stdin, initialize game/controller
def init() -> tuple[Controller, Game]:
    global ct, game

    read = sys.stdin.readline
    dragon_id = int(read().split()[1])
    team = Team(read().split()[1])
    _, width, height = read().split()
    unit_limit = int(read().split()[1])

    game = Game(int(width), int(height), unit_limit)
    controller = Controller(dragon_id, team, Direction.NORTH, Vision([], [], [], None, game), unit_limit)
    ct = controller

    return controller, game

# Read turn data from stdin, update game/controller
def update(controller: Controller, game_state: Game) -> bool:
    read = sys.stdin.readline

    # judge ends each round input w blank line
    first = read()
    while first == "\n":
        first = read()
    if first == "":
        raise EOFError("unexpected end of controller input")
    if first.startswith("ENDGAME"):
        return False
    game_state.round_num = int(first.split()[1])

    head = controller.head
    head.dir = _DIRECTION_BY_VALUE[read().split()[1]]
    controller.length = int(read().split()[1])
    controller.unit_count = int(read().split()[1])
    num_sonar_msgs = int(read().split()[1])
    controller.sonar_messages = [int(read()) for _ in range(num_sonar_msgs)]

    # lazy parse vision
    # "x y hasPearl pearlIn" for each vision tile, row by row from the top left
    tile_lines = [read() for _ in range(Constants.VISION_SIZE ** 2)]
    # "team dragonId x y facing isHead" for each dragon part in vision
    num_dragon_parts = int(read().split()[1])
    body_lines = [read() for _ in range(num_dragon_parts)]
    # VISION_SIZE + 1 rows of horizontal edges, then VISION_SIZE rows of vertical edges
    edge_lines = [read() for _ in range(2 * Constants.VISION_SIZE + 1)]

    # middle tile is head
    x, y, _, _ = tile_lines[len(tile_lines) // 2].split()
    head.position = Position(int(x), int(y))
    controller.vision = Vision(tile_lines, body_lines, edge_lines, head, game_state)

    return True

def end_turn():
    print("ENDTURN", flush=True)
