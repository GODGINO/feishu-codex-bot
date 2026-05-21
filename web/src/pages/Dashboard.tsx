import { useEffect, useState } from 'react'
import { Users, MessageSquare, Clock, Mail, Zap, Brain } from 'lucide-react'
import { api, type Stats } from '../lib/api'
import SwitcherPanel from '../components/SwitcherPanel'

function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: typeof Users; label: string; value: number | string; sub?: string; color: string
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 flex items-center gap-4">
      <div className={`w-11 h-11 rounded-lg flex items-center justify-center ${color}`}>
        <Icon size={20} className="text-white" />
      </div>
      <div>
        <p className="text-2xl font-bold">{value}</p>
        <p className="text-sm text-slate-500">{label}</p>
        {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null)
  useEffect(() => {
    api.stats().then(setStats)
  }, [])

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Dashboard</h2>

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard
            icon={Users}
            label="Sessions"
            value={stats.totalSessions}
            sub={`${stats.groupSessions} groups, ${stats.dmSessions} DMs`}
            color="bg-blue-500"
          />
          <StatCard
            icon={MessageSquare}
            label="Total Messages"
            value={stats.totalMessages}
            sub={`${stats.todayMessages} today`}
            color="bg-indigo-500"
          />
          <StatCard
            icon={Zap}
            label="Skills"
            value={stats.totalSkills}
            color="bg-green-500"
          />
          <StatCard
            icon={Brain}
            label="Memories"
            value={stats.totalObservations}
            color="bg-violet-500"
          />
          <StatCard
            icon={Clock}
            label="Cron Jobs"
            value={stats.totalCronJobs}
            color="bg-amber-500"
          />
          <StatCard
            icon={Mail}
            label="Email Accounts"
            value={stats.totalEmailAccounts}
            color="bg-purple-500"
          />
        </div>
      )}

      <SwitcherPanel />
    </div>
  )
}
