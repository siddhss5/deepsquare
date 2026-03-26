import json
from dataclasses import dataclass
from pathlib import Path

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
    words = q.split()
    score = 0

    name_lower = entry["name"].lower()
    tags_lower = " ".join(entry.get("tags", [])).lower()
    desc_lower = entry.get("description", "").lower()

    # Exact name match
    if q in name_lower:
        score += 100
    # Word matches in name (highest weight)
    for w in words:
        if w in name_lower:
            score += 20
        if w in tags_lower:
            score += 10
        if w in desc_lower:
            score += 3

    return score


def search_curated(query: str, limit: int = 3) -> list[PositionResult]:
    """Search the curated position database."""
    db = _load_db()
    scored = [(entry, _score_match(entry, query)) for entry in db]
    scored = [(e, s) for e, s in scored if s > 0]
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
            import chess
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
