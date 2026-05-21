import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';
import type { ClaudeRunner } from '../claude/runner.js';
import type { SessionManager } from '../claude/session-manager.js';
import type { MessageSender } from '../feishu/message-sender.js';
import type { MessageBridge } from '../bridge/message-bridge.js';
import type { ResolvedSkill } from '../claude/mcp-manager.js';

interface ScheduledJob {
  skill: ResolvedSkill;
  intervalMs: number;
  timer: NodeJS.Timeout;
}

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastResult?: string;
  timezone?: string; // e.g. 'Asia/Shanghai', defaults to Asia/Shanghai
}

interface UserJobEntry {
  sessionKey: string;
  job: CronJob;
  timer: NodeJS.Timeout;
}

const JOBS_FILENAME = 'cron-jobs.json';
const SIGNAL_FILENAME = '.cron-changed';
const WATCH_INTERVAL_MS = 15_000; // Check for changes every 15 seconds

/**
 * Scheduler for both static skills (from mcp-config.json) and dynamic user cron jobs.
 *
 * Static skills: loaded once at start from mcp-config.json sharedSkills/sessionSkills.
 * User jobs: loaded from {sessionDir}/cron-jobs.json, watched for changes via signal files.
 */
export class CronRunner {
  private jobs = new Map<string, ScheduledJob>();       // Static skill jobs
  private userJobs = new Map<string, UserJobEntry>();   // User cron jobs (jobId → entry)
  private watchTimer: NodeJS.Timeout | null = null;

  private messageBridge?: MessageBridge;

  constructor(
    private runner: ClaudeRunner,
    private sessionMgr: SessionManager,
    private sender: MessageSender,
    private logger: Logger,
  ) {}

  /** Set MessageBridge reference for reply pipeline (called after bridge is created). */
  setMessageBridge(bridge: MessageBridge): void {
    this.messageBridge = bridge;
  }

  /**
   * Start scheduling all skills and user cron jobs
   */
  start(): void {
    // 1. Static skills from mcp-config.json
    this.startStaticSkills();

    // 2. Dynamic user cron jobs
    this.loadAllUserJobs();
    this.startWatching();
  }

  /**
   * Stop all scheduled jobs and watchers
   */
  stop(): void {
    // Stop static skill jobs
    for (const [, job] of this.jobs) {
      clearInterval(job.timer);
    }
    this.jobs.clear();

    // Stop user cron jobs
    for (const [, entry] of this.userJobs) {
      clearTimeout(entry.timer);
    }
    this.userJobs.clear();

    // Stop file watcher
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }

