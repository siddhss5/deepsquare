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


def _build_user_message(fen: str, engine: EngineInput) -> str:
    lines_text = "\n".join(
        f"  {i+1}. {line['moves']} (eval: {line['eval']:+.2f})"
        for i, line in enumerate(engine.top_lines)
    )
    return (
        f"Position (FEN): {fen}\n"
        f"Eval: {engine.eval:+.2f} (from white's perspective)\n"
        f"Top engine lines:\n{lines_text}"
    )


def stream_coaching(fen: str, engine: EngineInput) -> Generator[str, None, None]:
    """Stream coaching response token by token."""
    model = os.environ.get("LLM_MODEL", "claude-haiku-4-5-20251001")
    response = litellm.completion(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": _build_user_message(fen, engine)},
        ],
        max_tokens=500,
        temperature=0.7,
        stream=True,
    )
    for chunk in response:
        delta = chunk.choices[0].delta.content
        if delta:
            yield delta
