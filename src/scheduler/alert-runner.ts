import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import type { Logger } from '../utils/logger.js';
import type { ClaudeRunner } from '../claude/runner.js';
import type { SessionManager } from '../claude/session-manager.js';
import type { MessageSender } from '../feishu/message-sender.js';
import type { MessageBridge } from '../bridge/message-bridge.js';

/**
 * Alert v2 — condition-triggered job runner.
 *
 * Sister to CronRunner. Where Cron triggers on time, Alert triggers when a
 * `check_command` shell script returns exit 0 + non-empty JSON array stdout.
 *
 * Two alert types:
 *   - one_shot:  trigger once when condition met, then auto-disable
 *   - watcher:   keep polling forever; each new event triggers, state advances
 *
 * Three execution modes:
 *   - claude:        spawn Claude with rendered prompt (most powerful, uses tokens)
 *   - shell:         exec another shell command (zero token, scripted action)
 *   - message_only:  send rendered prompt as plain feishu message (zero token, simple notify)
 *
 * State design (the "v2 三件套"):
 *   watermark.last_pubdate:  timestamp watermark (filter old events)
 *   watermark.processed_ids: dedup set (handles repeats + retries)
 *   max_processed_size:      FIFO cap to prevent unbounded growth
 *
 * State updates only on successful trigger. Failed triggers retry next poll.
 *
 * See: shared/sigma-alert-plan.md (chapters 七-十二)
 */

interface AlertWatermark {
  last_pubdate: number;
  processed_ids: string[];
  max_processed_size?: number;
}

interface AlertStats {
  polls: number;
  triggers: number;
  failures: number;
  last_poll?: string;
  last_trigger?: string;
  // Silent failures: check_command exited !=0 (script bug, dependency missing,
  // network blip). Tracked separately from `failures` (which counts trigger
  // execution failures) so transient-friendly retry doesn't mask permanent bugs.
  silent_failures?: number;
  last_silent_stderr?: string;
  silent_diagnostic_sent_at_count?: number;
}

interface Alert {
  id: string;
  name: string;
  type: 'one_shot' | 'watcher';
  enabled: boolean;
  // Two scheduling modes — exactly one must be set:
  //   interval_seconds : poll every N seconds, around the clock (legacy)
  //   schedule         : 5-field cron expression in `schedule_tz` (default Asia/Shanghai),
  //                      e.g. "*/10 11-17 * * *" = every 10 min, 11:00-17:50, every day.
  //                      Cron form natively supports time-of-day windows and weekday filters,
  //                      so dead hours produce no fire times at all (no wasted polls).
  interval_seconds?: number;
  schedule?: string;
  schedule_tz?: string;
  check_command: string;            // sh script to run; outputs JSON array of new items
  prompt: string;                   // template, supports {{NEW_ID}} {{NEW_TITLE}} etc.
  execution_mode: 'claude' | 'shell' | 'message_only';
  trigger_command?: string;         // for execution_mode=shell: command to exec on trigger
  state: { watermark: AlertWatermark; stats: AlertStats };
  max_runtime_days?: number;        // watcher auto-disable after N days (default 30, 0=never)
  createdAt: string;
}

interface NewItem {
  NEW_ID: string;
  NEW_PUBDATE: number;
  [key: string]: any;               // any other fields used in prompt template
}

interface UserAlertEntry {
  sessionKey: string;
  alert: Alert;
  timer: NodeJS.Timeout;
}

const ALERTS_FILENAME = 'alerts.json';
const SIGNAL_FILENAME = '.alerts-changed';
const WATCH_INTERVAL_MS = 15_000;
const DEFAULT_PROCESSED_SIZE = 200;
const DEFAULT_MAX_RUNTIME_DAYS = 30;
const CONSECUTIVE_FAILURE_THRESHOLD = 5;
const CHECK_TIMEOUT_MS = 30_000;
// When check_command keeps exiting !=0 (silent failure), notify the user
// once at this count so a permanent script bug isn't invisible.
const SILENT_FAILURE_DIAGNOSTIC_AT = 5;

export class AlertRunner {
  private alerts = new Map<string, UserAlertEntry>();
  private watchTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = new Map<string, number>();

  private messageBridge?: MessageBridge;

  constructor(
    private runner: ClaudeRunner,
    private sessionMgr: SessionManager,
    private sender: MessageSender,
    private logger: Logger,
  ) {}

  setMessageBridge(bridge: MessageBridge): void {
    this.messageBridge = bridge;
  }

