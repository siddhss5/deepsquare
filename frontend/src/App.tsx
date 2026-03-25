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

function cleanCoaching(raw: string): string {
  let text = raw
  // Fix tokenizer splitting contractions: "You 're" → "You're"
  text = text.replace(/ '/g, "'")
  // Fix spaces before punctuation: "coordination ." → "coordination."
  text = text.replace(/ ([.,;:!?])/g, '$1')
  // Clean {move notation}: strip all spaces inside (single move per brace pair)
  text = text.replace(/\{([^}]*)\}/g, (_, inner: string) => {
    const clean = inner.replace(/\s+/g, '')
    return `<code class="move">${clean}</code>`
  })
  // Strip spaces inside [concept] and render as <strong>
  text = text.replace(/\[([^\]]*)\]/g, (_, inner) => {
    const clean = inner.replace(/\s+/g, ' ').trim()
    return `<strong>${clean}</strong>`
  })
  // Clean up stray ** in case LLM still uses them
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/\*\*/g, '')
  return text
}

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

interface EngineData {
  eval: number
  top_lines: { moves: string; eval: number }[]
}

function App() {
  const boardRef = useRef<HTMLDivElement>(null)
  const cgRef = useRef<Api | null>(null)
  const chessRef = useRef(new Chess())
  const [fen, setFen] = useState(START_FEN)
  const [engineData, setEngineData] = useState<EngineData | null>(null)
  const [coaching, setCoaching] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [engineLoading, setEngineLoading] = useState(false)
  const [coachLoading, setCoachLoading] = useState(false)
  const engineAbortRef = useRef<AbortController | null>(null)
  const coachAbortRef = useRef<AbortController | null>(null)

  const evalValue = engineData?.eval ?? 0
  const evalClamped = Math.max(-5, Math.min(5, evalValue))
  const whitePct = 50 + (evalClamped / 5) * 50

  // Engine-only fetch (fast, runs on every move)
  const fetchEngine = useCallback(async (fenToAnalyze: string) => {
    engineAbortRef.current?.abort()
    const controller = new AbortController()
    engineAbortRef.current = controller
    setEngineLoading(true)
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fen: fenToAnalyze }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: EngineData = await res.json()
      setEngineData(data)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      console.error('Engine analysis failed:', err)
    } finally {
      setEngineLoading(false)
    }
  }, [])

  // Coaching fetch (streams LLM response, on-demand only)
  const fetchCoaching = useCallback(async (fenToCoach: string, engine: EngineData) => {
    coachAbortRef.current?.abort()
    const controller = new AbortController()
    coachAbortRef.current = controller
    setCoachLoading(true)
    setCoaching('')

    try {
      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fen: fenToCoach,
          engine_eval: engine.eval,
          top_lines: engine.top_lines,
        }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const reader = res.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let buffer = ''
      let coachingText = ''
      let currentEvent = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            // SSE spec: "data:" or "data: " — strip the field name and optional space
            const data = line.startsWith('data: ') ? line.slice(6) : line.slice(5)
            if (currentEvent === 'coaching') {
              coachingText += data
              setCoaching(coachingText)
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      console.error('Coaching failed:', err)
    } finally {
      setCoachLoading(false)
    }
  }, [])

  const updateAfterMove = useCallback((chess: Chess, lastMove?: [Key, Key]) => {
    setFen(chess.fen())
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
    setFen(chess.fen())
    cgRef.current?.set({
      fen: chess.fen(),
      turnColor: turnColor(chess),
      check: chess.isCheck() ? turnColor(chess) : false,
      movable: {
        color: turnColor(chess),
        dests: toDests(chess),
      },
      lastMove: undefined,
    })
  }, [])

  // Auto-run engine when FEN changes while analyzing
  useEffect(() => {
    if (analyzing) {
      fetchEngine(fen)
    }
  }, [fen, analyzing, fetchEngine])

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
      // invalid FEN
    }
  }

  const handleToggleAnalysis = () => {
    if (analyzing) {
      engineAbortRef.current?.abort()
      coachAbortRef.current?.abort()
      setAnalyzing(false)
      setEngineLoading(false)
      setCoachLoading(false)
      setEngineData(null)
      setCoaching('')
    } else {
      setAnalyzing(true)
    }
  }

  const handleCoachMe = () => {
    if (engineData) fetchCoaching(fen, engineData)
  }

  const handleReset = () => {
    const chess = new Chess()
    chessRef.current = chess
    setEngineData(null)
    setCoaching('')
    setPosition(chess)
  }

  const hasEngine = engineData !== null

  return (
    <div className="app">
      <header>
        <h1>DeepSquare</h1>
      </header>

      <main>
        <div className="board-column">
          <div className="board-wrapper">
            <div
              className={`eval-bar ${hasEngine ? 'has-data' : ''}`}
              style={{ '--white-pct': `${whitePct}%` } as React.CSSProperties}
            >
              <div className="eval-bar-fill" />
              {hasEngine && (
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
            <div className="coaching-header">
              <h3>Coach {coachLoading && <span className="loading-dot" />}</h3>
              {analyzing && (
                <button
                  className="btn-coach"
                  onClick={handleCoachMe}
                  disabled={coachLoading}
                >
                  {coachLoading ? 'Thinking...' : 'Coach me'}
                </button>
              )}
            </div>
            <div className="coaching-body">
              {coaching ? (
                <p dangerouslySetInnerHTML={{
                  __html: cleanCoaching(coaching)
                }} />
              ) : (
                <p className="placeholder">
                  {analyzing
                    ? 'Click "Coach me" for position advice.'
                    : 'Click Analyze to start engine analysis.'}
                </p>
              )}
            </div>
          </section>

          <section className="engine-section">
            <h3>Engine lines {engineLoading && <span className="loading-dot" />}</h3>
            <div className="engine-body">
              {hasEngine ? (
                engineData.top_lines.map((line, i) => (
                  <div key={i} className={`line ${engineLoading ? 'is-stale' : ''}`}>
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
