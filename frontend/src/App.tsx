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
const POSITION_MARKER_RE = /\[POSITION:\s*([^\]]+)\]/

// ── Helpers ──

const MOVE_RE = /(?<![a-zA-Z])([KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|[a-h]x[a-h][1-8](?:=[QRBN])?[+#]?|[a-h][1-8][+#]?|O-O(?:-O)?[+#]?)(?![a-zA-Z])/g

function formatCoachText(raw: string): string {
  let text = raw
  // Strip position markers from display text
  text = text.replace(/\[POSITION:\s*[^\]]+\]/g, '').trim()
  // Fix tokenizer artifacts
  text = text.replace(/ '/g, "'")
  text = text.replace(/ ([.,;:!?])/g, '$1')
  // Process {move} markers
  text = text.replace(/\{([^}]*)\}/g, (_, inner: string) => {
    const clean = inner.replace(/\s+/g, '')
    return `<code class="move">${clean}</code>`
  })
  // Process [concept] markers (but not [FEN:...])
  text = text.replace(/\[(?!FEN:)([^\]]*)\]/g, (_, inner) => {
    const clean = inner.replace(/\s+/g, ' ').trim()
    return `<strong>${clean}</strong>`
  })
  // Clean up stray **
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/\*\*/g, '')
  // Auto-detect unwrapped chess moves
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

interface ChatMsg {
  role: 'user' | 'assistant'
  text: string
  positionName?: string  // if a position was loaded
}

// ── Components ──

function MoveList({ history, currentIndex, onJump }: {
  history: HistoryEntry[]
  currentIndex: number
  onJump: (index: number) => void
}) {
  const moves = history.slice(1)
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

function ChatMessages({ messages, streaming }: { messages: ChatMsg[]; streaming: string }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, streaming])

  const hasContent = messages.length > 0 || streaming

  return (
    <div className="chat-messages" ref={scrollRef}>
      {!hasContent && (
        <div className="chat-empty">
          Ask about the position, request a scenario, or click "Coach me" to get started.
        </div>
      )}
      {messages.map((msg, i) => (
        <div key={i} className={`chat-msg chat-${msg.role}`}>
          {msg.role === 'user' ? (
            <p>{msg.text}</p>
          ) : (
            <>
              <p dangerouslySetInnerHTML={{ __html: formatCoachText(msg.text) }} />
              {msg.positionName && (
                <div className="chat-position-loaded">Board set: {msg.positionName}</div>
              )}
            </>
          )}
        </div>
      ))}
      {streaming && (
        <div className="chat-msg chat-assistant">
          <p dangerouslySetInnerHTML={{ __html: formatCoachText(streaming) }} />
        </div>
      )}
    </div>
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
  const currentFen = history[currentIndex].fen
  const atLatest = currentIndex === history.length - 1

  // Settings
  const [settings, setSettings] = useState<LLMSettings>(loadSettings)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Engine
  const [engineData, setEngineData] = useState<EngineData | null>(null)
  const [engineError, setEngineError] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [engineLoading, setEngineLoading] = useState(false)
  const engineAbortRef = useRef<AbortController | null>(null)

  // Chat
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([])
  const [streaming, setStreaming] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState('')
  const [chatInput, setChatInput] = useState('')
  const chatAbortRef = useRef<AbortController | null>(null)

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

  const setBoardFromFen = useCallback((fen: string) => {
    try {
      const chess = new Chess(fen)
      chessRef.current = chess
      const entry: HistoryEntry = { fen: chess.fen() }
      setHistory([entry])
      setCurrentIndex(0)
      cgRef.current?.set({
        fen: chess.fen(),
        turnColor: turnColor(chess),
        check: chess.isCheck() ? turnColor(chess) : false,
        lastMove: undefined,
        movable: {
          color: turnColor(chess),
          dests: toDests(chess),
        },
      })
    } catch {
      // invalid FEN
    }
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

  const sendChat = useCallback(async (userText: string) => {
    const s = settingsRef.current
    if (!s.apiKey) {
      setChatError('Set your API key in Settings to use the coach.')
      return
    }

    const userMsg: ChatMsg = { role: 'user', text: userText }
    setChatMessages(prev => [...prev, userMsg])
    setChatInput('')

    chatAbortRef.current?.abort()
    const controller = new AbortController()
    chatAbortRef.current = controller
    setChatLoading(true)
    setStreaming('')
    setChatError('')

    // Build message history for API
    const allMessages = [...chatMessages, userMsg]
    const moves = history.slice(1, currentIndex + 1).map(h => h.san).filter(Boolean) as string[]

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': s.apiKey,
          'X-LLM-Model': s.model,
        },
        body: JSON.stringify({
          messages: allMessages.map(m => ({ role: m.role, text: m.text })),
          fen: currentFen,
          moves,
          engine_eval: engineData?.eval ?? null,
          top_lines: engineData?.top_lines ?? null,
        }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const reader = res.body?.getReader()
      if (!reader) throw new Error('No response body')
      const decoder = new TextDecoder()
      let buffer = ''
      let fullText = ''
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
            if (currentEvent === 'token') {
              fullText += data
              setStreaming(fullText)
            } else if (currentEvent === 'error') {
              setChatError(data)
            }
          }
        }
      }

      // Streaming done — finalize message
      if (fullText) {
        const posMatch = fullText.match(POSITION_MARKER_RE)
        const assistantMsg: ChatMsg = {
          role: 'assistant',
          text: fullText,
        }

        if (posMatch) {
          // Search for the position
          const query = posMatch[1].trim()
          try {
            const searchRes = await fetch(`/api/positions/search?q=${encodeURIComponent(query)}`, {
              signal: controller.signal,
            })
            if (searchRes.ok) {
              const results = await searchRes.json()
              if (results.length > 0) {
                const pos = results[0]
                assistantMsg.positionName = pos.name
                setBoardFromFen(pos.fen)
              }
            }
          } catch { /* search failed — no big deal, just don't set the board */ }
        }

        setChatMessages(prev => [...prev, assistantMsg])
        setStreaming('')
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setChatError(err instanceof Error ? err.message : 'Chat request failed.')
    } finally {
      setChatLoading(false)
      setStreaming('')
    }
  }, [chatMessages, currentFen, engineData, history, currentIndex])

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
              setHistory(prev => [...prev.slice(0, prev.length), newEntry])
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

  useEffect(() => {
    if (!cgRef.current) return
    if (atLatest) {
      const chess = chessRef.current
      cgRef.current.set({
        movable: { color: turnColor(chess), dests: toDests(chess) },
      })
    } else {
      cgRef.current.set({
        movable: { color: undefined, dests: undefined },
      })
    }
  }, [atLatest])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
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
    } catch { /* invalid FEN */ }
  }

  const handleToggleAnalysis = () => {
    if (analyzing) {
      engineAbortRef.current?.abort()
      chatAbortRef.current?.abort()
      setAnalyzing(false)
      setEngineLoading(false)
      setChatLoading(false)
      setEngineData(null)
      setEngineError('')
      setChatError('')
      setChatMessages([])
      setStreaming('')
    } else {
      setAnalyzing(true)
    }
  }

  const handleCoachMe = () => {
    sendChat('Analyze this position and coach me.')
  }

  const handleChatSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!chatInput.trim() || chatLoading) return
    sendChat(chatInput.trim())
  }

  const handleReset = () => {
    const chess = new Chess()
    chessRef.current = chess
    setHistory([{ fen: START_FEN }])
    setCurrentIndex(0)
    setEngineData(null)
    setEngineError('')
    setChatMessages([])
    setStreaming('')
    setChatError('')
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

          <section className="chat-section">
            <div className="chat-header">
              <h3>Coach {chatLoading && <span className="loading-dot" />}</h3>
              {analyzing && (
                <button
                  className="btn-coach"
                  onClick={handleCoachMe}
                  disabled={chatLoading || !hasKey || !hasEngine}
                  title={!hasKey ? 'Set your API key in Settings' : undefined}
                >
                  {chatLoading ? 'Thinking...' : 'Coach me'}
                </button>
              )}
            </div>

            <ChatMessages messages={chatMessages} streaming={streaming} />

            {chatError && <div className="error-msg">{chatError}</div>}

            <form className="chat-input-form" onSubmit={handleChatSubmit}>
              <input
                type="text"
                className="chat-input"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                placeholder={hasKey ? 'Ask about this position...' : 'Set API key in ⚙ Settings'}
                disabled={!hasKey || chatLoading}
                spellCheck={false}
              />
              <button
                type="submit"
                className="btn-send"
                disabled={!hasKey || chatLoading || !chatInput.trim()}
              >
                ↑
              </button>
            </form>
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
