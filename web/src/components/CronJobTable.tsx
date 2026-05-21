import { useEffect, useState } from 'react'
import { api, type CronJob } from '../lib/api'
import ConfirmDialog from './ConfirmDialog'

export default function CronJobTable({ sessionKey }: { sessionKey: string }) {
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [confirmDelete, setConfirmDelete] = useState<CronJob | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = () => api.cron(sessionKey).then(setJobs)

  useEffect(() => { refresh() }, [sessionKey])

  const handleToggle = async (job: CronJob) => {
    await api.toggleCronJob(sessionKey, job.id, !job.enabled)
    refresh()
  }

  const handleDelete = async () => {
    if (!confirmDelete) return
    setLoading(true)
    try {
      await api.deleteCronJob(sessionKey, confirmDelete.id)
      setConfirmDelete(null)
      refresh()
    } finally { setLoading(false) }
  }

  if (jobs.length === 0) {
    return <p className="text-slate-400">No cron jobs configured</p>
  }

  return (
    <>
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th className="text-left px-5 py-3 font-medium text-slate-600">Name</th>
              <th className="text-left px-5 py-3 font-medium text-slate-600">Schedule</th>
              <th className="text-center px-5 py-3 font-medium text-slate-600">Status</th>
              <th className="text-left px-5 py-3 font-medium text-slate-600">Last Run</th>
              <th className="text-left px-5 py-3 font-medium text-slate-600">Last Result</th>
              <th className="text-right px-5 py-3 font-medium text-slate-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {jobs.map(job => (
              <tr key={job.id} className="hover:bg-slate-50">
                <td className="px-5 py-3">
                  <p className="font-medium">{job.name}</p>
                  <p className="text-xs text-slate-400 mt-0.5 line-clamp-1">{job.prompt}</p>
                </td>
                <td className="px-5 py-3">
                  <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded">{job.schedule}</code>
                </td>
                <td className="px-5 py-3 text-center">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                    job.enabled
                      ? 'bg-green-50 text-green-700'
                      : 'bg-slate-100 text-slate-500'
                  }`}>
                    {job.enabled ? 'Active' : 'Disabled'}
                  </span>
                </td>
                <td className="px-5 py-3 text-slate-500 text-xs">
                  {job.lastRunAt ? new Date(job.lastRunAt).toLocaleString('zh-CN') : '-'}
                </td>
                <td className="px-5 py-3">
                  {job.lastResult ? (
                    <p className="text-xs text-slate-500 line-clamp-2 max-w-xs">{job.lastResult}</p>
                  ) : (
                    <span className="text-xs text-slate-400">-</span>
                  )}
                </td>
                <td className="px-5 py-3 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      onClick={() => handleToggle(job)}
                      className="text-xs px-2 py-1 rounded hover:bg-slate-100 text-slate-500 transition-colors"
                    >
                      {job.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      onClick={() => setConfirmDelete(job)}
                      className="text-xs px-2 py-1 rounded hover:bg-red-50 text-red-500 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Cron Job"
        message={`Are you sure you want to delete "${confirmDelete?.name}"?`}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(null)}
        loading={loading}
      />
    </>
  )
}
