#!/usr/bin/env node
/**
 * Alert MCP Server — exposes alert (condition-triggered job) management as MCP tools.
 * Spawned by Claude Code as a stdio MCP server.
 * Reads SESSION_DIR from environment (set by process-pool.ts).
 *
 * See: shared/sigma-alert-plan.md (chapter 七-十二)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { execFile } from 'node:child_process';

const DRYRUN_TIMEOUT_MS = 45_000; // create-time validation; alert-runner uses 30s

/**
 * Run check_command once with the same env that alert-runner.ts uses, so the
 * "creation succeeded" outcome implies "first poll will succeed" — closing the
 * gap between "I tested it in my shell" and "it works under PM2 god daemon".
 *
 * Returns parsed JSON array on success, or { error } on failure.
 */
function dryRunCheckCommand(
  cmd: string,
  alertName: string,
): Promise<{ items: any[]; stderr: string } | { error: string; stderr?: string; exitCode?: number; stdoutPreview?: string }> {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      WATERMARK_JSON: JSON.stringify({ last_pubdate: 0, processed_ids: [] }),
      ALERT_NAME: alertName,
      ALERT_ID: 'dry-run',
      SESSION_DIR,
    };
    execFile('/bin/bash', ['-c', cmd], {
      env,
      cwd: SESSION_DIR,
      timeout: DRYRUN_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const stderrStr = String(stderr || '');
      if (err) {
        const exitCode = (err as any).code ?? 1;
        resolve({ error: 'check_command exited non-zero', stderr: stderrStr.slice(0, 800), exitCode, stdoutPreview: String(stdout || '').slice(0, 200) });
        return;
      }
      const stdoutStr = String(stdout || '').trim();
      if (!stdoutStr) {
        // Empty stdout is *valid* for an alert (means "no events right now"),
        // so we treat this as success with empty items list.
        resolve({ items: [], stderr: stderrStr });
        return;
      }
      try {
        const parsed = JSON.parse(stdoutStr);
        if (!Array.isArray(parsed)) {
          resolve({ error: 'stdout must be a JSON array', stdoutPreview: stdoutStr.slice(0, 300) });
          return;
        }
        resolve({ items: parsed, stderr: stderrStr });
      } catch (e) {
        resolve({ error: 'stdout is not valid JSON', stdoutPreview: stdoutStr.slice(0, 300) });
      }
    });
  });
}

const SESSION_DIR = process.env.SESSION_DIR || '';
if (!SESSION_DIR) {
  process.stderr.write('alert-mcp: SESSION_DIR not set\n');
  process.exit(1);
}

const ALERTS_FILE = path.join(SESSION_DIR, 'alerts.json');
const SIGNAL_FILE = path.join(SESSION_DIR, '.alerts-changed');

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
}

interface Alert {
  id: string;
  name: string;
  type: 'one_shot' | 'watcher';
  enabled: boolean;
  // Two scheduling modes — exactly one must be set:
  //   interval_seconds : poll every N seconds, around the clock
  //   schedule         : 5-field cron in `schedule_tz` (default Asia/Shanghai)
  interval_seconds?: number;
  schedule?: string;
  schedule_tz?: string;
  check_command: string;
  prompt: string;
  execution_mode: 'claude' | 'shell' | 'message_only';
  trigger_command?: string;
  state: { watermark: AlertWatermark; stats: AlertStats };
  max_runtime_days?: number;
  createdAt: string;
}

