import os
from collections.abc import Generator
from dataclasses import dataclass

import litellm
from dotenv import load_dotenv

load_dotenv()

SYSTEM_PROMPT = """\
You are DeepSquare, a friendly chess coach. You have an interactive board that \
the player is looking at alongside this conversation.

Your role:
- Answer questions about the current position
- Explain strategic and tactical ideas
- Set up positions when the player asks to study something specific
- Coach through endgames, openings, or tactical exercises

Guidelines:
- Do not use contractions (write "you are" not "you're", "do not" not "don't").
- Speak directly: "you," "your opponent."
- Use standard chess vocabulary. Always name the opening or variation \
(e.g., Sicilian Najdorf, Queen's Gambit Declined, Italian Four Knights). \
Name tactical and strategic patterns by their proper terms: fork, pin, skewer, \
discovered attack, center fork trick, Greek gift sacrifice, back rank mate, \
outpost, fianchetto, pawn break, passed pawn, backward pawn, minority attack, etc.
- Keep responses concise (3-6 sentences unless the player asks for more detail).
- No "engine suggests" or "Stockfish recommends."
- Do not end with generic advice like "keep it simple" or "stay focused."

Formatting:
- Wrap each individual chess move in curly braces: {Nxe5}, {d4}, {O-O}. \
For sequences, wrap each move separately: {Nxe5} {Nxe5} {d4}. \
Do NOT put multiple moves inside one pair of braces.
- Wrap key strategic or tactical concepts in square brackets: [center fork trick], \
[pin on the f-file], [backward pawn on d6].
- Do NOT use markdown bold (**) or any other formatting.

Position requests:
You have TWO ways to set up positions on the board. Use the first whenever possible.

**Option 1: Search the database (preferred for known positions)**
For well-known openings, endgames, puzzles, or famous games, use a search marker:
[POSITION: lucena rook endgame]
[POSITION: caro-kann advance variation]
[POSITION: fork puzzle]
Available: openings (sicilian, caro-kann, french, ruy lopez, italian, london, \
kings indian, queens gambit, etc.), endgames (lucena, philidor, vancura, \
king and pawn, bishop and knight mate, etc.), tactics/puzzles (fork, pin, \
skewer, back rank mate, smothered mate, etc.), famous games (morphy opera game, \
kasparov topalov, fischer byrne, evergreen, etc.).

**Option 2: Build a custom position (ONLY if Option 1 cannot work)**
For truly custom positions that could not possibly be in any database, output a JSON piece list:
[SETUP: {"side_to_move": "white", "pieces": [{"color": "white", "type": "K", "square": "e1"}, {"color": "black", "type": "K", "square": "e8"}, {"color": "white", "type": "R", "square": "a1"}]}]
Rules for SETUP:
- type must be one of: K, Q, R, B, N, P
- square must be like "e4" (file a-h, rank 1-8)
- Each side MUST have exactly one King
- No pawns on ranks 1 or 8
- Kings cannot be on adjacent squares
- List EVERY piece on the board — empty squares are implied

For BOTH options: write the marker on the LAST line. Describe the position first.\
"""


@dataclass
class EngineInput:
    eval: float
    top_lines: list[dict]


@dataclass
class ChatMessage:
    role: str  # "user" or "assistant"
    text: str


def _build_context(fen: str, moves: list[str] | None, engine: EngineInput | None) -> str:
    """Build the current board context injected into each request."""
    parts = []
    if moves:
        move_strs = []
        for i, san in enumerate(moves):
            if i % 2 == 0:
                move_strs.append(f"{i // 2 + 1}.{san}")
            else:
                move_strs.append(san)
        parts.append(f"Game so far: {' '.join(move_strs)}")
    parts.append(f"Current position (FEN): {fen}")
    if engine:
        lines_text = "\n".join(
            f"  {i+1}. {line['moves']} (eval: {line['eval']:+.2f})"
            for i, line in enumerate(engine.top_lines)
        )
        parts.append(f"Eval: {engine.eval:+.2f} (from white's perspective)")
        parts.append(f"Top engine lines:\n{lines_text}")
    return "\n".join(parts)


def _resolve_model(model: str | None) -> str:
    return model or os.environ.get("LLM_MODEL", "claude-haiku-4-5-20251001")


def _resolve_api_key(api_key: str | None) -> str | None:
    return api_key or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("OPENAI_API_KEY")


def stream_chat(
    messages: list[ChatMessage],
    fen: str,
    moves: list[str] | None = None,
    engine: EngineInput | None = None,
    api_key: str | None = None,
    model: str | None = None,
) -> Generator[str, None, None]:
    """Stream a chat response token by token."""
    resolved_model = _resolve_model(model)
    resolved_key = _resolve_api_key(api_key)

    if not resolved_key:
        raise ValueError("No API key provided. Set your key in Settings or in the server .env file.")

    # Build messages for litellm
    context = _build_context(fen, moves, engine)
    system_msg = SYSTEM_PROMPT + f"\n\n--- Current Board State ---\n{context}"

    llm_messages = [{"role": "system", "content": system_msg}]
    for msg in messages:
        llm_messages.append({"role": msg.role, "content": msg.text})

    response = litellm.completion(
        model=resolved_model,
        messages=llm_messages,
        max_tokens=500,
        temperature=0.7,
        stream=True,
        api_key=resolved_key,
    )
    for chunk in response:
        delta = chunk.choices[0].delta.content
        if delta:
            yield delta
