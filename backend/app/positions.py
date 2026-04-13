import json
from dataclasses import dataclass
from pathlib import Path

import chess
import httpx

_DB: list[dict] = []
_POSITIONS_FILE = Path(__file__).parent / "positions.json"

# Lichess puzzle themes we support
PUZZLE_THEMES = {
    "fork", "pin", "skewer", "discoveredAttack", "backRankMate",
    "smotheredMate", "deflection", "decoy", "sacrifice", "overloading",
    "interference", "xRayAttack", "attraction", "clearance",
    "doubleCheck", "zugzwang", "quietMove", "mate", "mateIn1",
    "mateIn2", "mateIn3",
}


@dataclass
class PositionResult:
    name: str
    description: str
    fen: str
    source: str  # "curated" or "lichess-puzzle"


def _load_db() -> list[dict]:
    global _DB
    if not _DB:
        with open(_POSITIONS_FILE) as f:
            _DB = json.load(f)
    return _DB


def _score_match(entry: dict, query: str) -> int:
    """Score how well an entry matches the query. Higher is better."""
    q = query.lower()
    words = [w for w in q.split() if len(w) > 2]  # skip short words like "a", "vs"
    if not words:
        return 0

    name_lower = entry["name"].lower()
    tags = [t.lower() for t in entry.get("tags", [])]
    tags_str = " ".join(tags)
    desc_lower = entry.get("description", "").lower()

    score = 0

    # Full query match in name
    if q in name_lower:
        score += 100

    # Full tag match (e.g., "rook endgame" matches tag "rook endgame")
    for tag in tags:
        if tag in q or q in tag:
            score += 30

    # Word matches — count how many query words match
    name_hits = sum(1 for w in words if w in name_lower)
    tag_hits = sum(1 for w in words if w in tags_str)
    desc_hits = sum(1 for w in words if w in desc_lower)

    # Reward proportional matching — more matched words = much higher score
    match_ratio = (name_hits + tag_hits) / len(words) if words else 0
    score += int(name_hits * 15 * match_ratio)
    score += int(tag_hits * 8 * match_ratio)
    score += desc_hits * 2

    return score


def search_curated(query: str, limit: int = 3) -> list[PositionResult]:
    """Search the curated position database."""
    db = _load_db()
    scored = [(entry, _score_match(entry, query)) for entry in db]
    scored = [(e, s) for e, s in scored if s >= 10]
    scored.sort(key=lambda x: x[1], reverse=True)

    return [
        PositionResult(
            name=e["name"],
            description=e["description"],
            fen=e["fen"],
            source="curated",
        )
        for e, _ in scored[:limit]
    ]


def _map_query_to_theme(query: str) -> str | None:
    """Try to map a natural language query to a Lichess puzzle theme."""
    q = query.lower()
    mappings = {
        "fork": "fork",
        "pin": "pin",
        "skewer": "skewer",
        "discovered attack": "discoveredAttack",
        "discovered check": "discoveredAttack",
        "back rank": "backRankMate",
        "back-rank": "backRankMate",
        "smothered mate": "smotheredMate",
        "sacrifice": "sacrifice",
        "deflection": "deflection",
        "decoy": "decoy",
        "mate in 1": "mateIn1",
        "mate in 2": "mateIn2",
        "mate in 3": "mateIn3",
        "checkmate": "mate",
        "zugzwang": "zugzwang",
        "double check": "doubleCheck",
    }
    for phrase, theme in mappings.items():
        if phrase in q:
            return theme
    return None


async def search_lichess_puzzle(query: str) -> PositionResult | None:
    """Search Lichess for a puzzle matching the query theme."""
    theme = _map_query_to_theme(query)
    if not theme:
        return None

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                "https://lichess.org/api/puzzle/next",
                params={"themes": theme},
                headers={"Accept": "application/json"},
            )
            resp.raise_for_status()
            data = resp.json()

            puzzle = data.get("puzzle", {})
            game = data.get("game", {})
            pgn = game.get("pgn", "")
            solution = puzzle.get("solution", [])
            themes = puzzle.get("themes", [])

            if not pgn:
                return None

            # Replay PGN to get the puzzle starting position
            board = chess.Board()
            for san in pgn.split():
                try:
                    board.push_san(san)
                except Exception:
                    break

            theme_names = ", ".join(t for t in themes if t != "short" and t != "long")
            return PositionResult(
                name=f"Puzzle ({theme_names})",
                description=f"Find the best move. Solution starts with {solution[0] if solution else '?'}",
                fen=board.fen(),
                source="lichess-puzzle",
            )
    except Exception:
        return None


