from contextlib import asynccontextmanager

import chess
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from app import engine, positions
from app.coach import ChatMessage, EngineInput, stream_chat


@asynccontextmanager
async def lifespan(app: FastAPI):
    engine.start()
    yield
    engine.stop()


app = FastAPI(title="DeepSquare", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request/Response models ──

class AnalyzeRequest(BaseModel):
    fen: str
    time_limit: float = 1.0
    num_lines: int = 3


class EngineLine(BaseModel):
    moves: str
    eval: float


class AnalyzeResponse(BaseModel):
    eval: float
    top_lines: list[EngineLine]


class ChatMessageIn(BaseModel):
    role: str
    text: str


class ChatRequest(BaseModel):
    messages: list[ChatMessageIn]
    fen: str
    moves: list[str] = []
    engine_eval: float | None = None
    top_lines: list[EngineLine] | None = None


# ── Endpoints ──

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/positions/search")
async def search_positions(q: str):
    """Search for chess positions by query."""
    results = await positions.search(q)
    return [
        {"name": r.name, "description": r.description, "fen": r.fen, "source": r.source}
        for r in results
    ]


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest):
    try:
        chess.Board(req.fen)
    except ValueError:
        return JSONResponse(status_code=422, content={"error": "Invalid FEN string."})

    try:
        result = engine.analyze(req.fen, time_limit=req.time_limit, num_lines=req.num_lines)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Engine error: {e}"})

    return AnalyzeResponse(
        eval=result.eval,
        top_lines=[EngineLine(moves=l.moves, eval=l.eval) for l in result.top_lines],
    )


@app.post("/chat")
async def chat(req: ChatRequest, request: Request):
    """SSE endpoint: conversational coach with board control."""
    api_key = request.headers.get("x-api-key")
    model = request.headers.get("x-llm-model")

    engine_input = None
    if req.engine_eval is not None and req.top_lines is not None:
        engine_input = EngineInput(
            eval=req.engine_eval,
            top_lines=[{"moves": l.moves, "eval": l.eval} for l in req.top_lines],
        )

    messages = [ChatMessage(role=m.role, text=m.text) for m in req.messages]

    def event_generator():
        try:
            for token in stream_chat(
                messages=messages,
                fen=req.fen,
                moves=req.moves,
                engine=engine_input,
                api_key=api_key,
                model=model,
            ):
                yield {"event": "token", "data": token}
            yield {"event": "done", "data": ""}
        except ValueError as e:
            yield {"event": "error", "data": str(e)}
        except Exception as e:
            msg = str(e)
            if "authentication" in msg.lower() or "api key" in msg.lower() or "invalid" in msg.lower():
                yield {"event": "error", "data": "Invalid API key. Check your key in Settings."}
            elif "rate" in msg.lower() or "limit" in msg.lower():
                yield {"event": "error", "data": "Rate limited. Please wait a moment and try again."}
            elif "balance" in msg.lower() or "credit" in msg.lower():
                yield {"event": "error", "data": "Insufficient API credits. Add credits to your account."}
            else:
                yield {"event": "error", "data": f"Chat error: {msg}"}

    return EventSourceResponse(event_generator())
