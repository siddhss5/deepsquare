from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app import engine


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
    time_limit: float = 1.0  # seconds for Stockfish to think
    num_lines: int = 3


class EngineLine(BaseModel):
    moves: str
    eval: float


class AnalyzeResponse(BaseModel):
    eval: float
    top_lines: list[EngineLine]
    coaching: str


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest):
    result = engine.analyze(req.fen, time_limit=req.time_limit, num_lines=req.num_lines)
    return AnalyzeResponse(
        eval=result.eval,
        top_lines=[EngineLine(moves=l.moves, eval=l.eval) for l in result.top_lines],
        coaching="Stockfish analysis complete. LLM coaching coming in Phase 3.",
    )
