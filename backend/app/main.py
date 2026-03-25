from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
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
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


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


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest):
    result = engine.analyze(req.fen, time_limit=req.time_limit, num_lines=req.num_lines)
    return AnalyzeResponse(
        eval=result.eval,
        top_lines=[EngineLine(moves=l.moves, eval=l.eval) for l in result.top_lines],
    )


class CoachRequest(BaseModel):
    fen: str
    engine_eval: float
    top_lines: list[EngineLine]


@app.post("/coach")
async def coach(req: CoachRequest):
    """SSE endpoint: accepts engine data from frontend, streams coaching tokens."""
    engine_input = EngineInput(
        eval=req.engine_eval,
        top_lines=[{"moves": l.moves, "eval": l.eval} for l in req.top_lines],
    )

    def event_generator():
        for token in stream_coaching(req.fen, engine_input):
            yield {"event": "coaching", "data": token}
        yield {"event": "done", "data": ""}

    return EventSourceResponse(event_generator())
