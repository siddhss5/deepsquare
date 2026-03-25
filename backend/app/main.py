from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="DeepSquare")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class AnalyzeRequest(BaseModel):
    fen: str
    depth: int = 20


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
    # Dummy response — will be replaced with Stockfish + LLM in Phase 2/3
    return AnalyzeResponse(
        eval=0.3,
        top_lines=[
            EngineLine(moves="e4 e5 Nf3 Nc6", eval=0.3),
            EngineLine(moves="d4 d5 c4", eval=0.2),
        ],
        coaching="This is a dummy response. Stockfish and LLM integration coming soon.",
    )