    this.logger.info('Cron scheduler stopped');
  }

  // ─── Static Skills (existing behavior) ──────────────────────────

  private startStaticSkills(): void {
    const mcpManager = this.sessionMgr.getMcpManager();
    const skills = mcpManager.getAllSkills();

    for (const skill of skills) {
      if (!skill.cron) continue;

      const intervalMs = parseCronToMs(skill.cron);
      if (!intervalMs) {
        this.logger.warn({ skill: skill.name, cron: skill.cron }, 'Invalid cron expression, skipping');
        continue;
      }

      const jobKey = skill.shared ? `shared:${skill.name}` : `${skill.sessionKey}:${skill.name}`;

      const timer = setInterval(() => {
        this.executeSkill(skill).catch((err) => {
          this.logger.error({ err, skill: skill.name }, 'Scheduled skill execution failed');
        });
      }, intervalMs);
      timer.unref();

      this.jobs.set(jobKey, { skill, intervalMs, timer });
      this.logger.info(
        { name: skill.name, shared: skill.shared, sessionKey: skill.sessionKey, intervalMs },
        'Scheduled skill',
      );
    }

    if (this.jobs.size > 0) {
      this.logger.info({ count: this.jobs.size }, 'Static skill scheduler started');
    }
  }

  private async executeSkill(skill: ResolvedSkill): Promise<void> {
    const sessionKey = skill.sessionKey || '_shared_scheduler';
    const chatId = skill.targetChatId || (skill.sessionKey ? sessionKeyToChatId(skill.sessionKey) : null);

    if (!chatId) {
      this.logger.warn({ skill: skill.name }, 'No chatId for scheduled skill, skipping');
      return;
    }

    this.logger.info({ skill: skill.name, sessionKey, chatId }, 'Executing scheduled skill');

    if (this.messageBridge) {
      await this.messageBridge.executeCronJob(sessionKey, chatId, skill.prompt, skill.name);
    } else {
      // Fallback if bridge not set yet (shouldn't happen)
      const session = this.sessionMgr.getOrCreate(sessionKey);
      const result = await this.runner.run({ sessionKey, message: skill.prompt, sessionDir: session.sessionDir });
      await this.sender.sendReply(chatId, `📋 **${skill.name}**\n\n${result.fullText || '(空结果)'}`);
    }
  }

  // ─── User Cron Jobs ─────────────────────────────────────────────

  /**
   * Load all user cron jobs from all session directories
   */
  private loadAllUserJobs(): void {
    const sessionsDir = this.sessionMgr.getSessionsDir();
    let entries: string[];
    try {
      entries = fs.readdirSync(sessionsDir);
    } catch {
      return;
    }

    let totalLoaded = 0;
    for (const entry of entries) {
      const sessionDir = path.join(sessionsDir, entry);
      const jobsFile = path.join(sessionDir, JOBS_FILENAME);
      if (!fs.existsSync(jobsFile)) continue;

      const count = this.loadSessionJobs(entry, sessionDir);
      totalLoaded += count;
    }

    if (totalLoaded > 0) {
      this.logger.info({ count: totalLoaded }, 'User cron jobs loaded');
    }
  }

  /**
   * Load jobs for a specific session, replacing any existing timers
   */
  private loadSessionJobs(sessionKey: string, sessionDir: string): number {
    // Clear existing jobs for this session
    for (const [jobId, entry] of this.userJobs) {
      if (entry.sessionKey === sessionKey) {
        clearTimeout(entry.timer);
        this.userJobs.delete(jobId);
      }
    }

    const jobsFile = path.join(sessionDir, JOBS_FILENAME);
    let jobs: CronJob[];
    try {
      jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf-8'));
    } catch (err) {
      this.logger.warn({ err, sessionKey }, 'Failed to parse cron-jobs.json');
      return 0;
    }

    let count = 0;
    for (const job of jobs) {
      if (!job.enabled) continue;

      const tz = job.timezone || 'Asia/Shanghai';
      const msUntilNext = computeNextRunMs(job.schedule, tz);
      if (msUntilNext === null) {
        this.logger.warn({ jobId: job.id, schedule: job.schedule }, 'Invalid schedule, skipping');
        continue;
      }

      this.scheduleUserJob(sessionKey, job, msUntilNext);
      count++;

      this.logger.info(
        { jobId: job.id, name: job.name, schedule: job.schedule, timezone: tz, nextRunMs: msUntilNext, sessionKey },
        'Scheduled user cron job',
      );
    }

    return count;
  }

  /**
   * Schedule a single user job with setTimeout, auto-reschedule after execution
   *
   * Robustness: We check the job's existence on disk TWICE:
   *   1. **Right before execution** — guards against orphan timers from a previous
   *      schedule cycle still firing after the job was removed from cron-jobs.json
   *      (e.g. user deletes the job + the hot-reload signal got lost / racey).
   *   2. **After execution, before reschedule** — same check, but cheaper because
   *      we already know the in-memory entry was current at exec time.
   *
   * Either check failing → drop the timer + delete the in-memory entry, so the
   * job stops cleanly without one more rogue execution.
   */
  private scheduleUserJob(sessionKey: string, job: CronJob, delayMs: number): void {
    const isStillScheduled = (): boolean => {
      if (!this.userJobs.has(job.id)) return false;
      const session = this.sessionMgr.getOrCreate(sessionKey);
      const jobsFile = path.join(session.sessionDir, JOBS_FILENAME);
      try {
        const jobs: CronJob[] = JSON.parse(fs.readFileSync(jobsFile, 'utf-8'));
        return jobs.some((j) => j.id === job.id && j.enabled);
      } catch {
        return false;
      }
    };

    const timer = setTimeout(() => {
      // (1) Pre-execution disk check — drops zombie timers whose job was removed
      // from cron-jobs.json after they were originally scheduled.
      if (!isStillScheduled()) {
        this.logger.info(
          { jobId: job.id, name: job.name, sessionKey },
          'Job no longer on disk at fire time, dropping zombie timer',
        );
        this.userJobs.delete(job.id);
        return;
      }
      this.executeUserJob(sessionKey, job).catch((err) => {
        this.logger.error({ err, jobId: job.id }, 'User cron job execution failed');
      }).finally(() => {
        // (2) Post-execution disk check — covers the case where the job was
        // removed during execution. Without this, finally() would reschedule it.
        if (!isStillScheduled()) {
          this.logger.info({ jobId: job.id, name: job.name }, 'Job removed from disk, stopping timer');
          this.userJobs.delete(job.id);
          return;
        }

        // Reschedule for next run
        const nextMs = computeNextRunMs(job.schedule, job.timezone || 'Asia/Shanghai');
        if (nextMs !== null) {
          this.scheduleUserJob(sessionKey, job, nextMs);
        }
      });
    }, delayMs);

    timer.unref();
    this.userJobs.set(job.id, { sessionKey, job, timer });
  }

  /**
   * Execute a user cron job: run Claude subprocess and send result to chat
   */
  private async executeUserJob(sessionKey: string, job: CronJob): Promise<void> {
    const session = this.sessionMgr.getOrCreate(sessionKey);

    // 1. Get chatId — CRITICAL for delivering results
    const chatIdFile = path.join(session.sessionDir, 'chat-id');
    let chatId: string;
    try {
      chatId = fs.readFileSync(chatIdFile, 'utf-8').trim();
    } catch {
      this.logger.error(
        { sessionKey, jobId: job.id, name: job.name },
        'No chat-id file found, cannot deliver cron job result',
      );
      return;
    }

    if (!chatId) {
      this.logger.error({ sessionKey, jobId: job.id }, 'Empty chat-id file');
      return;
    }

    this.logger.info(
      { jobId: job.id, name: job.name, sessionKey, chatId },
      'Executing user cron job',
    );

    try {
      if (this.messageBridge) {
        await this.messageBridge.executeCronJob(sessionKey, chatId, job.prompt, job.name);
      } else {
        // Fallback
        const result = await this.runner.run({ sessionKey, message: job.prompt, sessionDir: session.sessionDir });
        await this.sender.sendReply(chatId, `⏰ **${job.name}**\n\n${result.fullText || '(空结果)'}`, undefined, session.sessionDir, undefined, { sessionKey, chatId });
      }

      // Update job status
      this.updateJobStatus(session.sessionDir, job.id, {
        lastRunAt: new Date().toISOString(),
        lastResult: 'completed',
      });

      this.logger.info({ jobId: job.id, name: job.name }, 'User cron job completed');
    } catch (err) {
      this.logger.error({ err, jobId: job.id, name: job.name }, 'Failed to execute user cron job');
      try {
        await this.sender.sendReply(chatId, `⚠️ 定时任务 **${job.name}** 执行失败: ${(err as Error).message}`);
      } catch { /* ignore */ }
    }
  }

  /**
   * Update a job's status fields in cron-jobs.json (without triggering .cron-changed)
   */
  private updateJobStatus(
    sessionDir: string,
    jobId: string,
    updates: Partial<Pick<CronJob, 'lastRunAt' | 'lastResult'>>,
  ): void {
    const jobsFile = path.join(sessionDir, JOBS_FILENAME);
    try {
      const jobs: CronJob[] = JSON.parse(fs.readFileSync(jobsFile, 'utf-8'));
      const job = jobs.find((j) => j.id === jobId);
      if (job) {
        Object.assign(job, updates);
        fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
      }
    } catch (err) {
      this.logger.warn({ err, jobId }, 'Failed to update job status');
    }
  }

  // ─── File Watcher ───────────────────────────────────────────────

  /**
   * Watch for .cron-changed signal files to hot-reload jobs
   */
  private startWatching(): void {
    this.watchTimer = setInterval(() => {
      this.checkForChanges();
    }, WATCH_INTERVAL_MS);
    this.watchTimer.unref();
  }

  private checkForChanges(): void {
    const sessionsDir = this.sessionMgr.getSessionsDir();
    let entries: string[];
    try {
      entries = fs.readdirSync(sessionsDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const sessionDir = path.join(sessionsDir, entry);
      const signalFile = path.join(sessionDir, SIGNAL_FILENAME);

      if (fs.existsSync(signalFile)) {
        // Delete signal file first to avoid re-processing
        try {
          fs.unlinkSync(signalFile);
        } catch { /* ignore */ }

        this.logger.info({ sessionKey: entry }, 'Cron jobs changed, reloading');
        this.loadSessionJobs(entry, sessionDir);
      }
    }
  }
}

