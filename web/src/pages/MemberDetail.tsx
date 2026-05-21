import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api, fetchApi, type Member } from '../lib/api'

export default function MemberDetail() {
  const { openId } = useParams<{ openId: string }>()
  const [member, setMember] = useState<Member | null>(null)
  const [memberMd, setMemberMd] = useState('')
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const [sessionNames, setSessionNames] = useState<Record<string, { name: string; type: string }>>({})

  useEffect(() => {
    if (!openId) return
    api.member(openId).then(m => {
      setMember(m)
      setMemberMd(m.memberMd || '')
      // Resolve session keys to display names
      if (m.sessions?.length) {
        fetchApi<Record<string, { name: string; type: string }>>(`/session-names?keys=${m.sessions.join(',')}`)
          .then(setSessionNames).catch(() => {})
      }
    })
  }, [openId])

  if (!openId || !member) return <p className="text-slate-400">Loading...</p>

  const toggleMute = async () => {
    await api.toggleMemberMute(openId, !member.muted)
    setMember({ ...member, muted: !member.muted })
  }

  const saveMd = async () => {
    await api.updateMemberMd(openId, editText)
    setMemberMd(editText)
    setEditing(false)
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <span className="w-10 h-10 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-lg font-bold">
          {member.name.charAt(0)}
        </span>
        <div>
          <h2 className="text-2xl font-bold">{member.name}</h2>
          <p className="text-xs text-slate-400 font-mono">{member.openId}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-slate-500">{member.muted ? 'Muted' : 'Active'}</span>
          <button
            onClick={toggleMute}
            className={`relative w-10 h-5 rounded-full transition-colors ${member.muted ? 'bg-slate-300' : 'bg-green-500'}`}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${member.muted ? 'left-0.5' : 'left-[22px]'}`} />
          </button>
        </div>
      </div>

      {/* Info Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <p className="text-xs text-slate-400">Sessions</p>
          <p className="text-xl font-bold">{member.sessions?.length || 0}</p>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <p className="text-xs text-slate-400">Feishu MCP</p>
          <p className="text-sm font-medium">{member.feishuMcpUrl ? 'Bound' : 'Not bound'}</p>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <p className="text-xs text-slate-400">Created</p>
          <p className="text-sm">{new Date(member.createdAt).toLocaleDateString()}</p>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <p className="text-xs text-slate-400">Updated</p>
          <p className="text-sm">{new Date(member.updatedAt).toLocaleDateString()}</p>
        </div>
      </div>

      {/* Sessions List */}
      {member.sessions && member.sessions.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-4 mb-6">
          <h3 className="text-sm font-semibold text-slate-600 mb-3">Associated Sessions</h3>
          <div className="flex flex-wrap gap-2">
            {member.sessions.map(s => (
              <Link key={s} to={`/session/${s}`}
                className="px-3 py-1.5 bg-slate-50 rounded-lg text-xs text-blue-600 hover:bg-blue-50 border border-slate-200">
                {sessionNames[s]?.name || s}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* MEMBER.md */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-600">MEMBER.md (User Profile)</h3>
          {!editing ? (
            <button onClick={() => { setEditText(memberMd); setEditing(true); }}
              className="px-3 py-1 text-xs bg-blue-50 text-blue-600 rounded hover:bg-blue-100">
              Edit
            </button>
          ) : (
            <div className="flex gap-2">
              <button onClick={saveMd} className="px-3 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600">Save</button>
              <button onClick={() => setEditing(false)} className="px-3 py-1 text-xs bg-slate-100 text-slate-600 rounded">Cancel</button>
            </div>
          )}
        </div>
        {editing ? (
          <textarea
            value={editText}
            onChange={e => setEditText(e.target.value)}
            className="w-full h-64 p-3 border border-slate-200 rounded-lg font-mono text-sm resize-y"
          />
        ) : (
          <pre className="whitespace-pre-wrap text-sm text-slate-700 bg-slate-50 rounded-lg p-4 max-h-96 overflow-y-auto">
            {memberMd || '(empty)'}
          </pre>
        )}
      </div>
    </div>
  )
}
