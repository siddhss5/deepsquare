import os
from collections.abc import Generator
from dataclasses import dataclass

import litellm
from dotenv import load_dotenv

load_dotenv()

SYSTEM_PROMPT = """\
You are DeepSquare, a friendly chess coach. The player already sees Stockfish's \
eval and top lines on screen — never repeat or list them.

Your job: explain the **why** behind the position in 3-4 sentences. Be concise.

- Why does one side stand better? (structure, activity, king safety, space)
- What's the plan? Give a clear strategic direction, not just "play Nf3."
- Any danger to watch for? Threats or traps the player might miss.

Style rules:
- Write clean, flowing prose. No bullet points, no numbered lists, no headers.
- Do not use contractions (write "you are" not "you're", "do not" not "don't").
- Speak directly: "you," "your opponent."
- Use standard chess vocabulary. Always name the opening or variation \
(e.g., Sicilian Najdorf, Queen's Gambit Declined, Italian Four Knights). \
Name tactical and strategic patterns by their proper terms: fork, pin, skewer, \
discovered attack, center fork trick, Greek gift sacrifice, back rank mate, \
outpost, fianchetto, pawn break, passed pawn, backward pawn, minority attack, \
etc. Players expect and learn from these terms.
- No "engine suggests" or "Stockfish recommends."
- Do not end with generic advice like "keep it simple" or "stay focused."

Formatting rules:
- Wrap each individual chess move in curly braces: {Nxe5}, {d4}, {O-O}. \
For sequences, wrap each move separately: {Nxe5} {Nxe5} {d4}. \
Do NOT put multiple moves inside one pair of braces.
- Wrap key strategic or tactical concepts in square brackets: [center fork trick], \
[pin on the f-file], [backward pawn on d6].
- Do NOT use markdown bold (**) or any other formatting.\
"""


@dataclass
class EngineInput:
    eval: float
    top_lines: list[dict]  # [{"moves": "e4 e5 ...", "eval": 0.3}, ...]


def _build_user_message(fen: str, engine: EngineInput, moves: list[str] | None = None) -> str:
    lines_text = "\n".join(
        f"  {i+1}. {line['moves']} (eval: {line['eval']:+.2f})"
        for i, line in enumerate(engine.top_lines)
    )
    parts = []
    if moves:
        # Format as "1.e4 e5 2.Nf3 Nc6 ..."
        move_strs = []
        for i, san in enumerate(moves):
            if i % 2 == 0:
                move_strs.append(f"{i // 2 + 1}.{san}")
            else:
                move_strs.append(san)
        parts.append(f"Game so far: {' '.join(move_strs)}")
    parts.append(f"Position (FEN): {fen}")
    parts.append(f"Eval: {engine.eval:+.2f} (from white's perspective)")
    parts.append(f"Top engine lines:\n{lines_text}")
    return "\n".join(parts)


def _resolve_model(model: str | None) -> str:
    """Resolve LLM model: request param > env var > default."""
    return model or os.environ.get("LLM_MODEL", "claude-haiku-4-5-20251001")


def _resolve_api_key(api_key: str | None) -> str | None:
    """Resolve API key: request param > env var."""
    return api_key or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("OPENAI_API_KEY")


def stream_coaching(
    fen: str,
    engine: EngineInput,
    moves: list[str] | None = None,
    api_key: str | None = None,
    model: str | None = None,
) -> Generator[str, None, None]:
    """Stream coaching response token by token."""
    resolved_model = _resolve_model(model)
    resolved_key = _resolve_api_key(api_key)

    if not resolved_key:
        raise ValueError("No API key provided. Set your key in Settings or in the server .env file.")

    response = litellm.completion(
        model=resolved_model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": _build_user_message(fen, engine, moves)},
        ],
        max_tokens=500,
        temperature=0.7,
        stream=True,
        api_key=resolved_key,
    )
    for chunk in response:
        delta = chunk.choices[0].delta.content
        if delta:
            yield delta