// ─── Schedule Parsing ─────────────────────────────────────────────

/**
 * Compute milliseconds until the next run for a given schedule.
 * Returns null if the schedule is invalid.
 * All time-based schedules use the specified timezone (default: Asia/Shanghai).
 */
function computeNextRunMs(schedule: string, tz: string = 'Asia/Shanghai'): number | null {
  // Shorthand interval: "30m", "2h", "1d", "30s"
  const shorthand = schedule.match(/^(\d+)(s|m|h|d)$/);
  if (shorthand) {
    const val = parseInt(shorthand[1], 10);
    switch (shorthand[2]) {
      case 's': return val * 1000;
      case 'm': return val * 60 * 1000;
      case 'h': return val * 60 * 60 * 1000;
      case 'd': return val * 24 * 60 * 60 * 1000;
    }
  }

  // English shorthand: "every 2h", "every 30m"
  const every = schedule.match(/^every\s+(\d+)(s|m|h|d)$/i);
  if (every) {
    const val = parseInt(every[1], 10);
    switch (every[2]) {
      case 's': return val * 1000;
      case 'm': return val * 60 * 1000;
      case 'h': return val * 60 * 60 * 1000;
      case 'd': return val * 24 * 60 * 60 * 1000;
    }
  }

  // Time point: "9:00", "14:30" (daily at specified time)
  const timePoint = schedule.match(/^(\d{1,2}):(\d{2})$/);
  if (timePoint) {
    const hour = parseInt(timePoint[1], 10);
    const minute = parseInt(timePoint[2], 10);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return msUntilNextTime(hour, minute, null, tz);
    }
  }

  // Standard cron: "*/N * * * *" (every N minutes)
  const everyNMin = schedule.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (everyNMin) {
    return parseInt(everyNMin[1], 10) * 60 * 1000;
  }

  // Standard cron: "0 */N * * *" (every N hours)
  const everyNHour = schedule.match(/^0\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
  if (everyNHour) {
    return parseInt(everyNHour[1], 10) * 60 * 60 * 1000;
  }

  // Standard cron: "M H * * *" (daily at H:M)
  const dailyCron = schedule.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/);
  if (dailyCron) {
    const minute = parseInt(dailyCron[1], 10);
    const hour = parseInt(dailyCron[2], 10);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return msUntilNextTime(hour, minute, null, tz);
    }
  }

  // Standard cron with day-of-week: "M H * * DOW"
  // DOW supports: single digit (0-6), range (1-5), comma-separated (1,3,5), * (any)
  const dowCron = schedule.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+([\d,\-]+)$/);
  if (dowCron) {
    const minute = parseInt(dowCron[1], 10);
    const hour = parseInt(dowCron[2], 10);
    const dowSpec = dowCron[3];
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      const allowedDays = parseDow(dowSpec);
      if (allowedDays) {
        return msUntilNextTime(hour, minute, allowedDays, tz);
      }
    }
  }

  return null;
}

