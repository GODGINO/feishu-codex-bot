import { Routes, Route, NavLink, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { LayoutDashboard, LogOut, Users } from 'lucide-react'
import { api, type SessionSummary } from './lib/api'
import { formatTime } from './lib/utils'
import Dashboard from './pages/Dashboard'
import SessionDetail from './pages/SessionDetail'
import MemberList from './pages/MemberList'
import MemberDetail from './pages/MemberDetail'
import BlogList from './pages/BlogList'

function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const ok = await api.login(password, password2)
    setLoading(false)
    if (ok) {
      onLogin()
    } else {
      setError('密码错误')
    }
  }

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center">
      <form onSubmit={handleSubmit} className="bg-white rounded-xl shadow-lg p-8 w-80">
        <h1 className="text-xl font-bold text-slate-800 mb-1">Sigma Admin</h1>
        <p className="text-sm text-slate-400 mb-6">请输入管理密码</p>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Password 1"
          autoFocus
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm mb-3 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
        />
        <input
          type="password"
          value={password2}
          onChange={e => setPassword2(e.target.value)}
          placeholder="Password 2"
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm mb-3 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
        />
        {error && <p className="text-red-500 text-xs mb-3">{error}</p>}
        <button
          type="submit"
          disabled={loading || !password || !password2}
          className="w-full py-2 bg-blue-500 text-white rounded-lg text-sm font-medium hover:bg-blue-600 disabled:opacity-50 transition-colors"
        >
          {loading ? '...' : '登录'}
        </button>
      </form>
    </div>
  )
}

function Sidebar({ onLogout }: { onLogout: () => void }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])

  useEffect(() => {
    // Refresh name caches first, then load sessions with updated names
    api.refreshNames().catch(() => {}).then(() => api.sessions()).then(setSessions)
  }, [])

  const navClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm transition-colors ${
      isActive
        ? 'bg-white/15 text-white font-medium'
        : 'text-slate-300 hover:bg-white/10 hover:text-white'
    }`

  const sessionClass = ({ isActive }: { isActive: boolean }) =>
    `block px-3 py-2 rounded-lg text-xs transition-colors truncate ${
      isActive
        ? 'bg-white/15 text-white font-medium'
        : 'text-slate-400 hover:bg-white/10 hover:text-slate-200'
    }`

  return (
    <aside className="w-60 bg-slate-800 h-screen flex flex-col shrink-0 overflow-y-auto">
      <div className="px-5 py-5 border-b border-white/10 shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-white tracking-tight">Sigma Admin</h1>
            <p className="text-xs text-slate-400 mt-0.5">Feishu Claude Bot</p>
          </div>
          <button
            onClick={async () => { await api.logout(); onLogout() }}
            className="text-slate-400 hover:text-white transition-colors p-1"
            title="退出登录"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>

      <nav className="flex flex-col gap-1 p-3 shrink-0">
        <NavLink to="/" end className={navClass}>
          <LayoutDashboard size={18} />
          Dashboard
        </NavLink>
        <NavLink to="/members" className={navClass}>
          <Users size={18} />
          Members
        </NavLink>
      </nav>

      <div className="px-3 mt-1 pb-4 flex flex-col gap-0.5">
        {sessions.map(s => (
          <NavLink key={s.key} to={`/session/${s.key}`} className={sessionClass} title={s.name}>
            <div className="flex items-center justify-between gap-1.5">
              <span className="truncate">{s.name}</span>
              <span className={`shrink-0 text-[9px] px-1 rounded ${
                s.type === 'group'
                  ? 'bg-blue-500/20 text-blue-300'
                  : 'bg-green-500/20 text-green-300'
              }`}>
                {s.type === 'group' ? '群' : '私'}
              </span>
            </div>
            {s.lastActiveAt && (
              <p className="text-[10px] text-slate-500 mt-0.5">{formatTime(s.lastActiveAt)}</p>
            )}
          </NavLink>
        ))}
      </div>
    </aside>
  )
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const location = useLocation()

  useEffect(() => {
    // Blog route is public — no auth needed
    if (location.pathname.startsWith('/blog')) return
    api.authCheck().then(setAuthed)
  }, [location.pathname])

  // Blog route: no login required
  if (location.pathname.startsWith('/blog')) {
    return (
      <Routes>
        <Route path="/blog" element={<BlogList />} />
      </Routes>
    )
  }

  if (authed === null) return null // loading
  if (!authed) return <LoginPage onLogin={() => setAuthed(true)} />

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar onLogout={() => setAuthed(false)} />
      <main className="flex-1 overflow-y-auto">
        <Routes>
          <Route path="/session/:key" element={<SessionDetail />} />
          <Route path="/" element={<div className="p-6"><Dashboard /></div>} />
          <Route path="/members" element={<div className="p-6"><MemberList /></div>} />
          <Route path="/members/:openId" element={<div className="p-6"><MemberDetail /></div>} />
          <Route path="/blog" element={<div className="p-6"><BlogList /></div>} />
        </Routes>
      </main>
    </div>
  )
}
