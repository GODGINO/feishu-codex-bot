import { useEffect, useState } from 'react'
import { api, type Alert } from '../lib/api'
import ConfirmDialog from './ConfirmDialog'

export default function AlertTable({ sessionKey }: { sessionKey: string }) {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [confirmDelete, setConfirmDelete] = useState<Alert | null>(null)
  const [confirmReset, setConfirmReset] = useState<Alert | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const refresh = () => api.alerts(sessionKey).then(setAlerts)

  useEffect(() => { refresh() }, [sessionKey])

  const handleToggle = async (alert: Alert) => {
    await api.toggleAlert(sessionKey, alert.id, !alert.enabled)
    refresh()
  }

  const handleDelete = async () => {
    if (!confirmDelete) return
    setLoading(true)
    try {
      await api.deleteAlert(sessionKey, confirmDelete.id)
      setConfirmDelete(null)
      refresh()
    } finally { setLoading(false) }
  }

  const handleReset = async () => {
    if (!confirmReset) return
    setLoading(true)
    try {
      await api.resetAlert(sessionKey, confirmReset.id)
      setConfirmReset(null)
      refresh()
    } finally { setLoading(false) }
  }

  if (alerts.length === 0) {
    return <p className="text-slate-400">No alerts configured</p>
  }

  const fmtTime = (s?: string) => s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'
  const typeBadge = (t: string) => t === 'watcher'
    ? 'bg-blue-50 text-blue-700'
    : 'bg-purple-50 text-purple-700'
  const modeBadge = (m: string) => ({
    claude: 'bg-amber-50 text-amber-700',
    shell: 'bg-slate-100 text-slate-700',
    message_only: 'bg-green-50 text-green-700',
  } as Record<string, string>)[m] || 'bg-slate-100 text-slate-500'

  return (
    <>
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th className="text-left px-5 py-3 font-medium text-slate-600">Name</th>
              <th className="text-left px-5 py-3 font-medium text-slate-600">Type / Mode</th>
              <th className="text-center px-5 py-3 font-medium text-slate-600">Interval</th>
              <th className="text-center px-5 py-3 font-medium text-slate-600">Status</th>
              <th className="text-left px-5 py-3 font-medium text-slate-600">Stats</th>
              <th className="text-left px-5 py-3 font-medium text-slate-600">Last Trigger</th>
              <th className="text-right px-5 py-3 font-medium text-slate-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {alerts.map(a => {
              const stats = a.state?.stats || { polls: 0, triggers: 0, failures: 0 }
              const wmSize = (a.state?.watermark?.processed_ids || []).length
              const isOpen = expanded === a.id
              return (
                <>
                  <tr key={a.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => setExpanded(isOpen ? null : a.id)}>
                    <td className="px-5 py-3">
                      <p className="font-medium">{a.name}</p>
                      <p className="text-xs text-slate-400 mt-0.5 line-clamp-1">{a.prompt}</p>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-col gap-1">
                        <span className={`inline-flex w-fit items-center px-1.5 py-0.5 rounded text-xs font-medium ${typeBadge(a.type)}`}>
                          {a.type}
                        </span>
                        <span className={`inline-flex w-fit items-center px-1.5 py-0.5 rounded text-xs font-medium ${modeBadge(a.execution_mode)}`}>
                          {a.execution_mode}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-center">
                      <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded">{a.interval_seconds}s</code>
                    </td>
                    <td className="px-5 py-3 text-center">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        a.enabled ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'
                      }`}>
                        {a.enabled ? 'Active' : 'Disabled'}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-600">
                      <div>polls <b>{stats.polls}</b> / triggers <b>{stats.triggers}</b></div>
                      <div>failures <b className={stats.failures > 0 ? 'text-red-500' : ''}>{stats.failures}</b> / 已处理 <b>{wmSize}</b></div>
                    </td>
                    <td className="px-5 py-3 text-slate-500 text-xs">
                      {fmtTime(stats.last_trigger)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => handleToggle(a)}
                          className="text-xs px-2 py-1 rounded hover:bg-slate-100 text-slate-500 transition-colors"
                        >
                          {a.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          onClick={() => setConfirmReset(a)}
                          className="text-xs px-2 py-1 rounded hover:bg-amber-50 text-amber-600 transition-colors"
                          title="清空 watermark 重新建立基线"
                        >
                          Reset
                        </button>
                        <button
                          onClick={() => setConfirmDelete(a)}
                          className="text-xs px-2 py-1 rounded hover:bg-red-50 text-red-500 transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr key={a.id + '_detail'} className="bg-slate-50/50">
                      <td colSpan={7} className="px-5 py-3">
                        <div className="text-xs space-y-2">
                          <div><b>check_command:</b> <code className="bg-white px-1.5 py-0.5 rounded">{a.check_command}</code></div>
                          {a.trigger_command && <div><b>trigger_command:</b> <code className="bg-white px-1.5 py-0.5 rounded">{a.trigger_command}</code></div>}
                          <div><b>prompt:</b> <span className="text-slate-600">{a.prompt}</span></div>
                          <div><b>created:</b> {fmtTime(a.createdAt)} / <b>last_poll:</b> {fmtTime(stats.last_poll)} / <b>max_runtime_days:</b> {a.max_runtime_days ?? 30}</div>
                          <div>
                            <b>watermark.last_pubdate:</b> {a.state?.watermark?.last_pubdate || 0}
                            {' / '}
                            <b>processed_ids ({wmSize}):</b>{' '}
                            <span className="text-slate-500">
                              {(a.state?.watermark?.processed_ids || []).slice(-5).join(', ') || '(empty)'}
                              {wmSize > 5 && ` ... +${wmSize - 5} more`}
                            </span>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Alert"
        message={`Are you sure you want to delete "${confirmDelete?.name}"?`}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(null)}
        loading={loading}
      />

      <ConfirmDialog
        open={!!confirmReset}
        title="Reset Alert"
        message={`重置 "${confirmReset?.name}" 的 watermark 和统计？已处理 ID 集合会被清空，下一轮从当前最新状态重新建立基线（不会重复触发已处理过的事件）。`}
        onConfirm={handleReset}
        onCancel={() => setConfirmReset(null)}
        loading={loading}
      />
    </>
  )
}
