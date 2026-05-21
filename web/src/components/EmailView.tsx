import { useEffect, useState } from 'react'
import { api, type EmailInfo } from '../lib/api'

export default function EmailView({ sessionKey }: { sessionKey: string }) {
  const [info, setInfo] = useState<EmailInfo | null>(null)

  useEffect(() => {
    api.email(sessionKey).then(setInfo)
  }, [sessionKey])

  if (!info) return <p className="text-slate-400">Loading...</p>
  if (!info.configured) return <p className="text-slate-400">No email accounts configured</p>

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <h3 className="font-semibold mb-3">Email Configuration</h3>
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span>Email accounts configured</span>
          </div>
          {info.pushTarget && (
            <div className="text-slate-500">
              Push target: <code className="bg-slate-100 px-1 py-0.5 rounded text-xs">{JSON.stringify(info.pushTarget)}</code>
            </div>
          )}
        </div>
      </div>

      {info.rules && (
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h3 className="font-semibold mb-3">Email Rules</h3>
          <pre className="text-sm text-slate-600 whitespace-pre-wrap bg-slate-50 p-4 rounded-lg">{info.rules}</pre>
        </div>
      )}
    </div>
  )
}
