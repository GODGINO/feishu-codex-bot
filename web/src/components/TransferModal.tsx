import { useState, useEffect } from 'react'
import { api, type SessionSummary } from '../lib/api'

interface Props {
  open: boolean
  title: string
  currentSession: string
  envVars?: string[]
  onTransfer: (targetSession: string, transferEnvVars: boolean) => void
  onCancel: () => void
  loading?: boolean
}

export default function TransferModal({ open, title, currentSession, envVars, onTransfer, onCancel, loading }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selected, setSelected] = useState('')
  const [transferEnv, setTransferEnv] = useState(false)
  const [fetching, setFetching] = useState(false)

  useEffect(() => {
    if (!open) return
    setSelected('')
    setTransferEnv(false)
    setFetching(true)
    api.sessions().then(list => {
      setSessions(list.filter(s => s.key !== currentSession))
      setFetching(false)
    }).catch(() => setFetching(false))
  }, [open, currentSession])

  if (!open) return null

  const hasEnvVars = envVars && envVars.length > 0

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center" onClick={onCancel}>
      <div className="bg-white rounded-xl shadow-xl p-6 w-[28rem] max-w-[90vw]" onClick={e => e.stopPropagation()}>
        <h3 className="font-semibold text-lg mb-4">{title}</h3>

        {fetching ? (
          <p className="text-sm text-slate-400 py-4">Loading sessions...</p>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-slate-400 py-4">No other sessions available</p>
        ) : (
          <div className="space-y-4">
            <select
              value={selected}
              onChange={e => setSelected(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Select target session...</option>
              {sessions.map(s => (
                <option key={s.key} value={s.key}>
                  {s.name} ({s.type})
                </option>
              ))}
            </select>

            {hasEnvVars && (
              <label className="flex items-start gap-2.5 p-3 bg-amber-50 border border-amber-200 rounded-lg cursor-pointer">
                <input
                  type="checkbox"
                  checked={transferEnv}
                  onChange={e => setTransferEnv(e.target.checked)}
                  className="mt-0.5 accent-amber-500"
                />
                <div>
                  <div className="text-sm font-medium text-amber-800">Transfer environment variables</div>
                  <div className="text-xs text-amber-600 mt-0.5 flex flex-wrap gap-1">
                    {envVars!.map(v => <code key={v} className="bg-amber-100 px-1 rounded whitespace-nowrap">${v}</code>)}
                  </div>
                </div>
              </label>
            )}
          </div>
        )}

        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => selected && onTransfer(selected, transferEnv)}
            disabled={!selected || loading}
            className={`px-4 py-2 text-sm text-white bg-blue-500 hover:bg-blue-600 rounded-lg transition-colors ${
              (!selected || loading) ? 'opacity-50 cursor-not-allowed' : ''
            }`}
          >
            {loading ? 'Transferring...' : 'Transfer'}
          </button>
        </div>
      </div>
    </div>
  )
}
