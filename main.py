import helper as unswbc

ct: unswbc.Controller
game: unswbc.Game

def execute_turn() -> None:
    ct.make_move(unswbc.Direction.WEST)
    ct.send_sonar(0)

def main() -> None:
    global ct, game
    ct, game = unswbc.init()
    while unswbc.update(ct, game):
        execute_turn()
        unswbc.end_turn()

main()
