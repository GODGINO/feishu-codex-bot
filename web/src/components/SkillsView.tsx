import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { api, type Skill } from '../lib/api'
import ConfirmDialog from './ConfirmDialog'
import TransferModal from './TransferModal'

export default function SkillsView({ sessionKey }: { sessionKey: string }) {
  const [skills, setSkills] = useState<Skill[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Skill | null>(null)
  const [transferSkill, setTransferSkill] = useState<Skill | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = () => api.skills(sessionKey).then(setSkills)

  useEffect(() => { refresh() }, [sessionKey])

  const handleDelete = async () => {
    if (!confirmDelete) return
    setLoading(true)
    try {
      await api.deleteSkill(sessionKey, confirmDelete.folder)
      setConfirmDelete(null)
      refresh()
    } finally { setLoading(false) }
  }

  const handleToggle = async (skill: Skill) => {
    await api.toggleSkill(sessionKey, skill.folder, !skill.disabled)
    refresh()
  }

  const handleTransfer = async (targetSession: string, transferEnvVars: boolean) => {
    if (!transferSkill) return
    setLoading(true)
    try {
      await api.transferSkill(sessionKey, transferSkill.folder, targetSession, transferEnvVars)
      setTransferSkill(null)
    } finally { setLoading(false) }
  }

  if (skills.length === 0) {
    return <p className="text-slate-400 text-sm">No skills configured</p>
  }

  const builtinSkills = skills.filter(s => s.builtin)
  const customSkills = skills.filter(s => !s.builtin)

  const renderSkill = (skill: Skill) => (
    <div key={skill.folder} className={`border border-slate-200 rounded-lg overflow-hidden ${skill.disabled ? 'opacity-60' : ''}`}>
      <div className="flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors">
        <button
          onClick={() => setExpanded(expanded === skill.folder ? null : skill.folder)}
          className="flex items-center gap-3 text-left flex-1 min-w-0"
        >
          <span className={`w-2 h-2 rounded-full shrink-0 ${skill.disabled ? 'bg-slate-300' : 'bg-indigo-400'}`} />
          <span className="font-medium text-sm">{skill.name}</span>
          {skill.disabled && (
            <span className="text-xs bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">Disabled</span>
          )}
          {skill.envVars.length > 0 && (
            <span className="text-xs bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded">
              {skill.envVars.length} env
            </span>
          )}
          {skill.description && (
            <span className="text-xs text-slate-400 truncate max-w-md">{skill.description}</span>
          )}
        </button>
        {!skill.builtin && (
          <div className="flex items-center gap-1.5 shrink-0 ml-3">
            <button
              onClick={() => handleToggle(skill)}
              className="text-xs px-2 py-1 rounded hover:bg-slate-100 text-slate-500 transition-colors"
            >
              {skill.disabled ? 'Enable' : 'Disable'}
            </button>
            <button
              onClick={() => setTransferSkill(skill)}
              className="text-xs px-2 py-1 rounded hover:bg-blue-50 text-blue-500 transition-colors"
            >
              Transfer
            </button>
            <button
              onClick={() => setConfirmDelete(skill)}
              className="text-xs px-2 py-1 rounded hover:bg-red-50 text-red-500 transition-colors"
            >
              Delete
            </button>
            <span className="text-slate-300 mx-1">|</span>
            <button
              onClick={() => setExpanded(expanded === skill.folder ? null : skill.folder)}
              className="text-slate-400 text-xs"
            >
              {expanded === skill.folder ? '收起' : '展开'}
            </button>
          </div>
        )}
        {skill.builtin && (
          <button
            onClick={() => setExpanded(expanded === skill.folder ? null : skill.folder)}
            className="text-slate-400 text-xs shrink-0 ml-3"
          >
            {expanded === skill.folder ? '收起' : '展开'}
          </button>
        )}
      </div>
      {expanded === skill.folder && (
        <div className="px-4 pb-4 border-t border-slate-100">
          {skill.envVars.length > 0 && (
            <div className="mt-3 mb-2 flex items-center gap-2 flex-wrap">
              <span className="text-xs text-slate-500">Env:</span>
              {skill.envVars.map(v => (
                <code key={v} className="text-xs bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded font-mono">${v}</code>
              ))}
            </div>
          )}
          <div className="prose prose-sm prose-slate max-w-none mt-3">
            <ReactMarkdown>{skill.content}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )

  return (
    <>
      <div className="space-y-6">
        {customSkills.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <h3 className="text-sm font-semibold text-slate-700">Custom Skills</h3>
              <span className="text-xs bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded">{customSkills.length}</span>
            </div>
            <div className="space-y-3">{customSkills.map(renderSkill)}</div>
          </div>
        )}
        {builtinSkills.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <h3 className="text-sm font-semibold text-slate-700">Built-in Skills</h3>
              <span className="text-xs bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">{builtinSkills.length}</span>
            </div>
            <div className="space-y-3">{builtinSkills.map(renderSkill)}</div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Skill"
        message={`Are you sure you want to delete "${confirmDelete?.name}"? This cannot be undone.`}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(null)}
        loading={loading}
      />

      <TransferModal
        open={!!transferSkill}
        title={`Transfer "${transferSkill?.name}"`}
        currentSession={sessionKey}
        envVars={transferSkill?.envVars}
        onTransfer={handleTransfer}
        onCancel={() => setTransferSkill(null)}
        loading={loading}
      />
    </>
  )
}