  start(): void {
    this.loadAllAlerts();
    this.startWatching();
  }

  stop(): void {
    for (const [, entry] of this.alerts) clearTimeout(entry.timer);
    this.alerts.clear();
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    this.logger.info('Alert scheduler stopped');
  }

  // ─── Loading ──────────────────────────────────────────────────────

  private loadAllAlerts(): void {
    const sessionsDir = this.sessionMgr.getSessionsDir();
    let entries: string[];
    try { entries = fs.readdirSync(sessionsDir); } catch { return; }

    let total = 0;
    for (const entry of entries) {
      const sessionDir = path.join(sessionsDir, entry);
      const alertsFile = path.join(sessionDir, ALERTS_FILENAME);
      if (!fs.existsSync(alertsFile)) continue;
      total += this.loadSessionAlerts(entry, sessionDir);
    }

    if (total > 0) this.logger.info({ count: total }, 'User alerts loaded');
  }

  private loadSessionAlerts(sessionKey: string, sessionDir: string): number {
    // Clear existing alerts for this session
    for (const [id, entry] of this.alerts) {
      if (entry.sessionKey === sessionKey) {
        clearTimeout(entry.timer);
        this.alerts.delete(id);
      }
    }

    const alertsFile = path.join(sessionDir, ALERTS_FILENAME);
    let alerts: Alert[];
    try {
      alerts = JSON.parse(fs.readFileSync(alertsFile, 'utf-8'));
    } catch (err) {
      this.logger.warn({ err, sessionKey }, 'Failed to parse alerts.json');
      return 0;
    }

    let count = 0;
    for (const alert of alerts) {
      if (!alert.enabled) continue;

      // Auto-disable watchers past max_runtime_days
      const maxDays = alert.max_runtime_days ?? DEFAULT_MAX_RUNTIME_DAYS;
      if (alert.type === 'watcher' && maxDays > 0) {
        const ageMs = Date.now() - new Date(alert.createdAt).getTime();
        if (ageMs > maxDays * 24 * 60 * 60 * 1000) {
          this.logger.info({ alertId: alert.id, name: alert.name, maxDays }, 'Watcher exceeded max_runtime_days, auto-disable');
          this.disableAlert(sessionDir, alert.id);
          continue;
        }
      }

      const delayMs = computeDelayMs(alert);
      if (delayMs == null) {
        this.logger.warn(
          { alertId: alert.id, name: alert.name, schedule: alert.schedule, interval: alert.interval_seconds },
          'Alert has no valid schedule/interval, skipped',
        );
        continue;
      }
      this.scheduleAlert(sessionKey, alert, delayMs);
      count++;

      this.logger.info(
        { alertId: alert.id, name: alert.name, type: alert.type, delayMs, schedule: alert.schedule, interval: alert.interval_seconds, sessionKey },
        'Scheduled alert',
      );
    }

    return count;
  }

  // ─── Scheduling ───────────────────────────────────────────────────

  private scheduleAlert(sessionKey: string, alert: Alert, delayMs: number): void {
    const timer = setTimeout(() => {
      this.pollAlert(sessionKey, alert).catch((err) => {
        this.logger.error({ err, alertId: alert.id }, 'Alert poll failed');
      }).finally(() => {
        // Verify alert still exists on disk
        if (!this.alerts.has(alert.id)) return;
        const session = this.sessionMgr.getOrCreate(sessionKey);
        const alertsFile = path.join(session.sessionDir, ALERTS_FILENAME);
        try {
          const alerts: Alert[] = JSON.parse(fs.readFileSync(alertsFile, 'utf-8'));
          const cur = alerts.find((a) => a.id === alert.id);
          if (!cur || !cur.enabled) {
            this.logger.info({ alertId: alert.id, name: alert.name }, 'Alert removed/disabled, stopping timer');
            this.alerts.delete(alert.id);
            return;
          }
          // Watchers reschedule indefinitely; one_shot is disabled in pollAlert after success
          if (cur.type === 'watcher') {
            const nextDelayMs = computeDelayMs(cur);
            if (nextDelayMs == null) {
              this.logger.warn({ alertId: cur.id }, 'No valid schedule for reschedule, stopping timer');
              this.alerts.delete(cur.id);
              return;
            }
            this.scheduleAlert(sessionKey, cur, nextDelayMs);
          }
        } catch {
          this.alerts.delete(alert.id);
        }
      });
    }, delayMs);

    timer.unref();
    this.alerts.set(alert.id, { sessionKey, alert, timer });
  }

