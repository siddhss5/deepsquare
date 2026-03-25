import { useState, useRef, useEffect, useCallback } from 'react'
import { Chessground } from 'chessground'
import { Chess } from 'chess.js'
import type { Api } from 'chessground/api'
import type { Key } from 'chessground/types'
import { Settings, loadSettings, type LLMSettings } from './Settings'
import 'chessground/assets/chessground.base.css'
import 'chessground/assets/chessground.brown.css'
import 'chessground/assets/chessground.cburnett.css'
import './App.css'

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

// ── Helpers ──

// Chess move pattern: standard algebraic notation
// Matches: e4, Nf3, Bxe5, O-O, O-O-O, Qxf7+, Rh8#, exd5, Nbd2, R1e1
const MOVE_RE = /(?<![a-zA-Z])([KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|[a-h]x[a-h][1-8](?:=[QRBN])?[+#]?|[a-h][1-8][+#]?|O-O(?:-O)?[+#]?)(?![a-zA-Z])/g

function cleanCoaching(raw: string): string {
  let text = raw
  // Fix tokenizer splitting contractions: "You 're" → "You're"
  text = text.replace(/ '/g, "'")
  // Fix spaces before punctuation: "coordination ." → "coordination."
  text = text.replace(/ ([.,;:!?])/g, '$1')

  // Process explicit {move} markers: strip spaces inside
  text = text.replace(/\{([^}]*)\}/g, (_, inner: string) => {
    const clean = inner.replace(/\s+/g, '')
    return `<code class="move">${clean}</code>`
  })
  // Process [concept] markers
  text = text.replace(/\[([^\]]*)\]/g, (_, inner) => {
    const clean = inner.replace(/\s+/g, ' ').trim()
    return `<strong>${clean}</strong>`
  })
  // Clean up stray **
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/\*\*/g, '')

  // Auto-detect unwrapped chess moves — run on the current text
  // but skip content already inside <code> tags.
  // Split by <code>...</code> segments, only process outside segments.
  const parts = text.split(/(<code class="move">.*?<\/code>)/g)
  text = parts.map(part => {
    if (part.startsWith('<code class="move">')) return part
    return part.replace(MOVE_RE, (match) => `<code class="move">${match}</code>`)
  }).join('')

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

// ── Types ──

interface EngineData {
  eval: number
  top_lines: { moves: string; eval: number }[]
}

interface HistoryEntry {
  fen: string
  lastMove?: [Key, Key]
  san?: string
}

// ── Components ──

function MoveList({ history, currentIndex, onJump }: {
  history: HistoryEntry[]
  currentIndex: number
  onJump: (index: number) => void
}) {
  const moves = history.slice(1) // skip starting position
  if (moves.length === 0) return null

  const pairs: { num: number; white: { san: string; idx: number }; black?: { san: string; idx: number } }[] = []
  for (let i = 0; i < moves.length; i += 2) {
    pairs.push({
      num: Math.floor(i / 2) + 1,
      white: { san: moves[i].san ?? '?', idx: i + 1 },
      black: moves[i + 1] ? { san: moves[i + 1].san ?? '?', idx: i + 2 } : undefined,
    })
  }

  return (
    <section className="moves-section">
      <h3>Moves</h3>
      <div className="move-list">
        {pairs.map(p => (
          <span key={p.num} className="move-pair">
            <span className="move-num">{p.num}.</span>
            <span
              className={`move-san ${p.white.idx === currentIndex ? 'active' : ''}`}
              onClick={() => onJump(p.white.idx)}
            >{p.white.san}</span>
            {p.black != null && (
              <span
                className={`move-san ${p.black.idx === currentIndex ? 'active' : ''}`}
                onClick={() => onJump(p.black!.idx)}
              >{p.black.san}</span>
            )}
          </span>
        ))}
      </div>
    </section>
  )
}

// ── App ──

function App() {
  const boardRef = useRef<HTMLDivElement>(null)
  const cgRef = useRef<Api | null>(null)
  const chessRef = useRef(new Chess())

  // History
  const [history, setHistory] = useState<HistoryEntry[]>([{ fen: START_FEN }])
  const [currentIndex, setCurrentIndex] = useState(0)

  // Derived FEN from history
  const currentFen = history[currentIndex].fen
  const atLatest = currentIndex === history.length - 1

  // Settings
  const [settings, setSettings] = useState<LLMSettings>(loadSettings)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Engine / coaching
  const [engineData, setEngineData] = useState<EngineData | null>(null)
  const [coaching, setCoaching] = useState('')
  const [engineError, setEngineError] = useState('')
  const [coachError, setCoachError] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [engineLoading, setEngineLoading] = useState(false)
  const [coachLoading, setCoachLoading] = useState(false)
  const engineAbortRef = useRef<AbortController | null>(null)
  const coachAbortRef = useRef<AbortController | null>(null)

  const evalValue = engineData?.eval ?? 0
  const evalClamped = Math.max(-5, Math.min(5, evalValue))
  const whitePct = 50 + (evalClamped / 5) * 50

  // ── Board sync ──

  const showPosition = useCallback((entry: HistoryEntry, allowMoves: boolean) => {
    const chess = new Chess(entry.fen)
    chessRef.current = chess
    cgRef.current?.set({
      fen: entry.fen,
      turnColor: turnColor(chess),
      check: chess.isCheck() ? turnColor(chess) : false,
      lastMove: entry.lastMove,
      movable: allowMoves ? {
        color: turnColor(chess),
        dests: toDests(chess),
      } : {
        color: undefined,
        dests: undefined,
      },
    })
  }, [])

  // ── Fetchers ──

  const fetchEngine = useCallback(async (fen: string) => {
    engineAbortRef.current?.abort()
    const controller = new AbortController()
    engineAbortRef.current = controller
    setEngineLoading(true)
    setEngineError('')
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fen }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `Engine returned HTTP ${res.status}`)
      }
      const data: EngineData = await res.json()
      setEngineData(data)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setEngineError(err instanceof Error ? err.message : 'Engine analysis failed.')
    } finally {
      setEngineLoading(false)
    }
  }, [])

  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const fetchCoaching = useCallback(async (fen: string, engine: EngineData, moves: string[] = []) => {
    const s = settingsRef.current
    if (!s.apiKey) {
      setCoachError('Set your API key in Settings to use the coach.')
      return
    }
    coachAbortRef.current?.abort()
    const controller = new AbortController()
    coachAbortRef.current = controller
    setCoachLoading(true)
    setCoaching('')
    setCoachError('')
    try {
      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': s.apiKey,
          'X-LLM-Model': s.model,
        },
        body: JSON.stringify({ fen, engine_eval: engine.eval, top_lines: engine.top_lines, moves }),
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
            const data = line.startsWith('data: ') ? line.slice(6) : line.slice(5)
            if (currentEvent === 'coaching') {
              coachingText += data
              setCoaching(coachingText)
            } else if (currentEvent === 'error') {
              setCoachError(data)
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setCoachError(err instanceof Error ? err.message : 'Coaching request failed.')
    } finally {
      setCoachLoading(false)
    }
  }, [])

  // ── Auto-analyze on position change ──

  useEffect(() => {
    if (analyzing) {
      fetchEngine(currentFen)
    }
  }, [currentFen, analyzing, fetchEngine])

  // ── Init chessground ──

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
              const newEntry: HistoryEntry = {
                fen: chess.fen(),
                lastMove: [orig, dest],
                san: move.san,
              }
              setHistory(prev => {
                // Get current index from prev length context — we always
                // append at the latest when making a move
                const sliced = prev.slice(0, prev.length)
                return [...sliced, newEntry]
              })
              setCurrentIndex(prev => prev + 1)
              cgRef.current?.set({
                turnColor: turnColor(chess),
                check: chess.isCheck() ? turnColor(chess) : false,
                movable: {
                  color: turnColor(chess),
                  dests: toDests(chess),
                },
                lastMove: [orig, dest],
              })
            }
          },
        },
      },
    })
  }, [])

  // ── Navigation ──

  const navigateTo = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(index, history.length - 1))
    setCurrentIndex(clamped)
    const entry = history[clamped]
    const isLatest = clamped === history.length - 1
    showPosition(entry, isLatest)
  }, [history, showPosition])

  const goStart = useCallback(() => navigateTo(0), [navigateTo])
  const goBack = useCallback(() => navigateTo(currentIndex - 1), [navigateTo, currentIndex])
  const goForward = useCallback(() => navigateTo(currentIndex + 1), [navigateTo, currentIndex])
  const goEnd = useCallback(() => navigateTo(history.length - 1), [navigateTo, history.length])

  // When a move is made while viewing a past position, we need to handle it:
  // The move handler always appends. But if we're viewing a past position,
  // we need to truncate forward history first and jump to the end.
  // We do this by jumping to the end before allowing moves.
  // When currentIndex changes and we're not at latest, disable moves.
  useEffect(() => {
    if (!cgRef.current) return
    if (atLatest) {
      const chess = chessRef.current
      cgRef.current.set({
        movable: {
          color: turnColor(chess),
          dests: toDests(chess),
        },
      })
    } else {
      cgRef.current.set({
        movable: {
          color: undefined,
          dests: undefined,
        },
      })
    }
  }, [atLatest])

  // Handle making a move when not at latest: jump to end first, truncate
  // Actually, simpler: only allow moves at latest position (handled above)
  // If user wants to play from a past position, they need to go to end first.
  // TODO: Could truncate and allow, but for now this matches Lichess behavior.

  // Keyboard navigation
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.key === 'ArrowLeft') { e.preventDefault(); goBack() }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goForward() }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [goBack, goForward])

  // ── Handlers ──

  const handleFenChange = (newFen: string) => {
    try {
      const chess = new Chess(newFen)
      chessRef.current = chess
      const entry: HistoryEntry = { fen: newFen }
      setHistory([entry])
      setCurrentIndex(0)
      showPosition(entry, true)
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
      setEngineError('')
      setCoachError('')
    } else {
      setAnalyzing(true)
    }
  }

  const handleCoachMe = () => {
    if (!engineData) return
    // Build move list from history up to current position
    const moves = history.slice(1, currentIndex + 1).map(h => h.san).filter(Boolean) as string[]
    fetchCoaching(currentFen, engineData, moves)
  }

  const handleReset = () => {
    const chess = new Chess()
    chessRef.current = chess
    setHistory([{ fen: START_FEN }])
    setCurrentIndex(0)
    setEngineData(null)
    setCoaching('')
    setEngineError('')
    setCoachError('')
    showPosition({ fen: START_FEN }, true)
  }

  const hasEngine = engineData !== null
  const hasKey = settings.apiKey.length > 0

  return (
    <div className="app">
      <header>
        <h1>DeepSquare</h1>
        <button className="btn-settings" onClick={() => setSettingsOpen(true)} title="Settings">
          ⚙
        </button>
      </header>

      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSave={setSettings}
      />

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
            <div className="nav-buttons">
              <button onClick={goStart} disabled={currentIndex === 0} title="Start">⟨⟨</button>
              <button onClick={goBack} disabled={currentIndex === 0} title="Back">⟨</button>
              <button onClick={goForward} disabled={atLatest} title="Forward">⟩</button>
              <button onClick={goEnd} disabled={atLatest} title="End">⟩⟩</button>
            </div>
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
          <MoveList history={history} currentIndex={currentIndex} onJump={navigateTo} />

          <section className="coaching-section">
            <div className="coaching-header">
              <h3>Coach {coachLoading && <span className="loading-dot" />}</h3>
              {analyzing && (
                <button
                  className="btn-coach"
                  onClick={handleCoachMe}
                  disabled={coachLoading || !hasKey || !hasEngine}
                  title={!hasKey ? 'Set your API key in Settings' : undefined}
                >
                  {coachLoading ? 'Thinking...' : 'Coach me'}
                </button>
              )}
            </div>
            <div className="coaching-body">
              {coachError ? (
                <p className="error-msg">{coachError}</p>
              ) : coaching ? (
                <p dangerouslySetInnerHTML={{
                  __html: cleanCoaching(coaching)
                }} />
              ) : (
                <p className="placeholder">
                  {!hasKey
                    ? 'Set your API key in ⚙ Settings to use the coach.'
                    : analyzing
                      ? 'Click "Coach me" for position advice.'
                      : 'Click Analyze to start engine analysis.'}
                </p>
              )}
            </div>
          </section>

          <section className="engine-section">
            <h3>Engine lines {engineLoading && <span className="loading-dot" />}</h3>
            <div className="engine-body">
              {engineError ? (
                <div className="error-msg">{engineError}</div>
              ) : hasEngine ? (
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
                value={currentFen}
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
