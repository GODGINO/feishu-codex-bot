import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { api, type SessionDetail as SessionDetailType } from '../lib/api'
import OverviewTab from '../components/OverviewTab'
import KnowledgeView from '../components/KnowledgeView'
import CronJobTable from '../components/CronJobTable'
import AlertTable from '../components/AlertTable'
import ChatHistory from '../components/ChatHistory'
import EmailView from '../components/EmailView'
import SkillsView from '../components/SkillsView'
import MemoryView from '../components/MemoryView'

const tabs = ['Overview', 'Skills', 'Knowledge', 'Cron Jobs', 'Alerts', 'Chat', 'Email', 'Memory'] as const
type Tab = typeof tabs[number]

export default function SessionDetail() {
  const { key } = useParams<{ key: string }>()
  const [session, setSession] = useState<SessionDetailType | null>(null)
  const [tab, setTab] = useState<Tab>('Overview')
  const [muted, setMuted] = useState(false)
  const [mutedLoading, setMutedLoading] = useState(false)

  useEffect(() => {
    if (key) {
      api.session(key).then(setSession)
      api.getSessionConfig(key, 'muted').then(v => setMuted(v === 'true')).catch(() => setMuted(false))
    }
  }, [key])

  const toggleMuted = async () => {
    if (!key || mutedLoading) return
    setMutedLoading(true)
    const newVal = !muted
    try {
      await api.setSessionConfig(key, 'muted', newVal ? 'true' : '')
      setMuted(newVal)
    } catch { /* ignore */ }
    setMutedLoading(false)
  }

  // Chat input state (lifted here so it lives inside the sticky header)
  const chatInputRef = useRef<HTMLInputElement>(null)
  const [chatInput, setChatInput] = useState('')
  const [chatEcho, setChatEcho] = useState(true)
  const [chatShowSource, setChatShowSource] = useState(true)
  const [chatSendAsSigma, setChatSendAsSigma] = useState(false)
  const [chatAddToContext, setChatAddToContext] = useState(true)
  const [chatSending, setChatSending] = useState(false)
  const [chatRefreshKey, setChatRefreshKey] = useState(0)

  const sendChat = useCallback(async () => {
    const text = chatInput.trim()
    if (!text || chatSending || !key) return
    setChatSending(true)
    setChatInput('')
    try {
      await api.sendAdminChat(key, text, chatSendAsSigma ? false : chatEcho, chatShowSource, chatSendAsSigma, chatAddToContext)
    } catch { /* ignore */ }
    setChatSending(false)
    setChatRefreshKey(k => k + 1)
  }, [chatInput, chatSending, chatEcho, chatShowSource, chatSendAsSigma, chatAddToContext, key])

  useEffect(() => {
    if (!chatSending) chatInputRef.current?.focus()
  }, [chatSending])

  if (!key) return null
  if (!session) return <p className="text-slate-400">Loading...</p>

  return (
    <div>
      <div className="sticky top-0 z-30 bg-slate-50 px-6 pt-6 pb-0">
        <div className="flex items-center gap-3 mb-4">
          <span className={`w-3 h-3 rounded-full ${session.type === 'group' ? 'bg-blue-500' : 'bg-green-500'}`} />
          <h2 className="text-2xl font-bold">{session.name}</h2>
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
            session.type === 'group' ? 'bg-blue-50 text-blue-700' : 'bg-green-50 text-green-700'
          }`}>
            {session.type === 'group' ? 'Group' : 'DM'}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-slate-500">{muted ? 'Muted' : 'Active'}</span>
            <button
              onClick={toggleMuted}
              disabled={mutedLoading}
              className={`relative w-10 h-5 rounded-full transition-colors ${muted ? 'bg-slate-300' : 'bg-green-500'}`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${muted ? 'left-0.5' : 'left-[22px]'}`} />
            </button>
          </div>
        </div>

        <div className="flex gap-1 border-b border-slate-200">
        {tabs.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
              tab === t
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t}
          </button>
        ))}
        </div>

        {tab === 'Chat' && (
          <div className="border-b border-slate-200 pb-3 pt-3">
            <div className="flex items-center gap-3 mb-1 flex-wrap">
              <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
                <input type="checkbox" checked={chatEcho} onChange={e => { setChatEcho(e.target.checked); if (e.target.checked) setChatSendAsSigma(false); }} className="rounded border-slate-300" />
                Echo to Feishu / WeChat
              </label>
              {chatEcho && !chatSendAsSigma && (
                <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
                  <input type="checkbox" checked={chatShowSource} onChange={e => setChatShowSource(e.target.checked)} className="rounded border-slate-300" />
                  Show [ECHO] source
                </label>
              )}
            </div>
            <div className="flex items-center gap-3 mb-2 flex-wrap">
              <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
                <input type="checkbox" checked={chatSendAsSigma} onChange={e => { setChatSendAsSigma(e.target.checked); if (e.target.checked) setChatEcho(false); }} className="rounded border-slate-300" />
                Send as Sigma
              </label>
              {chatSendAsSigma && (
                <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
                  <input type="checkbox" checked={chatAddToContext} onChange={e => setChatAddToContext(e.target.checked)} className="rounded border-slate-300" />
                  Add to context
                </label>
              )}
            </div>
            <div className="flex gap-2">
              <input
                ref={chatInputRef}
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() } }}
                placeholder="Send a message to Claude..."
                disabled={chatSending}
                className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400 disabled:opacity-50 disabled:bg-slate-50"
              />
              <button
                onClick={sendChat}
                disabled={!chatInput.trim() || chatSending}
                className="px-4 py-2 bg-blue-500 text-white text-sm font-medium rounded-lg hover:bg-blue-600 disabled:opacity-40 transition-colors"
              >
                {chatSending ? '...' : 'Send'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="px-6 mt-4">
      {tab === 'Overview' && <OverviewTab session={session} sessionKey={key} onRefresh={() => api.session(key).then(setSession)} />}
      {tab === 'Skills' && <SkillsView sessionKey={key} />}
      {tab === 'Knowledge' && <KnowledgeView sessionKey={key} />}
      {tab === 'Cron Jobs' && <CronJobTable sessionKey={key} />}
      {tab === 'Alerts' && <AlertTable sessionKey={key} />}
      {tab === 'Chat' && <ChatHistory sessionKey={key} refreshKey={chatRefreshKey} />}
      {tab === 'Email' && <EmailView sessionKey={key} />}
      {tab === 'Memory' && <MemoryView sessionKey={key} />}
      </div>
    </div>
  )
}
