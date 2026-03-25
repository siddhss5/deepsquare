import { useState, useRef, useEffect, useCallback } from 'react'
import { Chessground } from 'chessground'
import { Chess } from 'chess.js'
import type { Api } from 'chessground/api'
import type { Key } from 'chessground/types'
import 'chessground/assets/chessground.base.css'
import 'chessground/assets/chessground.brown.css'
import 'chessground/assets/chessground.cburnett.css'
import './App.css'

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

function toDests(chess: Chess): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>()
  for (const move of chess.moves({ verbose: true })) {
    const from = move.from as Key
    if (!dests.has(from)) dests.set(from, [])
    dests.get(from)!.push(move.to as Key)
  }
  return dests
}

function turnColor(chess: Chess): 'white' | 'black' {
  return chess.turn() === 'w' ? 'white' : 'black'
}

interface AnalysisResult {
  eval: number
  top_lines: { moves: string; eval: number }[]
  coaching: string
}

function App() {
  const boardRef = useRef<HTMLDivElement>(null)
  const cgRef = useRef<Api | null>(null)
  const chessRef = useRef(new Chess())
  const [fen, setFen] = useState(START_FEN)
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [loading, setLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const evalValue = analysis?.eval ?? 0
  const evalClamped = Math.max(-5, Math.min(5, evalValue))
  const whitePct = 50 + (evalClamped / 5) * 50

  const fetchAnalysis = useCallback(async (fenToAnalyze: string) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fen: fenToAnalyze }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: AnalysisResult = await res.json()
      setAnalysis(data)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      console.error('Analysis failed:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const updateAfterMove = useCallback((chess: Chess, lastMove?: [Key, Key]) => {
    const newFen = chess.fen()
    setFen(newFen)
    cgRef.current?.set({
      turnColor: turnColor(chess),
      check: chess.isCheck() ? turnColor(chess) : false,
      movable: {
        color: turnColor(chess),
        dests: toDests(chess),
      },
      lastMove,
    })
  }, [])

  const setPosition = useCallback((chess: Chess) => {
    const newFen = chess.fen()
    setFen(newFen)
    cgRef.current?.set({
      fen: newFen,
      turnColor: turnColor(chess),
      check: chess.isCheck() ? turnColor(chess) : false,
      movable: {
        color: turnColor(chess),
        dests: toDests(chess),
      },
      lastMove: undefined,
    })
  }, [])

  // Auto-analyze when FEN changes while in analyzing mode
  useEffect(() => {
    if (analyzing) {
      fetchAnalysis(fen)
    }
  }, [fen, analyzing, fetchAnalysis])

  useEffect(() => {
    if (!boardRef.current || cgRef.current) return
    const chess = chessRef.current
    cgRef.current = Chessground(boardRef.current, {
      fen: chess.fen(),
      orientation: 'white',
      highlight: { lastMove: true, check: true },
      animation: { enabled: true, duration: 200 },
      movable: {
        free: false,
        color: 'white',
        dests: toDests(chess),
        events: {
          after(orig, dest) {
            const chess = chessRef.current
            const move = chess.move({ from: orig, to: dest, promotion: 'q' })
            if (move) {
              updateAfterMove(chess, [orig, dest])
            }
          },
        },
      },
    })
  }, [updateAfterMove])

  const handleFenChange = (newFen: string) => {
    setFen(newFen)
    try {
      const chess = new Chess(newFen)
      chessRef.current = chess
      setPosition(chess)
    } catch {
      // invalid FEN — update text but don't sync board
    }
  }

  const handleToggleAnalysis = () => {
    if (analyzing) {
      abortRef.current?.abort()
      setAnalyzing(false)
      setLoading(false)
      setAnalysis(null)
    } else {
      setAnalyzing(true)
      // The useEffect on [fen, analyzing] will trigger the first analysis
    }
  }

  const handleReset = () => {
    const chess = new Chess()
    chessRef.current = chess
    setAnalysis(null)
    setPosition(chess)
    // If analyzing, the useEffect will auto-analyze the new position
  }

  const hasAnalysis = analysis !== null

  return (
    <div className="app">
      <header>
        <h1>DeepSquare</h1>
      </header>

      <main>
        <div className="board-column">
          <div className="board-wrapper">
            <div
              className={`eval-bar ${hasAnalysis ? 'has-data' : ''}`}
              style={{ '--white-pct': `${whitePct}%` } as React.CSSProperties}
            >
              <div className="eval-bar-fill" />
              {hasAnalysis && (
                <span className="eval-bar-label">
                  {evalValue > 0 ? '+' : ''}{evalValue.toFixed(1)}
                </span>
              )}
            </div>
            <div ref={boardRef} className="board" />
          </div>
          <div className="board-controls">
            <button onClick={handleReset}>Reset</button>
            <button
              className={analyzing ? 'btn-stop' : 'btn-analyze'}
              onClick={handleToggleAnalysis}
            >
              {analyzing ? 'Stop' : 'Analyze'}
            </button>
          </div>
        </div>

        <div className="side-panel">
          <section className="coaching-section">
            <h3>Coach</h3>
            <div className="coaching-body">
              {hasAnalysis ? (
                <p className={loading ? 'is-stale' : ''}>{analysis.coaching}</p>
              ) : (
                <p className="placeholder">
                  {loading
                    ? 'Thinking...'
                    : 'Click Analyze to start engine analysis.'}
                </p>
              )}
            </div>
          </section>

          <section className="engine-section">
            <h3>Engine lines {loading && <span className="loading-dot" />}</h3>
            <div className="engine-body">
              {hasAnalysis ? (
                analysis.top_lines.map((line, i) => (
                  <div key={i} className={`line ${loading ? 'is-stale' : ''}`}>
                    <span className="line-eval">
                      {line.eval > 0 ? '+' : ''}{line.eval}
                    </span>
                    <span className="line-moves">{line.moves}</span>
                  </div>
                ))
              ) : (
                <div className="line placeholder">
                  <span className="line-eval">—</span>
                  <span className="line-moves">No analysis yet</span>
                </div>
              )}
            </div>
          </section>

          <section className="fen-section">
            <label className="fen-label">
              FEN
              <input
                type="text"
                value={fen}
                onChange={(e) => handleFenChange(e.target.value)}
                spellCheck={false}
              />
            </label>
          </section>
        </div>
      </main>
    </div>
  )
}

export default App
