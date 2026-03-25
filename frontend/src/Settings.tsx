import { useState, useEffect } from 'react'

export interface LLMSettings {
  provider: 'anthropic' | 'openai'
  apiKey: string
  model: string
}

const MODELS: Record<string, { label: string; value: string }[]> = {
  anthropic: [
    { label: 'Haiku (fast, cheap)', value: 'claude-haiku-4-5-20251001' },
    { label: 'Sonnet (balanced)', value: 'claude-sonnet-4-20250514' },
  ],
  openai: [
    { label: 'GPT-4o Mini (fast, cheap)', value: 'gpt-4o-mini' },
    { label: 'GPT-4o (balanced)', value: 'gpt-4o' },
  ],
}

const STORAGE_KEY = 'deepsquare-settings'

export function loadSettings(): LLMSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return { provider: 'anthropic', apiKey: '', model: 'claude-haiku-4-5-20251001' }
}

function saveSettings(s: LLMSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
}

export function Settings({ open, onClose, settings, onSave }: {
  open: boolean
  onClose: () => void
  settings: LLMSettings
  onSave: (s: LLMSettings) => void
}) {
  const [draft, setDraft] = useState(settings)

  useEffect(() => {
    if (open) setDraft(settings)
  }, [open, settings])

  if (!open) return null

  const models = MODELS[draft.provider]

  const handleProviderChange = (provider: 'anthropic' | 'openai') => {
    setDraft({
      ...draft,
      provider,
      model: MODELS[provider][0].value,
    })
  }

  const handleSave = () => {
    saveSettings(draft)
    onSave(draft)
    onClose()
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={onClose}>×</button>
        </div>

        <div className="settings-body">
          <label className="settings-field">
            Provider
            <select
              value={draft.provider}
              onChange={e => handleProviderChange(e.target.value as 'anthropic' | 'openai')}
            >
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI (GPT)</option>
            </select>
          </label>

          <label className="settings-field">
            API Key
            <input
              type="password"
              value={draft.apiKey}
              onChange={e => setDraft({ ...draft, apiKey: e.target.value })}
              placeholder={draft.provider === 'anthropic' ? 'sk-ant-...' : 'sk-...'}
              spellCheck={false}
              autoComplete="off"
            />
            <span className="settings-hint">
              Stored in your browser only. Never sent to our servers.
            </span>
          </label>

          <label className="settings-field">
            Model
            <select
              value={draft.model}
              onChange={e => setDraft({ ...draft, model: e.target.value })}
            >
              {models.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="settings-footer">
          <button className="btn-settings-save" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  )
}