/**
 * Parse day-of-week spec: "1-5", "0,6", "1,3,5", "0-6", single digit
 * Returns Set of allowed days (0=Sunday, 6=Saturday) or null if invalid.
 */
function parseDow(spec: string): Set<number> | null {
  const days = new Set<number>();
  for (const part of spec.split(',')) {
    const range = part.match(/^(\d)-(\d)$/);
    if (range) {
      const start = parseInt(range[1], 10);
      const end = parseInt(range[2], 10);
      if (start > 6 || end > 6) return null;
      for (let i = start; i <= end; i++) days.add(i);
    } else {
      const d = parseInt(part, 10);
      if (isNaN(d) || d > 6) return null;
      days.add(d);
    }
  }
  return days.size > 0 ? days : null;
}

/**
 * Calculate milliseconds from now until the next occurrence of HH:MM in the given timezone.
 * If allowedDays is provided, only schedules on those days (0=Sunday, 6=Saturday).
 */
function msUntilNextTime(
  hour: number,
  minute: number,
  allowedDays: Set<number> | null,
  tz: string = 'Asia/Shanghai',
): number {
  const now = new Date();

  // Get current date/time components in target timezone
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) => parseInt(parts.find((p) => p.type === type)!.value, 10);
  const nowH = get('hour') === 24 ? 0 : get('hour'); // midnight edge case
  const nowM = get('minute');
  const nowS = get('second');

  // Current ms since midnight in target timezone
  const nowMsSinceMidnight = (nowH * 3600 + nowM * 60 + nowS) * 1000;
  const targetMsSinceMidnight = (hour * 3600 + minute * 60) * 1000;

  // Get current day-of-week in target timezone
  const dowFormatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
  const dowStr = dowFormatter.format(now);
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const todayDow = dowMap[dowStr] ?? new Date().getDay();

  // Try today first, then up to 7 days ahead
  for (let daysAhead = 0; daysAhead <= 7; daysAhead++) {
    const candidateDow = (todayDow + daysAhead) % 7;

    // Check day-of-week constraint
    if (allowedDays && !allowedDays.has(candidateDow)) continue;

    // Check if time has already passed today
    if (daysAhead === 0 && targetMsSinceMidnight <= nowMsSinceMidnight) continue;

    const deltaMs = daysAhead * 24 * 3600 * 1000
      + (targetMsSinceMidnight - nowMsSinceMidnight);

    return deltaMs;
  }

  // Fallback: 24 hours (shouldn't happen with valid allowedDays)
  return 24 * 3600 * 1000;
}

/**
 * Parse simple cron expressions to millisecond intervals (legacy, for static skills).
 */
function parseCronToMs(cron: string): number | null {
  return computeNextRunMs(cron);
}

/**
 * Extract chatId from sessionKey for static skills.
 */
function sessionKeyToChatId(sessionKey: string): string | null {
  if (sessionKey.startsWith('group_')) {
    return sessionKey.slice(6);
  }
  return null;
}