  // ─── Polling ──────────────────────────────────────────────────────

  private async pollAlert(sessionKey: string, alert: Alert): Promise<void> {
    const session = this.sessionMgr.getOrCreate(sessionKey);
    alert.state.stats.polls = (alert.state.stats.polls || 0) + 1;
    alert.state.stats.last_poll = new Date().toISOString();

    let stdout: string;
    let stderr: string;
    let exitCode: number;
    try {
      const result = await this.runCheckCommand(alert, session.sessionDir);
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = result.exitCode;
    } catch (err) {
      this.logger.warn({ err, alertId: alert.id }, 'check_command threw');
      alert.state.stats.failures = (alert.state.stats.failures || 0) + 1;
      this.persistAlertState(session.sessionDir, alert);
      this.bumpFailures(sessionKey, alert);
      return;
    }

    if (exitCode !== 0) {
      const stderrPreview = stderr.slice(0, 500);
      const silent = (alert.state.stats.silent_failures || 0) + 1;
      alert.state.stats.silent_failures = silent;
      alert.state.stats.last_silent_stderr = stderrPreview;
      // Surface at WARN once we've had repeated silent failures — debug-level
      // hides permanent bugs from anyone not tailing the log.
      const logLevel = silent >= 3 ? 'warn' : 'debug';
      this.logger[logLevel](
        { alertId: alert.id, name: alert.name, exitCode, silentFailures: silent, stderrPreview },
        'check_command exit !=0',
      );
      // One-shot diagnostic message: tell the user when silent failures pile up
      // so they can fix the underlying script. Sent once per "streak" — reset
      // happens after a successful poll.
      if (silent === SILENT_FAILURE_DIAGNOSTIC_AT && alert.state.stats.silent_diagnostic_sent_at_count !== silent) {
        alert.state.stats.silent_diagnostic_sent_at_count = silent;
        this.sendSilentFailureDiagnostic(sessionKey, alert, exitCode, stderrPreview).catch((err) =>
          this.logger.warn({ err, alertId: alert.id }, 'silent failure diagnostic send failed'),
        );
      }
      this.persistAlertState(session.sessionDir, alert);
      return;
    }

    // Successful exit — reset silent failure tracking
    if ((alert.state.stats.silent_failures || 0) > 0) {
      alert.state.stats.silent_failures = 0;
      alert.state.stats.last_silent_stderr = undefined;
      alert.state.stats.silent_diagnostic_sent_at_count = undefined;
    }

    let newItems: NewItem[];
    try {
      const parsed = JSON.parse(stdout || '[]');
      newItems = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      this.logger.warn({ err, alertId: alert.id, stdoutPreview: stdout.slice(0, 200) }, 'check_command stdout not valid JSON array');
      this.persistAlertState(session.sessionDir, alert);
      return;
    }

    if (newItems.length === 0) {
      this.persistAlertState(session.sessionDir, alert);
      return;
    }

    // Sort ascending by NEW_PUBDATE (older first), filter by watermark/processed
    const sorted = newItems
      .filter((it) => typeof it.NEW_ID === 'string' && typeof it.NEW_PUBDATE === 'number')
      .filter((it) => it.NEW_PUBDATE > (alert.state.watermark.last_pubdate || 0))
      .filter((it) => !alert.state.watermark.processed_ids.includes(it.NEW_ID))
      .sort((a, b) => a.NEW_PUBDATE - b.NEW_PUBDATE);

    if (sorted.length === 0) {
      this.persistAlertState(session.sessionDir, alert);
      return;
    }

    this.logger.info({ alertId: alert.id, count: sorted.length }, 'New events to trigger');

    for (const item of sorted) {
      const ok = await this.executeTrigger(sessionKey, alert, item);
      if (ok) {
        alert.state.watermark.processed_ids.push(item.NEW_ID);
        alert.state.watermark.last_pubdate = Math.max(
          alert.state.watermark.last_pubdate || 0,
          item.NEW_PUBDATE,
        );
        const cap = alert.state.watermark.max_processed_size ?? DEFAULT_PROCESSED_SIZE;
        while (alert.state.watermark.processed_ids.length > cap) {
          alert.state.watermark.processed_ids.shift();
        }
        alert.state.stats.triggers = (alert.state.stats.triggers || 0) + 1;
        alert.state.stats.last_trigger = new Date().toISOString();
        this.consecutiveFailures.set(alert.id, 0);

        // one_shot: auto-disable on first successful trigger
        if (alert.type === 'one_shot') {
          this.persistAlertState(session.sessionDir, alert);
          this.disableAlert(session.sessionDir, alert.id);
          return;
        }
      } else {
        alert.state.stats.failures = (alert.state.stats.failures || 0) + 1;
        this.bumpFailures(sessionKey, alert);
        // Stop processing remaining items this round; retry next poll
        break;
      }
    }

    this.persistAlertState(session.sessionDir, alert);
  }