function readAlerts(): Alert[] {
  try {
    if (fs.existsSync(ALERTS_FILE)) {
      return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

/**
 * Write alerts to disk with optional state-merge to avoid races with alert-runner.
 *
 * Background: alert-runner persists watermark.processed_ids + stats every poll.
 * If alert-mcp does plain read-modify-write, it can clobber a freshly-pushed
 * processed_ids entry (causing the same event to fire twice). We re-read disk
 * right before writing and, for any matching id, keep disk's `state` field
 * (which alert-runner is the authoritative writer of).
 *
 * resetAlert wants to *overwrite* state — it passes preserveStateOnConflict=false.
 */
function writeAlerts(alerts: Alert[], opts: { preserveStateOnConflict?: boolean } = {}): void {
  const preserve = opts.preserveStateOnConflict !== false; // default true
  let toWrite: Alert[] = alerts;
  if (preserve) {
    const onDisk = readAlerts();
    toWrite = alerts.map((m) => {
      const fresh = onDisk.find((d) => d.id === m.id);
      if (fresh && fresh.state) {
        // disk's state wins — alert-runner may have updated watermark/stats
        // since we read; keep our config-field changes (name/schedule/enabled etc).
        return { ...m, state: fresh.state };
      }
      return m;
    });
  }
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(toWrite, null, 2));
}

function signalChange(): void {
  fs.writeFileSync(SIGNAL_FILE, String(Date.now()));
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ─── Tool implementations ────────────────────────────────────

function listAlerts(): string {
  const alerts = readAlerts();
  if (alerts.length === 0) return '当前没有 Alert。';

  const lines = [`共 ${alerts.length} 个 Alert：\n`];
  for (const a of alerts) {
    const status = a.enabled ? '✅ 启用' : '⏸️ 禁用';
    const stats = a.state?.stats || { polls: 0, triggers: 0, failures: 0 };
    const lastTrigger = stats.last_trigger
      ? new Date(stats.last_trigger).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      : '从未触发';
    const wmSize = (a.state?.watermark?.processed_ids || []).length;
    const cadence = a.schedule
      ? `cron: ${a.schedule}${a.schedule_tz && a.schedule_tz !== 'Asia/Shanghai' ? ` (${a.schedule_tz})` : ''}`
      : `间隔: ${a.interval_seconds}s`;
    lines.push(`**${a.name}** (ID: ${a.id})`);
    lines.push(`  类型: ${a.type} | 状态: ${status} | ${cadence} | 模式: ${a.execution_mode}`);
    lines.push(`  统计: polls=${stats.polls} triggers=${stats.triggers} failures=${stats.failures} 已处理=${wmSize}`);
    lines.push(`  上次触发: ${lastTrigger}`);
    lines.push(`  prompt: ${a.prompt.slice(0, 150)}${a.prompt.length > 150 ? '...' : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function createAlert(args: {
  name: string;
  type?: 'one_shot' | 'watcher';
  interval_seconds?: number;
  schedule?: string;
  schedule_tz?: string;
  check_command: string;
  prompt: string;
  execution_mode?: 'claude' | 'shell' | 'message_only';
  trigger_command?: string;
  max_runtime_days?: number;
  // When true, skip the dry-run check_command validation. Use only if you have
  // already validated the script in the same env alert-runner uses, or when the
  // initial poll is intentionally slow (e.g. Selenium warm-up). Default: false.
  skip_dryrun?: boolean;
}): Promise<string> {
  if (!args.name) return 'Error: name is required';
  if (!args.check_command) return 'Error: check_command is required';
  if (!args.prompt) return 'Error: prompt is required';

  const hasInterval = typeof args.interval_seconds === 'number' && args.interval_seconds > 0;
  const hasSchedule = typeof args.schedule === 'string' && args.schedule.trim().length > 0;
  if (hasInterval && hasSchedule) {
    return 'Error: 只能二选一：interval_seconds 或 schedule（cron 表达式）';
  }
  if (!hasInterval && !hasSchedule) {
    return 'Error: 必须提供 interval_seconds 或 schedule（cron 表达式）之一';
  }
  if (hasInterval && (args.interval_seconds as number) < 10) {
    return 'Error: interval_seconds must be >= 10';
  }
  if (hasSchedule && args.schedule!.trim().split(/\s+/).length !== 5) {
    return 'Error: schedule 必须是 5 字段 cron 表达式（分 时 日 月 周），如 "*/10 11-17 * * *"';
  }

  // Dry-run: execute check_command in the same env alert-runner uses, BEFORE
  // committing the alert to disk. Catches PATH/dependency/script bugs at
  // creation time instead of letting them fail silently in the first poll.
  // Side effect: also auto-establishes the watermark baseline using the items
  // returned now, so the very first real poll won't trigger the historical flood.
  let baselineProcessedIds: string[] = [];
  let baselineLastPubdate = 0;
  let dryRunReport = '';
  if (!args.skip_dryrun) {
    const result = await dryRunCheckCommand(args.check_command, args.name);
    if ('error' in result) {
      let msg = `❌ Dry-run 失败：${result.error}`;
      if (result.exitCode !== undefined) msg += ` (exit ${result.exitCode})`;
      if (result.stderr) msg += `\n\nstderr 预览：\n${result.stderr}`;
      if (result.stdoutPreview) msg += `\n\nstdout 预览：\n${result.stdoutPreview}`;
      msg += `\n\n常见原因：脚本依赖（yt-dlp/python 等）不在 alert-runner 的 PATH、cookie 失效、脚本本身 bug。修脚本后重试，或传 skip_dryrun=true 强制创建（不推荐——你会得到一个 silent-failing alert）。`;
      return msg;
    }
    const items = result.items;
    // Auto-baseline: pre-fill processed_ids with everything check_command returns
    // *now* so the first real poll only triggers on items that arrive *after* creation.
    for (const it of items) {
      if (it && typeof it.NEW_ID === 'string') baselineProcessedIds.push(it.NEW_ID);
      if (it && typeof it.NEW_PUBDATE === 'number' && it.NEW_PUBDATE > baselineLastPubdate) {
        baselineLastPubdate = it.NEW_PUBDATE;
      }
    }
    dryRunReport = `\n\n✅ Dry-run 通过：check_command 输出 ${items.length} 条样例事件。`;
    if (items.length > 0) {
      const first = items[0];
      const hint = first?.NEW_TITLE || first?.NEW_ID || JSON.stringify(first).slice(0, 80);
      dryRunReport += `\n  样例：${String(hint).slice(0, 100)}\n  Watermark baseline 已自动建立（${baselineProcessedIds.length} 个 ID 标记为已处理，避免首次轮询洪水）。`;
    } else {
      dryRunReport += `\n  当前没有事件——下次有新事件时会触发。`;
    }
  }

  const alert: Alert = {
    id: generateId(),
    name: args.name,
    type: args.type || 'watcher',
    enabled: true,
    interval_seconds: hasInterval ? args.interval_seconds : undefined,
    schedule: hasSchedule ? args.schedule!.trim() : undefined,
    schedule_tz: hasSchedule ? (args.schedule_tz || 'Asia/Shanghai') : undefined,
    check_command: args.check_command,
    prompt: args.prompt,
    execution_mode: args.execution_mode || 'claude',
    trigger_command: args.trigger_command,
    state: {
      watermark: {
        last_pubdate: baselineLastPubdate,
        processed_ids: baselineProcessedIds,
        max_processed_size: 200,
      },
      stats: { polls: 0, triggers: 0, failures: 0 },
    },
    max_runtime_days: args.max_runtime_days ?? 30,
    createdAt: new Date().toISOString(),
  };

  const alerts = readAlerts();
  alerts.push(alert);
  writeAlerts(alerts);
  signalChange();

  const cadenceLabel = hasSchedule
    ? `调度: cron "${alert.schedule}" (${alert.schedule_tz})`
    : `间隔: ${alert.interval_seconds}秒`;
  return `Alert 已创建：\n  名称: ${alert.name}\n  ID: ${alert.id}\n  类型: ${alert.type}\n  ${cadenceLabel}\n  执行模式: ${alert.execution_mode}\n  check: ${alert.check_command.slice(0, 100)}${alert.check_command.length > 100 ? '...' : ''}${dryRunReport}\n\nAlert 已上线。`;
}

function deleteAlert(args: { id: string }): string {
  if (!args.id) return 'Error: id is required';
  const alerts = readAlerts();
  const idx = alerts.findIndex((a) => a.id === args.id);
  if (idx === -1) return `Error: 未找到 ID 为 "${args.id}" 的 Alert`;
  const removed = alerts.splice(idx, 1)[0];
  writeAlerts(alerts);
  signalChange();
  return `已删除 Alert "${removed.name}" (ID: ${removed.id})`;
}

function toggleAlert(args: { id: string; enabled: boolean }): string {
  if (!args.id) return 'Error: id is required';
  const alerts = readAlerts();
  const a = alerts.find((x) => x.id === args.id);
  if (!a) return `Error: 未找到 ID 为 "${args.id}" 的 Alert`;
  a.enabled = args.enabled;
  writeAlerts(alerts);
  signalChange();
  return `已${args.enabled ? '启用' : '禁用'} Alert "${a.name}"`;
}

function resetAlert(args: { id: string }): string {
  if (!args.id) return 'Error: id is required';
  const alerts = readAlerts();
  const a = alerts.find((x) => x.id === args.id);
  if (!a) return `Error: 未找到 ID 为 "${args.id}" 的 Alert`;
  a.state = {
    watermark: { last_pubdate: 0, processed_ids: [], max_processed_size: 200 },
    stats: { polls: 0, triggers: 0, failures: 0 },
  };
  // resetAlert *wants* to clobber state — opt out of the preserve-on-conflict default.
  writeAlerts(alerts, { preserveStateOnConflict: false });
  signalChange();
  return `已重置 Alert "${a.name}" 的 watermark 和统计。下一轮将从当前最新状态重新建立基线。`;
}

function inspectAlert(args: { id: string }): string {
  if (!args.id) return 'Error: id is required';
  const alerts = readAlerts();
  const a = alerts.find((x) => x.id === args.id);
  if (!a) return `Error: 未找到 ID 为 "${args.id}" 的 Alert`;
  return JSON.stringify(a, null, 2);
}

// ─── MCP Protocol ────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_alerts',
    description: '列出所有 Alert（条件触发任务）。包含名称、类型、间隔、统计、上次触发时间。',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'create_alert',
    description: 'Create a condition-triggered alert. Two types: watcher (持续监听新事件) | one_shot (触发后自动停). check_command 是 sh 脚本，exit 0 + 非空 JSON 数组 = 触发. prompt 支持 {{NEW_ID}} 等模板. execution_mode: claude/shell/message_only. **调度二选一**：interval_seconds（每 N 秒轮询，全天）或 schedule（5 字段 cron 表达式，可限定时段/星期，如 "*/10 11-17 * * *" = 每天 11:00-17:50 每 10 分钟）。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Alert 名称' },
        type: { type: 'string', enum: ['one_shot', 'watcher'], description: '类型，默认 watcher' },
        interval_seconds: { type: 'number', description: '【调度方式 1】轮询间隔（秒），最小 10。全天候。和 schedule 二选一。' },
        schedule: { type: 'string', description: '【调度方式 2】5 字段 cron 表达式（分 时 日 月 周）。能表达时段+星期窗口。例：`*/10 11-17 * * *`（每天 11-17 点每 10 分钟）、`*/30 8-22 * * 1-5`（工作日 8-22 点每 30 分钟）、`0 9 * * 1-5`（工作日 9:00）。和 interval_seconds 二选一。' },
        schedule_tz: { type: 'string', description: 'schedule 的时区，IANA 名称如 Asia/Shanghai（默认）/America/New_York。' },
        check_command: { type: 'string', description: 'sh 检查脚本（可访问 $WATERMARK_JSON），输出 JSON 数组' },
        prompt: { type: 'string', description: '触发时的 prompt 或消息模板，支持 {{字段}} 替换' },
        execution_mode: { type: 'string', enum: ['claude', 'shell', 'message_only'], description: '默认 claude' },
        trigger_command: { type: 'string', description: 'execution_mode=shell 时执行的命令' },
        max_runtime_days: { type: 'number', description: 'watcher 自动停用天数（默认 30，0=永不）' },
        skip_dryrun: { type: 'boolean', description: '默认 false：创建前会用 alert-runner 同款 env 试跑一次 check_command 验证脚本可用 + 自动建立 watermark baseline（避免首次轮询历史洪水）。试跑超时 45s。仅当脚本初次启动慢/有意失败时设 true 跳过——会失去环境一致性保证。' },
      },
      required: ['name', 'check_command', 'prompt'],
    },
  },
  {
    name: 'delete_alert',
    description: '删除 Alert',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'toggle_alert',
    description: '启用或禁用 Alert',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['id', 'enabled'],
    },
  },
  {
    name: 'reset_alert',
    description: '重置 Alert 的 watermark 和统计（清空已处理记录，从当前最新状态重新建立基线）',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'inspect_alert',
    description: '查看 Alert 完整状态（含 watermark / processed_ids / stats）',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

async function handleRequest(req: { id: number | string; method: string; params?: any }): Promise<any> {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'alert-mcp', version: '1.0.0' },
      };
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const { name, arguments: args } = req.params || {};
      let text: string;
      switch (name) {
        case 'list_alerts': text = listAlerts(); break;
        case 'create_alert': text = await createAlert(args || {}); break;
        case 'delete_alert': text = deleteAlert(args || {}); break;
        case 'toggle_alert': text = toggleAlert(args || {}); break;
        case 'reset_alert': text = resetAlert(args || {}); break;
        case 'inspect_alert': text = inspectAlert(args || {}); break;
        default: text = `Unknown tool: ${name}`;
      }
      return { content: [{ type: 'text', text }] };
    }
    default:
      return null;
  }
}

function sendResponse(id: number | string, result: any): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendError(id: number | string, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let req: any;
  try { req = JSON.parse(line); } catch { return; }
  if (req.id === undefined) return;
  handleRequest(req).then((result) => {
    if (result !== null) sendResponse(req.id, result);
    else sendError(req.id, -32601, `Method not found: ${req.method}`);
  }).catch((err) => {
    sendError(req.id, -32603, `Internal error: ${err?.message || String(err)}`);
  });
});
