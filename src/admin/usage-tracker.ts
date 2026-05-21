import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';

interface UsageBucket {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface SessionUsage {
  name?: string;
  type?: string; // 'dm' | 'group'
  total: UsageBucket;
  hourly: Record<string, UsageBucket>; // "2026-03-30T10"
  daily: Record<string, UsageBucket>;  // "2026-03-30"
  weekly: Record<string, UsageBucket>; // "2026-W13"
  monthly: Record<string, UsageBucket>; // "2026-03"
}

interface UsageData {
  sessions: Record<string, SessionUsage>;
  globalHourly: Record<string, UsageBucket>;
  globalDaily: Record<string, UsageBucket>;
  globalWeekly: Record<string, UsageBucket>;
  globalMonthly: Record<string, UsageBucket>;
}

const FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const HOURLY_RETENTION_DAYS = 7;
const DAILY_RETENTION_DAYS = 90;
const WEEKLY_RETENTION_WEEKS = 52;

function emptyBucket(): UsageBucket {
  return { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

function addToBucket(bucket: UsageBucket, requests: number, inputTokens: number, outputTokens: number, costUsd: number): void {
  bucket.requests += requests;
  bucket.inputTokens += inputTokens;
  bucket.outputTokens += outputTokens;
  bucket.costUsd += costUsd;
}

function getTimeKeys(): { hour: string; day: string; week: string; month: string } {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const hour = pad(now.getHours());

  // ISO week number
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);

  return {
    hour: `${year}-${month}-${day}T${hour}`,
    day: `${year}-${month}-${day}`,
    week: `${year}-W${pad(weekNum)}`,
    month: `${year}-${month}`,
  };
}

export class UsageTracker {
  private data: UsageData;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private filePath: string;

  constructor(
    dataDir: string,
    private logger: Logger,
  ) {
    this.filePath = path.join(dataDir, 'usage-stats.json');
    this.data = this.load();
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  /**
   * Record a completed request's usage.
   */
  record(sessionKey: string, inputTokens: number, outputTokens: number, costUsd: number, sessionName?: string): void {
    const keys = getTimeKeys();

    // Ensure session entry
    if (!this.data.sessions[sessionKey]) {
      this.data.sessions[sessionKey] = {
        type: sessionKey.startsWith('dm_') ? 'dm' : sessionKey.startsWith('group_') ? 'group' : 'other',
        total: emptyBucket(),
        hourly: {},
        daily: {},
        weekly: {},
        monthly: {},
      };
    }
    const session = this.data.sessions[sessionKey];
    if (sessionName) session.name = sessionName;

    // Update session buckets
    addToBucket(session.total, 1, inputTokens, outputTokens, costUsd);
    if (!session.hourly[keys.hour]) session.hourly[keys.hour] = emptyBucket();
    addToBucket(session.hourly[keys.hour], 1, inputTokens, outputTokens, costUsd);
    if (!session.daily[keys.day]) session.daily[keys.day] = emptyBucket();
    addToBucket(session.daily[keys.day], 1, inputTokens, outputTokens, costUsd);
    if (!session.weekly[keys.week]) session.weekly[keys.week] = emptyBucket();
    addToBucket(session.weekly[keys.week], 1, inputTokens, outputTokens, costUsd);
    if (!session.monthly[keys.month]) session.monthly[keys.month] = emptyBucket();
    addToBucket(session.monthly[keys.month], 1, inputTokens, outputTokens, costUsd);

    // Update global buckets
    if (!this.data.globalHourly[keys.hour]) this.data.globalHourly[keys.hour] = emptyBucket();
    addToBucket(this.data.globalHourly[keys.hour], 1, inputTokens, outputTokens, costUsd);
    if (!this.data.globalDaily[keys.day]) this.data.globalDaily[keys.day] = emptyBucket();
    addToBucket(this.data.globalDaily[keys.day], 1, inputTokens, outputTokens, costUsd);
    if (!this.data.globalWeekly[keys.week]) this.data.globalWeekly[keys.week] = emptyBucket();
    addToBucket(this.data.globalWeekly[keys.week], 1, inputTokens, outputTokens, costUsd);
    if (!this.data.globalMonthly[keys.month]) this.data.globalMonthly[keys.month] = emptyBucket();
    addToBucket(this.data.globalMonthly[keys.month], 1, inputTokens, outputTokens, costUsd);

    this.dirty = true;
  }

  /**
   * Get usage data for API responses.
   */
  getData(): UsageData {
    return this.data;
  }

  /**
   * Get top sessions sorted by cost for a given period.
   */
  getTopSessions(period: 'daily' | 'weekly' | 'monthly' | 'total', limit: number = 10): Array<{ sessionKey: string; name?: string; type?: string; usage: UsageBucket }> {
    const keys = getTimeKeys();
    const periodKey = period === 'daily' ? keys.day : period === 'weekly' ? keys.week : period === 'monthly' ? keys.month : null;

    const entries: Array<{ sessionKey: string; name?: string; type?: string; usage: UsageBucket }> = [];
    for (const [key, session] of Object.entries(this.data.sessions)) {
      let usage: UsageBucket;
      if (periodKey && period !== 'total') {
        const buckets = session[period as 'hourly' | 'daily' | 'weekly' | 'monthly'];
        usage = buckets?.[periodKey] || emptyBucket();
      } else {
        usage = session.total;
      }
      if (usage.requests > 0) {
        entries.push({ sessionKey: key, name: session.name, type: session.type, usage });
      }
    }

    return entries.sort((a, b) => b.usage.costUsd - a.usage.costUsd).slice(0, limit);
  }

  flush(): void {
    if (!this.dirty) return;
    this.cleanup();
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
      this.dirty = false;
    } catch (err) {
      this.logger.warn({ err }, 'Failed to flush usage stats');
    }
  }

  destroy(): void {
    this.flush();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private load(): UsageData {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      }
    } catch { /* ignore */ }
    return {
      sessions: {},
      globalHourly: {},
      globalDaily: {},
      globalWeekly: {},
      globalMonthly: {},
    };
  }

  private cleanup(): void {
    const now = Date.now();
    const hourCutoff = now - HOURLY_RETENTION_DAYS * 24 * 3600 * 1000;
    const dayCutoff = now - DAILY_RETENTION_DAYS * 24 * 3600 * 1000;
    const weekCutoff = now - WEEKLY_RETENTION_WEEKS * 7 * 24 * 3600 * 1000;

    const isExpiredHour = (key: string) => new Date(key.replace('T', ' ') + ':00').getTime() < hourCutoff;
    const isExpiredDay = (key: string) => new Date(key).getTime() < dayCutoff;
    const isExpiredWeek = (key: string) => {
      const [y, w] = key.split('-W').map(Number);
      const d = new Date(y, 0, 1 + (w - 1) * 7);
      return d.getTime() < weekCutoff;
    };

    // Clean global
    for (const key of Object.keys(this.data.globalHourly)) {
      if (isExpiredHour(key)) delete this.data.globalHourly[key];
    }
    for (const key of Object.keys(this.data.globalDaily)) {
      if (isExpiredDay(key)) delete this.data.globalDaily[key];
    }
    for (const key of Object.keys(this.data.globalWeekly)) {
      if (isExpiredWeek(key)) delete this.data.globalWeekly[key];
    }

    // Clean per-session
    for (const session of Object.values(this.data.sessions)) {
      for (const key of Object.keys(session.hourly)) {
        if (isExpiredHour(key)) delete session.hourly[key];
      }
      for (const key of Object.keys(session.daily)) {
        if (isExpiredDay(key)) delete session.daily[key];
      }
      for (const key of Object.keys(session.weekly)) {
        if (isExpiredWeek(key)) delete session.weekly[key];
      }
    }
  }
}