  private runCheckCommand(alert: Alert, sessionDir: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      const env = {
        ...process.env,
        WATERMARK_JSON: JSON.stringify(alert.state.watermark || { last_pubdate: 0, processed_ids: [] }),
        ALERT_NAME: alert.name,
        ALERT_ID: alert.id,
        SESSION_DIR: sessionDir,
      };
      execFile('/bin/bash', ['-c', alert.check_command], { env, cwd: sessionDir, timeout: CHECK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        const stderrStr = String(stderr || '');
        if (err) {
          const exitCode = (err as any).code ?? 1;
          resolve({ stdout: String(stdout || ''), stderr: stderrStr, exitCode });
          return;
        }
        resolve({ stdout: String(stdout || ''), stderr: stderrStr, exitCode: 0 });
      });
    });
  }

  /**
   * Send a one-time diagnostic to the user when a watcher's check_command keeps
   * exiting !=0. Without this, a permanent script bug looks indistinguishable
   * from "no new events" — polls climb but triggers stay 0.
   */
  private async sendSilentFailureDiagnostic(
    sessionKey: string,
    alert: Alert,
    exitCode: number,
    stderrPreview: string,
  ): Promise<void> {
    const session = this.sessionMgr.getOrCreate(sessionKey);
    const chatIdFile = path.join(session.sessionDir, 'chat-id');
    let chatId = '';
    try {
      chatId = fs.readFileSync(chatIdFile, 'utf-8').trim();
    } catch {
      return;
    }
    if (!chatId) return;
    const stderrBlock = stderrPreview ? `\n\nstderr 预览：\n\`\`\`\n${stderrPreview}\n\`\`\`` : '';
    const msg =
      `<<TITLE:Alert 持续静默失败|orange>>\n\n` +
      `⚠️ Alert **${alert.name}** 的 check_command 已经连续 ${SILENT_FAILURE_DIAGNOSTIC_AT} 次以 exit ${exitCode} 退出（既未触发也未计 failure）。\n\n` +
      `常见原因：脚本依赖（yt-dlp/python 等）不在 PATH、cookie 失效、网络不通、或脚本本身 bug。${stderrBlock}\n\n` +
      `修脚本后下一次成功轮询会自动重置该计数。`;
    await this.sender.sendReply(chatId, msg);
  }

  // ─── Trigger Execution ────────────────────────────────────────────

  private async executeTrigger(sessionKey: string, alert: Alert, item: NewItem): Promise<boolean> {
    const renderedPrompt = this.renderTemplate(alert.prompt, item);
    const session = this.sessionMgr.getOrCreate(sessionKey);

    if (alert.execution_mode === 'shell') {
      if (!alert.trigger_command) {
        this.logger.error({ alertId: alert.id }, 'execution_mode=shell but trigger_command missing');
        return false;
      }
      return new Promise((resolve) => {
        const env = { ...process.env, ...this.flattenItemForEnv(item) };
        execFile('/bin/bash', ['-c', alert.trigger_command!], { env, cwd: session.sessionDir, timeout: 5 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
          if (err) {
            this.logger.warn({ alertId: alert.id, err, stderr: String(stderr).slice(0, 300) }, 'shell trigger failed');
            resolve(false);
          } else {
            resolve(true);
          }
        });
      });
    }

    // Get chatId
    const chatIdFile = path.join(session.sessionDir, 'chat-id');
    let chatId: string;
    try {
      chatId = fs.readFileSync(chatIdFile, 'utf-8').trim();
    } catch {
      this.logger.error({ sessionKey, alertId: alert.id }, 'No chat-id, cannot deliver alert trigger');
      return false;
    }
    if (!chatId) return false;

    if (alert.execution_mode === 'message_only') {
      try {
        await this.sender.sendReply(chatId, `🔔 **${alert.name}**\n\n${renderedPrompt}`);
        return true;
      } catch (err) {
        this.logger.warn({ err, alertId: alert.id }, 'message_only send failed');
        return false;
      }
    }

    // execution_mode === 'claude' (default)
    try {
      if (this.messageBridge) {
        const wrapped = `[Alert触发: ${alert.name}] ${renderedPrompt}\n[新事件 ID: ${item.NEW_ID}]`;
        await this.messageBridge.executeCronJob(sessionKey, chatId, wrapped, alert.name);
      } else {
        const result = await this.runner.run({ sessionKey, message: renderedPrompt, sessionDir: session.sessionDir });
        await this.sender.sendReply(chatId, `🔔 **${alert.name}**\n\n${result.fullText || '(空结果)'}`);
      }
      return true;
    } catch (err) {
      this.logger.error({ err, alertId: alert.id, name: alert.name }, 'claude trigger failed');
      try {
        await this.sender.sendReply(chatId, `⚠️ Alert **${alert.name}** 触发失败: ${(err as Error).message}`);
      } catch { /* ignore */ }
      return false;
    }
  }

  private renderTemplate(tpl: string, item: NewItem): string {
    return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const v = item[key];
      return v === undefined || v === null ? '' : String(v);
    });
  }

  private flattenItemForEnv(item: NewItem): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(item)) {
      if (v === null || v === undefined) continue;
      out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    return out;
  }

  // ─── Failure tracking ─────────────────────────────────────────────

  private bumpFailures(sessionKey: string, alert: Alert): void {
    const n = (this.consecutiveFailures.get(alert.id) || 0) + 1;
    this.consecutiveFailures.set(alert.id, n);
    if (n >= CONSECUTIVE_FAILURE_THRESHOLD) {
      this.logger.warn({ alertId: alert.id, name: alert.name, consecutive: n }, 'Alert failing repeatedly, auto-pausing');
      const session = this.sessionMgr.getOrCreate(sessionKey);
      this.disableAlert(session.sessionDir, alert.id);
      // Try to send a pause notice
      const chatIdFile = path.join(session.sessionDir, 'chat-id');
      try {
        const chatId = fs.readFileSync(chatIdFile, 'utf-8').trim();
        if (chatId) {
          this.sender.sendReply(
            chatId,
            `⚠️ Alert **${alert.name}** 已自动暂停（连续失败 ${n} 次，可能 check_command 异常或 API 不可用）。请检查后重新启用。`,
          ).catch(() => {});
        }
      } catch { /* ignore */ }
      this.consecutiveFailures.delete(alert.id);
    }
  }

  // ─── State Persistence ────────────────────────────────────────────

  private persistAlertState(sessionDir: string, alert: Alert): void {
    const alertsFile = path.join(sessionDir, ALERTS_FILENAME);
    try {
      const alerts: Alert[] = JSON.parse(fs.readFileSync(alertsFile, 'utf-8'));
      const target = alerts.find((a) => a.id === alert.id);
      if (target) {
        target.state = alert.state;
        fs.writeFileSync(alertsFile, JSON.stringify(alerts, null, 2));
      }
    } catch (err) {
      this.logger.warn({ err, alertId: alert.id }, 'Failed to persist alert state');
    }
  }

  private disableAlert(sessionDir: string, alertId: string): void {
    const alertsFile = path.join(sessionDir, ALERTS_FILENAME);
    try {
      const alerts: Alert[] = JSON.parse(fs.readFileSync(alertsFile, 'utf-8'));
      const target = alerts.find((a) => a.id === alertId);
      if (target) {
        target.enabled = false;
        fs.writeFileSync(alertsFile, JSON.stringify(alerts, null, 2));
      }
    } catch (err) {
      this.logger.warn({ err, alertId }, 'Failed to disable alert');
    }
    this.alerts.delete(alertId);
  }

  // ─── Hot Reload Watcher ───────────────────────────────────────────

  private startWatching(): void {
    this.watchTimer = setInterval(() => {
      this.checkForChanges();
    }, WATCH_INTERVAL_MS);
    this.watchTimer.unref();
  }

  private checkForChanges(): void {
    const sessionsDir = this.sessionMgr.getSessionsDir();
    let entries: string[];
    try { entries = fs.readdirSync(sessionsDir); } catch { return; }

    for (const entry of entries) {
      const sessionDir = path.join(sessionsDir, entry);
      const signalFile = path.join(sessionDir, SIGNAL_FILENAME);
      if (fs.existsSync(signalFile)) {
        try { fs.unlinkSync(signalFile); } catch { /* ignore */ }
        this.logger.info({ sessionKey: entry }, 'Alerts changed, reloading');
        this.loadSessionAlerts(entry, sessionDir);
      }
    }
  }
}

