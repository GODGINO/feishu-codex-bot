import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Member } from '../lib/api'

export default function MemberList() {
  const [members, setMembers] = useState<Member[]>([])
  const [search, setSearch] = useState('')

  useEffect(() => { api.members().then(setMembers) }, [])

  const filtered = members.filter(m =>
    m.name.toLowerCase().includes(search.toLowerCase()) ||
    m.openId.includes(search)
  )

  const toggleMute = async (openId: string, muted: boolean) => {
    await api.toggleMemberMute(openId, muted)
    setMembers(prev => prev.map(m => m.openId === openId ? { ...m, muted } : m))
  }

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Members</h2>

      <input
        type="text"
        placeholder="Search by name or ID..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="w-full max-w-md px-3 py-2 border border-slate-200 rounded-lg mb-4 text-sm"
      />

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th className="text-left px-4 py-3 font-medium text-slate-500">Name</th>
              <th className="text-left px-4 py-3 font-medium text-slate-500">Open ID</th>
              <th className="text-center px-4 py-3 font-medium text-slate-500">Sessions</th>
              <th className="text-center px-4 py-3 font-medium text-slate-500">MCP</th>
              <th className="text-center px-4 py-3 font-medium text-slate-500">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(m => (
              <tr key={m.openId} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link to={`/members/${m.openId}`} className="text-blue-600 hover:underline font-medium">
                    {m.name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-slate-400 font-mono text-xs">{m.openId.slice(0, 20)}...</td>
                <td className="text-center px-4 py-3">{m.sessions?.length || 0}</td>
                <td className="text-center px-4 py-3">
                  {m.feishuMcpUrl ? <span className="text-green-600">Bound</span> : <span className="text-slate-300">—</span>}
                </td>
                <td className="text-center px-4 py-3">
                  <button
                    onClick={() => toggleMute(m.openId, !m.muted)}
                    className={`px-2 py-0.5 rounded text-xs font-medium ${m.muted ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600'}`}
                  >
                    {m.muted ? 'Muted' : 'Active'}
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={5} className="text-center py-8 text-slate-400">No members found</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
