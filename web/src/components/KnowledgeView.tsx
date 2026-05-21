import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import { api } from '../lib/api'

export default function KnowledgeView({ sessionKey }: { sessionKey: string }) {
  const [content, setContent] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')

  useEffect(() => {
    api.knowledge(sessionKey).then(r => setContent(r.content))
  }, [sessionKey])

  const save = async () => {
    await api.updateKnowledge(sessionKey, editText)
    setContent(editText)
    setEditing(false)
  }

  if (content === null) return <p className="text-slate-400">Loading...</p>

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-slate-700">CLAUDE.md (Knowledge Base)</h3>
        {!editing ? (
          <button onClick={() => { setEditText(content || ''); setEditing(true); }}
            className="px-3 py-1 text-xs text-blue-600 border border-blue-200 rounded hover:bg-blue-50">
            Edit
          </button>
        ) : (
          <div className="flex gap-2">
            <button onClick={save} className="px-3 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600">Save</button>
            <button onClick={() => setEditing(false)} className="px-3 py-1 text-xs bg-slate-100 text-slate-600 rounded">Cancel</button>
          </div>
        )}
      </div>
      {editing ? (
        <textarea
          value={editText}
          onChange={e => setEditText(e.target.value)}
          className="w-full h-96 font-mono text-sm p-3 border border-slate-200 rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-blue-200"
        />
      ) : !content ? (
        <p className="text-slate-400">(empty)</p>
      ) : (
        <div className="prose prose-sm prose-slate max-w-none
          prose-headings:font-semibold
          prose-h1:text-xl prose-h2:text-lg prose-h3:text-base
          prose-code:bg-slate-100 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-sm
          prose-pre:bg-slate-900 prose-pre:text-slate-100
          prose-a:text-blue-600
          prose-table:text-sm
          prose-th:bg-slate-50 prose-th:px-3 prose-th:py-2
          prose-td:px-3 prose-td:py-2
        ">
          <Markdown>{content}</Markdown>
        </div>
      )}
    </div>
  )
}