PIECE_MAP = {
    "K": chess.KING, "Q": chess.QUEEN, "R": chess.ROOK,
    "B": chess.BISHOP, "N": chess.KNIGHT, "P": chess.PAWN,
}

COLOR_MAP = {"white": chess.WHITE, "black": chess.BLACK}


def validate_and_convert_setup(data: dict) -> tuple[str | None, str | None]:
    """Validate a structured piece list and convert to FEN.
    Returns (fen, None) on success or (None, error_message) on failure."""
    pieces = data.get("pieces", [])
    side_to_move = data.get("side_to_move", "white").lower()

    if side_to_move not in COLOR_MAP:
        return None, f"Invalid side_to_move: {side_to_move}"

    # Validate pieces
    seen_squares: dict[str, dict] = {}
    kings = {"white": 0, "black": 0}
    pawns = {"white": 0, "black": 0}
    king_squares: dict[str, int] = {}

    for piece in pieces:
        color = piece.get("color", "").lower()
        ptype = piece.get("type", "").upper()
        square = piece.get("square", "").lower()

        if color not in COLOR_MAP:
            return None, f"Invalid color: {color}"
        if ptype not in PIECE_MAP:
            return None, f"Invalid piece type: {ptype}"
        if len(square) != 2 or square[0] not in "abcdefgh" or square[1] not in "12345678":
            return None, f"Invalid square: {square}"

        sq_index = chess.parse_square(square)

        # Duplicate square — keep the last one (auto-fix)
        if square in seen_squares:
            pass  # will be overwritten
        seen_squares[square] = piece

        if ptype == "K":
            kings[color] += 1
            king_squares[color] = sq_index
        if ptype == "P":
            pawns[color] += 1
            rank = int(square[1])
            if rank == 1 or rank == 8:
                return None, f"Pawn on invalid rank: {square}"

    # Must have exactly one king per side
    for c in ("white", "black"):
        if kings[c] != 1:
            return None, f"{c} must have exactly 1 king (found {kings[c]})"

    # Kings cannot be adjacent
    wk = king_squares.get("white")
    bk = king_squares.get("black")
    if wk is not None and bk is not None:
        if chess.square_distance(wk, bk) <= 1:
            return None, "Kings cannot be adjacent"

    # Max 8 pawns per side
    for c in ("white", "black"):
        if pawns[c] > 8:
            return None, f"{c} has too many pawns ({pawns[c]})"

    # Build the board
    board = chess.Board.empty()
    board.turn = COLOR_MAP[side_to_move]

    for square, piece in seen_squares.items():
        color = COLOR_MAP[piece["color"].lower()]
        ptype = PIECE_MAP[piece["type"].upper()]
        sq_index = chess.parse_square(square)
        board.set_piece_at(sq_index, chess.Piece(ptype, color))

    # Check if the side NOT to move is in check (illegal)
    board.turn = not board.turn  # temporarily switch
    if board.is_check():
        board.turn = not board.turn
        return None, "The side not to move is in check (illegal position)"
    board.turn = not board.turn

    return board.fen(), None


async def search(query: str) -> list[PositionResult]:
    """Search all sources for positions matching the query."""
    results = search_curated(query)

    # If curated results are weak, try Lichess puzzles
    if not results or all(True for r in results if "tactic" in query.lower() or "puzzle" in query.lower()):
        puzzle = await search_lichess_puzzle(query)
        if puzzle:
            results.insert(0, puzzle)

    # Also try Lichess if query mentions puzzle-like terms
    if _map_query_to_theme(query) and not any(r.source == "lichess-puzzle" for r in results):
        puzzle = await search_lichess_puzzle(query)
        if puzzle:
            results.insert(0, puzzle)

    return results[:3]
