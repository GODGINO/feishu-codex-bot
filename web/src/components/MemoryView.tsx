import { useEffect, useState, useCallback } from 'react'
import { api, type Observation, type SessionSummaryMem } from '../lib/api'

const TYPE_COLORS: Record<string, string> = {
  bugfix: 'bg-red-100 text-red-700',
  change: 'bg-yellow-100 text-yellow-700',
  decision: 'bg-purple-100 text-purple-700',
  discovery: 'bg-blue-100 text-blue-700',
  feature: 'bg-green-100 text-green-700',
  refactor: 'bg-orange-100 text-orange-700',
}

const ALL_TYPES = ['bugfix', 'change', 'decision', 'discovery', 'feature', 'refactor']

function formatDate(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString()
}

function truncate(s: string, max = 120): string {
  if (!s) return ''
  return s.length > max ? s.slice(0, max) + '...' : s
}

export default function MemoryView({ sessionKey }: { sessionKey: string }) {
  const [observations, setObservations] = useState<Observation[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [limit] = useState(20)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)

  const [summaries, setSummaries] = useState<SessionSummaryMem[]>([])
  const [summariesTotal, setSummariesTotal] = useState(0)
  const [summariesPage, setSummariesPage] = useState(1)
  const [showSummaries, setShowSummaries] = useState(false)

  const loadObservations = useCallback(() => {
    api.memory(sessionKey, page, limit, search || undefined, typeFilter || undefined)
      .then(r => { setObservations(r.observations); setTotal(r.total) })
  }, [sessionKey, page, limit, search, typeFilter])

  const loadSummaries = useCallback(() => {
    api.memorySummaries(sessionKey, summariesPage, 10)
      .then(r => { setSummaries(r.summaries); setSummariesTotal(r.total) })
  }, [sessionKey, summariesPage])

  useEffect(() => { loadObservations() }, [loadObservations])
  useEffect(() => { if (showSummaries) loadSummaries() }, [loadSummaries, showSummaries])

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(searchInput); setPage(1) }, 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  const totalPages = Math.ceil(total / limit)
  const summariesTotalPages = Math.ceil(summariesTotal / 10)

  if (total === 0 && !search && !typeFilter && observations.length === 0) {
    return <p className="text-slate-400 text-sm">No memory data for this session</p>
  }

  return (
    <div className="space-y-6">
      {/* Search + Filter */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="Search observations..."
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
        />
        <select
          value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value); setPage(1) }}
          className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-300"
        >
          <option value="">All types</option>
          {ALL_TYPES.map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>

      {/* Stats */}
      <div className="text-xs text-slate-400">
        {total} observation{total !== 1 ? 's' : ''} found
        {search && <span> matching "{search}"</span>}
        {typeFilter && <span> of type "{typeFilter}"</span>}
      </div>

      {/* Observations List */}
      <div className="space-y-2">
        {observations.map(obs => (
          <div key={obs.id} className="border border-slate-200 rounded-lg overflow-hidden">
            <button
              onClick={() => setExpanded(expanded === obs.id ? null : obs.id)}
              className="w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${TYPE_COLORS[obs.type] || 'bg-slate-100 text-slate-600'}`}>
                  {obs.type}
                </span>
                <span className="font-medium text-sm flex-1 min-w-0 truncate">{obs.title}</span>
                <span className="text-xs text-slate-400 shrink-0">{formatDate(obs.created_at_epoch)}</span>
              </div>
              {obs.files_modified && (
                <div className="text-xs text-slate-400 mt-1">
                  files: {truncate(obs.files_modified, 80)}
                </div>
              )}
              {obs.facts && expanded !== obs.id && (
                <div className="text-xs text-slate-500 mt-1">{truncate(obs.facts)}</div>
              )}
            </button>

            {expanded === obs.id && (
              <div className="px-4 pb-4 border-t border-slate-100 space-y-3 text-sm">
                {obs.narrative && (
                  <div className="mt-3">
                    <div className="text-xs font-semibold text-slate-500 mb-1">Narrative</div>
                    <div className="text-slate-700 whitespace-pre-wrap">{obs.narrative}</div>
                  </div>
                )}
                {obs.facts && (
                  <div>
                    <div className="text-xs font-semibold text-slate-500 mb-1">Facts</div>
                    <div className="text-slate-700 whitespace-pre-wrap">{obs.facts}</div>
                  </div>
                )}
                {obs.concepts && (
                  <div>
                    <div className="text-xs font-semibold text-slate-500 mb-1">Concepts</div>
                    <div className="text-slate-600">{obs.concepts}</div>
                  </div>
                )}
                {obs.files_read && (
                  <div>
                    <div className="text-xs font-semibold text-slate-500 mb-1">Files Read</div>
                    <div className="text-slate-600 text-xs font-mono">{obs.files_read}</div>
                  </div>
                )}
                {obs.files_modified && (
                  <div>
                    <div className="text-xs font-semibold text-slate-500 mb-1">Files Modified</div>
                    <div className="text-slate-600 text-xs font-mono">{obs.files_modified}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-3 py-1 text-sm rounded border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
          >
            Prev
          </button>
          <span className="text-sm text-slate-500">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="px-3 py-1 text-sm rounded border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
          >
            Next
          </button>
        </div>
      )}

      {/* Session Summaries */}
      <div className="border-t border-slate-200 pt-4">
        <button
          onClick={() => setShowSummaries(!showSummaries)}
          className="text-sm font-semibold text-slate-600 hover:text-slate-800 flex items-center gap-2"
        >
          <span>{showSummaries ? '▼' : '▶'}</span>
          Session Summaries
          {summariesTotal > 0 && (
            <span className="text-xs bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">{summariesTotal}</span>
          )}
        </button>

        {showSummaries && (
          <div className="mt-3 space-y-3">
            {summaries.length === 0 && (
              <p className="text-slate-400 text-sm">No session summaries</p>
            )}
            {summaries.map(s => (
              <div key={s.id} className="border border-slate-200 rounded-lg px-4 py-3 text-sm space-y-2">
                <div className="flex items-center justify-between">
                  <div className="font-medium text-slate-700 truncate flex-1">{truncate(s.request, 100)}</div>
                  <span className="text-xs text-slate-400 shrink-0 ml-2">{formatDate(s.created_at_epoch)}</span>
                </div>
                {s.completed && (
                  <div>
                    <span className="text-xs font-semibold text-green-600">Completed: </span>
                    <span className="text-slate-600 text-xs">{s.completed}</span>
                  </div>
                )}
                {s.learned && (
                  <div>
                    <span className="text-xs font-semibold text-blue-600">Learned: </span>
                    <span className="text-slate-600 text-xs">{s.learned}</span>
                  </div>
                )}
              </div>
            ))}

            {summariesTotalPages > 1 && (
              <div className="flex items-center justify-center gap-2">
                <button
                  onClick={() => setSummariesPage(p => Math.max(1, p - 1))}
                  disabled={summariesPage <= 1}
                  className="px-3 py-1 text-sm rounded border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
                >
                  Prev
                </button>
                <span className="text-sm text-slate-500">
                  {summariesPage} / {summariesTotalPages}
                </span>
                <button
                  onClick={() => setSummariesPage(p => Math.min(summariesTotalPages, p + 1))}
                  disabled={summariesPage >= summariesTotalPages}
                  className="px-3 py-1 text-sm rounded border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
