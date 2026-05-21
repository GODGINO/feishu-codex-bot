import { useEffect, useState } from 'react'
import { RefreshCw, Pause, Play, ArrowRightLeft } from 'lucide-react'
import { api, type SwitcherStatus } from '../lib/api'

function formatRelative(ts: number | null): string {
  if (!ts) return '—'
  const s = Math.floor((Date.now() / 1000) - ts)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function usageColor(p: number | null): string {
  if (p === null) return 'bg-slate-300'
  if (p >= 70) return 'bg-red-500'
  if (p >= 50) return 'bg-amber-500'
  return 'bg-green-500'
}

export default function SwitcherPanel() {
  const [status, setStatus] = useState<SwitcherStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const s = await api.switcherStatus()
      setStatus(s)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [])

  const togglePause = async () => {
    if (!status) return
    setBusy('pause')
    try {
      if (status.paused) await api.switcherResume()
      else await api.switcherPause()
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally { setBusy(null) }
  }

  const triggerSwitch = async (email: string) => {
    if (!confirm(`确认手动切换到 ${email}？`)) return
    setBusy(`trigger-${email}`)
    try {
      await api.switcherTrigger(email)
      // give daemon a beat to start the OAuth chain before we refresh
      setTimeout(refresh, 1200)
    } catch (err) {
      setError((err as Error).message)
      setBusy(null)
    }
  }

  if (!status && !error) {
    return <div className="bg-white rounded-xl border border-slate-200 p-5 text-slate-400 text-sm">加载 switcher 状态…</div>
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 mb-8">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-bold">Switcher 状态</h3>
        <div className="flex gap-2">
          <button
            onClick={togglePause}
            disabled={!status || busy !== null}
            className={`px-3 py-1.5 text-sm rounded-lg flex items-center gap-1.5 disabled:opacity-50 ${
              status?.paused
                ? 'bg-green-50 text-green-700 hover:bg-green-100 border border-green-200'
                : 'bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200'
            }`}
          >
            {status?.paused ? <Play size={14} /> : <Pause size={14} />}
            {status?.paused ? '恢复轮换' : '暂停轮换'}
          </button>
          <button
            onClick={refresh}
            disabled={loading}
            className="px-3 py-1.5 text-sm rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center gap-1.5 disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            刷新
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 px-3 py-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
          {error}
        </div>
      )}

      {status && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4 text-sm">
            <div>
              <div className="text-slate-500 text-xs mb-0.5">当前账号</div>
              <div className="font-mono text-slate-900">{status.current || '—'}</div>
            </div>
            <div>
              <div className="text-slate-500 text-xs mb-0.5">切换次数</div>
              <div className="font-bold text-slate-900">{status.switchCount}</div>
            </div>
            <div>
              <div className="text-slate-500 text-xs mb-0.5">上次切换</div>
              <div className="text-slate-700">{formatRelative(status.lastSwitchTs)}</div>
            </div>
          </div>

          {/* Current session — switcher-derived rolling 5h window, used as a switch trigger.
              Highlighted separately because it is NOT on Anthropic's official dashboard. */}
          {status.breakdown['Current session'] !== undefined && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="flex items-center justify-between mb-1.5">
                <div>
                  <div className="text-xs text-amber-700 font-medium">Current session（5h 滚动窗口）</div>
                  <div className="text-[11px] text-amber-600/70 mt-0.5">switcher 用此值提前触发切换 · 不在 Anthropic 仪表盘上</div>
                </div>
                <span className="font-bold text-lg text-amber-900">{status.breakdown['Current session']}%</span>
              </div>
              <div className="h-1.5 bg-white/60 rounded overflow-hidden">
                <div
                  className={`h-full ${usageColor(status.breakdown['Current session'])}`}
                  style={{ width: `${Math.min(100, status.breakdown['Current session'])}%` }}
                />
              </div>
            </div>
          )}

          {/* Weekly quota — matches Anthropic's official dashboard bars. */}
          {(() => {
            const weekly = Object.entries(status.breakdown).filter(([k]) => k !== 'Current session')
            if (weekly.length === 0) return null
            return (
              <div className="mb-4 p-3 bg-slate-50 rounded-lg">
                <div className="text-xs text-slate-500 mb-2">周配额（Anthropic dashboard）</div>
                <div className="space-y-2 text-sm">
                  {weekly.map(([k, v]) => (
                    <div key={k} className="flex items-center gap-3">
                      <span className="text-slate-600 w-32 shrink-0">{k}</span>
                      <div className="flex-1 h-1.5 bg-slate-200/60 rounded overflow-hidden">
                        <div className={`h-full ${usageColor(v)}`} style={{ width: `${Math.min(100, v)}%` }} />
                      </div>
                      <span className="font-medium text-slate-900 w-10 text-right">{v}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

          <div>
            <div className="text-xs text-slate-500 mb-2">所有账号 (点击手动切换)</div>
            <div className="space-y-1.5">
              {status.accounts.map(a => {
                const isCurrent = a.email === status.current
                const cooldownTs = status.cooldowns[a.email]
                const onCooldown = cooldownTs && cooldownTs > Date.now() / 1000
                return (
                  <div key={a.email} className={`flex items-center justify-between p-2 rounded-lg border ${
                    isCurrent ? 'border-blue-300 bg-blue-50' : 'border-slate-200'
                  }`}>
                    <div className="flex items-center gap-2 text-sm">
                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                        isCurrent ? 'bg-blue-500 text-white' : 'bg-slate-200 text-slate-700'
                      }`}>{a.label}</span>
                      <span className="font-mono">{a.email}</span>
                      {isCurrent && <span className="text-xs text-blue-600">· 当前</span>}
                      {onCooldown && <span className="text-xs text-amber-600">· 冷却中</span>}
                    </div>
                    <button
                      onClick={() => triggerSwitch(a.email)}
                      disabled={isCurrent || busy !== null || status.paused}
                      className="px-2 py-1 text-xs rounded bg-slate-100 hover:bg-slate-200 flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                      title={status.paused ? '当前已暂停，请先恢复轮换' : isCurrent ? '已是当前账号' : '手动切换到此账号'}
                    >
                      <ArrowRightLeft size={11} />
                      {busy === `trigger-${a.email}` ? '切换中…' : '切到这个'}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
