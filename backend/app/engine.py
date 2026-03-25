import os
from dataclasses import dataclass

import chess
import chess.engine


@dataclass
class Line:
    moves: str  # SAN notation, space-separated
    eval: float  # pawns, from white's perspective


@dataclass
class AnalysisResult:
    eval: float  # top line eval
    top_lines: list[Line]


_engine: chess.engine.SimpleEngine | None = None


def start(path: str | None = None) -> None:
    global _engine
    if _engine is not None:
        return
    path = path or os.environ.get("STOCKFISH_PATH", "/opt/homebrew/bin/stockfish")
    _engine = chess.engine.SimpleEngine.popen_uci(path)


def stop() -> None:
    global _engine
    if _engine is not None:
        _engine.quit()
        _engine = None


def analyze(fen: str, time_limit: float = 1.0, num_lines: int = 3) -> AnalysisResult:
    if _engine is None:
        raise RuntimeError("Engine not started — call engine.start() first")

    board = chess.Board(fen)
    infos = _engine.analyse(board, chess.engine.Limit(time=time_limit), multipv=num_lines)

    lines: list[Line] = []
    for info in infos:
        score = info["score"].white()
        cp = score.score(mate_score=10000)
        eval_pawns = cp / 100.0 if cp is not None else 0.0

        pv = info.get("pv", [])
        # Convert move list to SAN by replaying on a copy of the board
        san_moves: list[str] = []
        replay = board.copy()
        for move in pv[:8]:  # limit to 8 half-moves for display
            san_moves.append(replay.san(move))
            replay.push(move)

        lines.append(Line(moves=" ".join(san_moves), eval=round(eval_pawns, 2)))

    top_eval = lines[0].eval if lines else 0.0
    return AnalysisResult(eval=top_eval, top_lines=lines)
