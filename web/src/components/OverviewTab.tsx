import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import type { SessionDetail, EnvVariable } from '../lib/api'
import { api } from '../lib/api'
import ConfirmDialog from './ConfirmDialog'

interface Props {
  session: SessionDetail
  sessionKey: string
  onRefresh: () => void
}

export default function OverviewTab({ session, sessionKey, onRefresh }: Props) {
  const members = Object.entries(session.authors)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editMcp, setEditMcp] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<{ openId: string; name: string } | null>(null)
  const [loading, setLoading] = useState(false)

  const startEdit = (openId: string, info: { name: string; feishuMcpUrl?: string }) => {
    setEditingId(openId)
    setEditName(info.name)
    setEditMcp(info.feishuMcpUrl || '')
  }

  const cancelEdit = () => { setEditingId(null) }

  const saveEdit = async () => {
    if (!editingId) return
    setLoading(true)
    try {
      await api.updateAuthor(sessionKey, editingId, { name: editName, feishuMcpUrl: editMcp || undefined })
      setEditingId(null)
      onRefresh()
    } finally { setLoading(false) }
  }

  const handleDelete = async () => {
    if (!confirmDelete) return
    setLoading(true)
    try {
      await api.deleteAuthor(sessionKey, confirmDelete.openId)
      setConfirmDelete(null)
      onRefresh()
    } finally { setLoading(false) }
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <InfoCard label="Chat ID" value={session.chatId || '-'} />
        {session.type === 'group' ? (
          <AutoReplyCard sessionKey={sessionKey} initial={session.autoReply} />
        ) : (
          <WechatCard sessionKey={sessionKey} binding={session.wechatBinding} onRefresh={onRefresh} />
        )}
        <ModelCard sessionKey={sessionKey} initial={session.model} />
        <InfoCard label="Cron Jobs" value={String(session.cronJobCount)} />
      </div>

      {/* Members */}
      <div className="bg-white rounded-xl border border-slate-200">
        <div className="px-5 py-4 border-b border-slate-200">
          <h3 className="font-semibold">Members ({members.length})</h3>
        </div>
        <div className="divide-y divide-slate-100">
          {members.map(([openId, info]) => (
            <div key={openId} className="px-5 py-3">
              {editingId === openId ? (
                /* Edit mode */
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-slate-400 w-12 shrink-0">Name</label>
                    <input
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      className="flex-1 border border-slate-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-slate-400 w-12 shrink-0">MCP</label>
                    <input
                      value={editMcp}
                      onChange={e => setEditMcp(e.target.value)}
                      placeholder="Feishu MCP URL (optional)"
                      className="flex-1 border border-slate-200 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button onClick={cancelEdit} className="text-xs px-3 py-1 text-slate-500 hover:bg-slate-100 rounded transition-colors">
                      Cancel
                    </button>
                    <button onClick={saveEdit} disabled={loading} className="text-xs px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors">
                      {loading ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              ) : (
                /* View mode */
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Link to={`/members/${openId}`} className="font-medium text-sm text-blue-600 hover:underline">{info.name}</Link>
                      {info.feishuMcpUrl && (
                        <span className="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded font-medium">Feishu MCP</span>
                      )}
                    </div>
                    <p className="text-xs text-slate-400 font-mono">{openId}</p>
                    {info.feishuMcpUrl && (
                      <MaskedUrl url={info.feishuMcpUrl} label="MCP URL" />
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 ml-3">
                    <button
                      onClick={() => startEdit(openId, info)}
                      className="text-xs px-2 py-1 rounded hover:bg-slate-100 text-slate-500 transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setConfirmDelete({ openId, name: info.name })}
                      className="text-xs px-2 py-1 rounded hover:bg-red-50 text-red-500 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {members.length === 0 && (
            <p className="px-5 py-6 text-center text-slate-400">No members</p>
          )}
        </div>
      </div>

      {/* SSH Key */}
      <div className="bg-white rounded-xl border border-slate-200">
        <div className="px-5 py-4 border-b border-slate-200">
          <h3 className="font-semibold">SSH Key</h3>
        </div>
        <div className="px-5 py-4">
          {session.sshPublicKey ? (
            <CopyableText text={session.sshPublicKey} />
          ) : (
            <p className="text-sm text-slate-400">No SSH key configured</p>
          )}
        </div>
      </div>

      {/* Environment Variables */}
      <EnvSection sessionKey={sessionKey} />

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Member"
        message={`Are you sure you want to remove "${confirmDelete?.name}" from this session?`}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(null)}
        loading={loading}
      />
    </div>
  )
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className="font-semibold text-sm truncate" title={value}>{value}</p>
    </div>
  )
}

function MaskedUrl({ url, label }: { url: string; label: string }) {
  const [revealed, setRevealed] = useState(false)
  const masked = url.length > 30 ? url.slice(0, 20) + '••••••' + url.slice(-10) : url

  return (
    <div className="mt-1.5 flex items-center gap-2">
      <span className="text-xs text-slate-400">{label}:</span>
      <code className="text-xs bg-slate-50 px-1.5 py-0.5 rounded font-mono text-slate-600 break-all">
        {revealed ? url : masked}
      </code>
      <button
        onClick={() => setRevealed(!revealed)}
        className="text-xs text-blue-500 hover:text-blue-700 shrink-0"
      >
        {revealed ? 'Hide' : 'Show'}
      </button>
    </div>
  )
}

function EnvSection({ sessionKey }: { sessionKey: string }) {
  const [vars, setVars] = useState<EnvVariable[]>([])
  const [skillEnvMap, setSkillEnvMap] = useState<Record<string, string[]>>({})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const [revealed, setRevealed] = useState<Set<number>>(new Set())

  useEffect(() => {
    api.sessionEnv(sessionKey).then(r => {
      setVars(r.variables)
      setSkillEnvMap(r.skillEnvMap || {})
    })
  }, [sessionKey])

  const updateVar = (idx: number, field: 'key' | 'value', val: string) => {
    const updated = [...vars]
    updated[idx] = { ...updated[idx], [field]: val }
    setVars(updated)
    setDirty(true)
  }

  const removeVar = (idx: number) => {
    setVars(vars.filter((_, i) => i !== idx))
    setDirty(true)
  }

  const addVar = () => {
    if (!newKey.trim()) return
    setVars([...vars, { key: newKey.trim(), value: newValue }])
    setNewKey('')
    setNewValue('')
    setDirty(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      await api.updateSessionEnv(sessionKey, vars)
      setDirty(false)
    } finally { setSaving(false) }
  }

  const toggleReveal = (idx: number) => {
    const next = new Set(revealed)
    next.has(idx) ? next.delete(idx) : next.add(idx)
    setRevealed(next)
  }

  const maskValue = (v: string) => v.length > 4 ? v.slice(0, 2) + '*'.repeat(Math.min(v.length - 4, 20)) + v.slice(-2) : '****'

  // Build reverse map: envKey -> skill names
  const keyToSkills: Record<string, string[]> = {}
  for (const [skill, keys] of Object.entries(skillEnvMap)) {
    for (const k of keys) {
      if (!keyToSkills[k]) keyToSkills[k] = []
      keyToSkills[k].push(skill)
    }
  }

  // Group vars by skill
  const assignedKeys = new Set(Object.values(skillEnvMap).flat())
  const groups: { label: string; indices: number[] }[] = []
  // Skill groups
  for (const [skill, keys] of Object.entries(skillEnvMap)) {
    const indices = vars.map((v, i) => keys.includes(v.key) ? i : -1).filter(i => i >= 0)
    if (indices.length > 0) groups.push({ label: skill, indices })
  }
  // Ungrouped vars
  const ungroupedIndices = vars.map((v, i) => assignedKeys.has(v.key) ? -1 : i).filter(i => i >= 0)
  if (ungroupedIndices.length > 0) groups.push({ label: '', indices: ungroupedIndices })

  // If no groups at all, show all vars flat
  const hasGroups = groups.length > 0 && groups.some(g => g.label)

  const renderVarRow = (v: EnvVariable, i: number, showSkill = false) => (
    <div key={i} className="flex items-center gap-2">
      <input
        value={v.key}
        onChange={e => updateVar(i, 'key', e.target.value)}
        className="w-40 border border-slate-200 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-300"
        placeholder="KEY"
      />
      <span className="text-slate-300">=</span>
      <div className="flex-1 flex items-center gap-1">
        <input
          value={revealed.has(i) ? v.value : maskValue(v.value)}
          onChange={e => { updateVar(i, 'value', e.target.value); if (!revealed.has(i)) toggleReveal(i) }}
          onFocus={() => { if (!revealed.has(i)) toggleReveal(i) }}
          className="flex-1 border border-slate-200 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-300"
          placeholder="value"
        />
        <button
          onClick={() => toggleReveal(i)}
          className="text-xs text-blue-500 hover:text-blue-700 shrink-0 px-1"
        >
          {revealed.has(i) ? 'Hide' : 'Show'}
        </button>
      </div>
      {showSkill && keyToSkills[v.key] && (
        <span className="text-xs text-amber-500 shrink-0">{keyToSkills[v.key].join(', ')}</span>
      )}
      <button
        onClick={() => removeVar(i)}
        className="text-xs text-red-400 hover:text-red-600 shrink-0 px-1"
      >
        Remove
      </button>
    </div>
  )

  return (
    <div className="bg-white rounded-xl border border-slate-200">
      <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">Environment Variables</h3>
          {vars.length > 0 && (
            <span className="text-xs bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded">{vars.length}</span>
          )}
        </div>
        {dirty && (
          <button
            onClick={save}
            disabled={saving}
            className="text-xs px-3 py-1.5 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        )}
      </div>
      <div className="px-5 py-4 space-y-4">
        {hasGroups ? (
          groups.map((group, gi) => (
            <div key={gi}>
              {group.label ? (
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded">{group.label}</span>
                </div>
              ) : (
                <div className="text-xs text-slate-400 mb-2 pt-2 border-t border-slate-100">Other</div>
              )}
              <div className="space-y-2">
                {group.indices.map(i => renderVarRow(vars[i], i))}
              </div>
            </div>
          ))
        ) : (
          <div className="space-y-2">
            {vars.map((v, i) => renderVarRow(v, i, true))}
          </div>
        )}

        {/* Add new variable */}
        <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
          <input
            value={newKey}
            onChange={e => setNewKey(e.target.value)}
            className="w-40 border border-slate-200 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-300"
            placeholder="NEW_KEY"
            onKeyDown={e => e.key === 'Enter' && addVar()}
          />
          <span className="text-slate-300">=</span>
          <input
            value={newValue}
            onChange={e => setNewValue(e.target.value)}
            className="flex-1 border border-slate-200 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-300"
            placeholder="value"
            onKeyDown={e => e.key === 'Enter' && addVar()}
          />
          <button
            onClick={addVar}
            disabled={!newKey.trim()}
            className="text-xs px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded transition-colors disabled:opacity-40"
          >
            Add
          </button>
        </div>

        {vars.length === 0 && !newKey && (
          <p className="text-xs text-slate-400 py-2">No environment variables. Add variables here for use in skill scripts via $KEY.</p>
        )}
      </div>
    </div>
  )
}

function WechatCard({ sessionKey, binding, onRefresh }: { sessionKey: string; binding: import('../lib/api').WechatBinding | null; onRefresh: () => void }) {
  const [loading, setLoading] = useState(false)

  const handleUnbind = async () => {
    if (!confirm('确定解除微信绑定？')) return
    setLoading(true)
    try {
      await api.unbindWechat(sessionKey)
      onRefresh()
    } finally { setLoading(false) }
  }

  if (!binding) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <p className="text-xs text-slate-500 mb-1">WeChat</p>
        <p className="text-sm text-slate-400">未绑定</p>
      </div>
    )
  }

  return (
    <div className={`bg-white rounded-xl border border-slate-200 p-4 ${loading ? 'opacity-50' : ''}`}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs text-slate-500">WeChat</p>
        <button
          onClick={handleUnbind}
          disabled={loading}
          className="text-xs text-red-400 hover:text-red-600 transition-colors"
        >
          解绑
        </button>
      </div>
      <p className={`font-semibold text-sm ${binding.status === 'active' ? 'text-green-600' : 'text-slate-400'}`}>
        {binding.status === 'active' ? '已绑定' : '已断开'}
      </p>
      <p className="text-xs text-slate-400 font-mono truncate mt-0.5" title={binding.wechatUserId}>
        {binding.wechatUserId || '等待首条消息'}
      </p>
    </div>
  )
}

const AUTO_REPLY_OPTIONS = ['off', 'on', 'always'] as const

function AutoReplyCard({ sessionKey, initial }: { sessionKey: string; initial: string | null }) {
  const [value, setValue] = useState(initial || 'off')
  const [loading, setLoading] = useState(false)

  const cycle = async () => {
    const idx = AUTO_REPLY_OPTIONS.indexOf(value as any)
    const next = AUTO_REPLY_OPTIONS[(idx + 1) % AUTO_REPLY_OPTIONS.length]
    setLoading(true)
    try {
      await api.setSessionConfig(sessionKey, 'auto-reply', next === 'off' ? '' : next)
      setValue(next)
    } finally { setLoading(false) }
  }

  const colors: Record<string, string> = {
    off: 'text-slate-500',
    on: 'text-blue-600',
    always: 'text-green-600',
  }

  return (
    <div
      className={`bg-white rounded-xl border border-slate-200 p-4 cursor-pointer hover:border-slate-300 transition-colors ${loading ? 'opacity-50' : ''}`}
      onClick={cycle}
    >
      <p className="text-xs text-slate-500 mb-1">Auto Reply</p>
      <p className={`font-semibold text-sm ${colors[value] || ''}`}>{value}</p>
    </div>
  )
}

const MODEL_OPTIONS = [
  { value: 'sonnet', label: 'Sonnet 4.6 1M', desc: '默认，快速均衡' },
  { value: 'opus', label: 'Opus 4.7 1M', desc: '最强，复杂任务' },
  { value: 'haiku', label: 'Haiku 4.5 200K', desc: '最快，简单任务' },
] as const

// Normalize legacy model file values (opus[1m], opus 1m, claude-opus-4-7[1m], ...) to the 3 canonical aliases.
function normalizeModel(raw: string | null): string {
  if (!raw) return 'sonnet'
  const s = raw.toLowerCase()
  if (s.includes('opus')) return 'opus'
  if (s.includes('sonnet')) return 'sonnet'
  if (s.includes('haiku')) return 'haiku'
  return 'sonnet'
}

function ModelCard({ sessionKey, initial }: { sessionKey: string; initial: string | null }) {
  const [value, setValue] = useState(normalizeModel(initial))
  const [loading, setLoading] = useState(false)

  const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value
    setLoading(true)
    try {
      await api.setSessionConfig(sessionKey, 'model', next)
      setValue(next)
    } finally { setLoading(false) }
  }

  return (
    <div className={`bg-white rounded-xl border border-slate-200 p-4 ${loading ? 'opacity-50' : ''}`}>
      <p className="text-xs text-slate-500 mb-1">Model</p>
      <select
        value={value}
        onChange={handleChange}
        disabled={loading}
        className="font-semibold text-sm bg-transparent border-none outline-none cursor-pointer p-0 -ml-1 w-full"
      >
        {MODEL_OPTIONS.map(m => (
          <option key={m.value} value={m.value}>{m.label} — {m.desc}</option>
        ))}
      </select>
    </div>
  )
}

function CopyableText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex items-start gap-2">
      <code className="text-xs bg-slate-50 px-3 py-2 rounded font-mono text-slate-600 break-all flex-1 select-all">
        {text}
      </code>
      <button
        onClick={handleCopy}
        className="text-xs bg-slate-100 hover:bg-slate-200 text-slate-600 px-2.5 py-1.5 rounded shrink-0 transition-colors"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  )
}