// ─── Schedule helpers ──────────────────────────────────────────────────

/**
 * Compute the delay (in ms) until the next time this alert should fire.
 *
 * Two modes — exactly one of `interval_seconds` / `schedule` should be set:
 *   - interval_seconds: simple fixed-period polling (legacy, pre-cron).
 *   - schedule        : 5-field cron expression in the alert's schedule_tz
 *                       (defaults to Asia/Shanghai). Time-of-day windows and
 *                       weekday filters mean dead hours produce no fire times,
 *                       so the next-fire calculation naturally skips them.
 *
 * Returns null if neither field is usable (alert misconfigured).
 */
function computeDelayMs(alert: Alert): number | null {
  if (alert.schedule) {
    const tz = alert.schedule_tz || 'Asia/Shanghai';
    const ms = nextCronFireMs(alert.schedule, tz);
    if (ms == null || ms < 0) return null;
    return Math.max(1000, ms); // at least 1s to avoid tight loops on rounding
  }
  if (typeof alert.interval_seconds === 'number' && alert.interval_seconds > 0) {
    return Math.max(10, alert.interval_seconds) * 1000;
  }
  return null;
}

/**
 * Compute milliseconds until the next time a 5-field cron expression matches,
 * evaluated in the given IANA timezone (default Asia/Shanghai).
 *
 * Supported per-field syntax: "*", "N", "A-B", "A,B,C", "*\/N".
 * Walks at most 8 days minute-by-minute so any reasonable expression resolves
 * in < 11k iterations (~10ms).
 *
 * Returns null on parse error or if no match within 8 days.
 */
