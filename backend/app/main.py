from contextlib import asynccontextmanager

import chess
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from app import engine
from app.coach import EngineInput, stream_coaching


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


class CoachRequest(BaseModel):
    fen: str
    engine_eval: float
    top_lines: list[EngineLine]
    moves: list[str] = []  # SAN move history leading to this position


# ── Endpoints ──

@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest):
    try:
        chess.Board(req.fen)  # validate FEN
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


@app.post("/coach")
async def coach(req: CoachRequest, request: Request):
    """SSE endpoint: accepts engine data + API key from frontend, streams coaching."""
    api_key = request.headers.get("x-api-key")
    model = request.headers.get("x-llm-model")

    engine_input = EngineInput(
        eval=req.engine_eval,
        top_lines=[{"moves": l.moves, "eval": l.eval} for l in req.top_lines],
    )

    def event_generator():
        try:
            for token in stream_coaching(req.fen, engine_input, moves=req.moves, api_key=api_key, model=model):
                yield {"event": "coaching", "data": token}
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
                yield {"event": "error", "data": f"Coaching error: {msg}"}

    return EventSourceResponse(event_generator())
