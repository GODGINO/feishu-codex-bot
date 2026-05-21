#!/usr/bin/env node
/**
 * Cron MCP Server — exposes cron job management as MCP tools.
 * Spawned by Claude Code as a stdio MCP server.
 * Reads SESSION_DIR from environment (set by process-pool.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

const SESSION_DIR = process.env.SESSION_DIR || '';
if (!SESSION_DIR) {
  process.stderr.write('cron-mcp: SESSION_DIR not set\n');
  process.exit(1);
}

const JOBS_FILE = path.join(SESSION_DIR, 'cron-jobs.json');
const SIGNAL_FILE = path.join(SESSION_DIR, '.cron-changed');

// ─── Job helpers ─────────────────────────────────────────────

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastResult?: string;
}

function readJobs(): CronJob[] {
  try {
    if (fs.existsSync(JOBS_FILE)) {
      return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function writeJobs(jobs: CronJob[]): void {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

function signalChange(): void {
  fs.writeFileSync(SIGNAL_FILE, String(Date.now()));
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function isValidSchedule(schedule: string): boolean {
  if (/^\d+[smhd]$/.test(schedule)) return true;
  if (/^\d{1,2}:\d{2}$/.test(schedule)) return true;
  if (/^every\s+\d+[smhd]$/i.test(schedule)) return true;
  if (/^[\d*\/,\-]+\s+[\d*\/,\-]+\s+[\d*\/,\-]+\s+[\d*\/,\-]+\s+[\d*\/,\-]+$/.test(schedule)) return true;
  return false;
}

// ─── Tool implementations ────────────────────────────────────

function listJobs(): string {
  const jobs = readJobs();
  if (jobs.length === 0) return '当前没有定时任务。';

  const lines = [`共 ${jobs.length} 个定时任务：\n`];
  for (const job of jobs) {
    const status = job.enabled ? '✅ 启用' : '⏸️ 禁用';
    const lastRun = job.lastRunAt
      ? new Date(job.lastRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      : '从未运行';
    lines.push(`**${job.name}** (ID: ${job.id})`);
    lines.push(`  计划: ${job.schedule} | 状态: ${status}`);
    lines.push(`  内容: ${job.prompt.slice(0, 200)}${job.prompt.length > 200 ? '...' : ''}`);
    lines.push(`  上次运行: ${lastRun}`);
    if (job.lastResult) {
      lines.push(`  上次结果: ${job.lastResult.slice(0, 150)}...`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function createJob(args: { name: string; schedule: string; prompt: string }): string {
  if (!args.name) return 'Error: name is required';
  if (!args.schedule) return 'Error: schedule is required';
  if (!args.prompt) return 'Error: prompt is required';
  if (!isValidSchedule(args.schedule)) {
    return `Error: Invalid schedule "${args.schedule}". 支持格式: cron表达式(0 9 * * *)、简写(30m/2h/1d)、时间点(9:00/14:30)、every格式(every 2h)`;
  }

  const job: CronJob = {
    id: generateId(),
    name: args.name,
    schedule: args.schedule,
    prompt: args.prompt,
    enabled: true,
    createdAt: new Date().toISOString(),
  };

  const jobs = readJobs();
  jobs.push(job);
  writeJobs(jobs);
  signalChange();

  return `定时任务已创建：\n  名称: ${job.name}\n  ID: ${job.id}\n  计划: ${job.schedule}\n  内容: ${job.prompt}\n\n任务将按计划自动执行。`;
}

function deleteJob(args: { id: string }): string {
  if (!args.id) return 'Error: id is required';
  const jobs = readJobs();
  const idx = jobs.findIndex(j => j.id === args.id);
  if (idx === -1) return `Error: 未找到 ID 为 "${args.id}" 的任务`;
  const removed = jobs.splice(idx, 1)[0];
  writeJobs(jobs);
  signalChange();
  return `已删除定时任务 "${removed.name}" (ID: ${removed.id})`;
}

function toggleJob(args: { id: string; enabled: boolean }): string {
  if (!args.id) return 'Error: id is required';
  const jobs = readJobs();
  const job = jobs.find(j => j.id === args.id);
  if (!job) return `Error: 未找到 ID 为 "${args.id}" 的任务`;
  job.enabled = args.enabled;
  writeJobs(jobs);
  signalChange();
  return `已${args.enabled ? '启用' : '禁用'}任务 "${job.name}"`;
}

// ─── MCP Protocol ────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_cron_jobs',
    description: '列出当前所有定时任务（包括名称、计划、状态、上次运行时间）',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'create_cron_job',
    description: '创建定时任务。schedule 支持 cron 表达式(0 9 * * *)、简写(30m/2h/1d)、时间点(9:00/14:30，北京时间)、every 格式(every 2h)。所有时间均为北京时间。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: '任务名称' },
        schedule: { type: 'string', description: '执行计划（北京时间）' },
        prompt: { type: 'string', description: '任务内容，自然语言描述要执行什么' },
      },
      required: ['name', 'schedule', 'prompt'],
    },
  },
  {
    name: 'delete_cron_job',
    description: '删除定时任务',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: '任务ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'toggle_cron_job',
    description: '启用或禁用定时任务',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: '任务ID' },
        enabled: { type: 'boolean', description: 'true=启用, false=禁用' },
      },
      required: ['id', 'enabled'],
    },
  },
];

function handleRequest(req: { id: number | string; method: string; params?: any }): any {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'cron-mcp', version: '1.0.0' },
      };
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const { name, arguments: args } = req.params || {};
      let text: string;
      switch (name) {
        case 'list_cron_jobs':
          text = listJobs();
          break;
        case 'create_cron_job':
          text = createJob(args || {});
          break;
        case 'delete_cron_job':
          text = deleteJob(args || {});
          break;
        case 'toggle_cron_job':
          text = toggleJob(args || {});
          break;
        default:
          text = `Unknown tool: ${name}`;
      }
      return { content: [{ type: 'text', text }] };
    }
    default:
      return null;
  }
}

function sendResponse(id: number | string, result: any): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function sendError(id: number | string, code: number, message: string): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

// ─── Main loop ───────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  let req: any;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  // Notifications (no id) — just ignore
  if (req.id === undefined) return;

  const result = handleRequest(req);
  if (result !== null) {
    sendResponse(req.id, result);
  } else {
    sendError(req.id, -32601, `Method not found: ${req.method}`);
  }
});