function nextCronFireMs(schedule: string, tz: string = 'Asia/Shanghai'): number | null {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minSpec, hourSpec, domSpec, monSpec, dowSpec] = fields;

  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parseInt(parts.find(p => p.type === t)!.value, 10);
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  let curH = get('hour'); if (curH === 24) curH = 0;
  const curM = get('minute');
  const curS = get('second');
  const curDom = get('day');
  const curMon = get('month');
  const curDow = dowMap[parts.find(p => p.type === 'weekday')!.value] ?? 0;

  // Cursor walks one minute at a time starting from the next minute boundary.
  let m = curM + 1;
  let h = curH;
  let dom = curDom;
  let mon = curMon;
  let dow = curDow;
  let elapsedMin = -curS / 60; // we're already curS seconds into curM

  for (let i = 0; i < 8 * 24 * 60; i++) {
    if (m >= 60) { m = 0; h++; }
    if (h >= 24) {
      h = 0;
      dow = (dow + 1) % 7;
      // Day rollover: dom/mon increment is a rough approximation since we
      // never need exact calendar arithmetic — */ranges/lists handle dom/mon
      // by absolute value, and we cap at 8 days.
      dom++;
    }
    elapsedMin++;

    if (matchCronField(m, minSpec) &&
        matchCronField(h, hourSpec) &&
        matchCronField(dom, domSpec) &&
        matchCronField(mon, monSpec) &&
        matchCronField(dow, dowSpec)) {
      return Math.round(elapsedMin * 60 * 1000);
    }
    m++;
  }
  return null;
}

function matchCronField(val: number, spec: string): boolean {
  if (spec === '*') return true;
  if (spec.includes(',')) {
    return spec.split(',').some(p => matchCronField(val, p));
  }
  const stepRange = spec.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
  if (stepRange) {
    const step = parseInt(stepRange[2], 10);
    if (step <= 0) return false;
    if (stepRange[1] === '*') return val % step === 0;
    const r = stepRange[1].match(/^(\d+)-(\d+)$/);
    if (r) {
      const a = parseInt(r[1], 10);
      const b = parseInt(r[2], 10);
      return val >= a && val <= b && (val - a) % step === 0;
    }
    const start = parseInt(stepRange[1], 10);
    return val >= start && (val - start) % step === 0;
  }
  const range = spec.match(/^(\d+)-(\d+)$/);
  if (range) {
    return val >= parseInt(range[1], 10) && val <= parseInt(range[2], 10);
  }
  const single = spec.match(/^\d+$/);
  if (single) return val === parseInt(spec, 10);
  return false;
}
