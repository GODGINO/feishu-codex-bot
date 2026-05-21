import { useEffect, useState } from 'react'
import { api, type ChatMessage } from '../lib/api'
import { formatDate, formatDateTime } from '../lib/utils'

export default function ChatHistory({ sessionKey, refreshKey }: { sessionKey: string; refreshKey?: number }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const limit = 50

  const loadHistory = () => {
    api.chat(sessionKey, page, limit).then(r => {
      setMessages(r.messages)
      setTotal(r.total)
    })
  }

  useEffect(() => { loadHistory() }, [sessionKey, page, refreshKey])

  const totalPages = Math.ceil(total / limit)

  const grouped = new Map<string, ChatMessage[]>()
  for (const msg of messages) {
    const dateKey = formatDate(msg.timestamp)
    const arr = grouped.get(dateKey) || []
    arr.push(msg)
    grouped.set(dateKey, arr)
  }

  return (
    <div className="space-y-6">
      {messages.length === 0 && (
        <p className="text-slate-400">No chat history</p>
      )}

      {Array.from(grouped.entries()).map(([date, msgs]) => (
        <div key={date}>
          <div className="sticky top-0 z-10 flex justify-center mb-3">
            <span className="bg-slate-100 text-slate-500 text-xs px-3 py-1 rounded-full">{date}</span>
          </div>
          <div className="space-y-3">
            {msgs.map((msg, i) => (
              <div key={i} className="bg-white rounded-xl border border-slate-200 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-medium text-sm text-blue-600">{msg.senderName}</span>
                  <span className="text-xs text-slate-400">{formatDateTime(msg.timestamp)}</span>
                </div>
                <p className="text-sm text-slate-700 whitespace-pre-wrap">{msg.text}</p>
                {msg.botReply && (
                  <div className="mt-3 pl-3 border-l-2 border-blue-200">
                    <p className="text-xs text-slate-400 mb-1">Bot Reply</p>
                    <p className="text-sm text-slate-600 whitespace-pre-wrap">{msg.botReply}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-4">
          <button
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
            className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
          >
            Previous
          </button>
          <span className="text-sm text-slate-500">
            Page {page} of {totalPages} ({total} messages)
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
            className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
