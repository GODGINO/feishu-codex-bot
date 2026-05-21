#!/usr/bin/env node
'use strict';

/**
 * Cron Job MCP Server
 *
 * A lightweight MCP server for managing user-created cron jobs.
 * Jobs are stored in {SESSION_DIR}/cron-jobs.json and executed by CronRunner in the main process.
 *
 * Tools:
 *   - create_cron_job: Create a new scheduled task
 *   - list_cron_jobs:  List all cron jobs for this session
 *   - delete_cron_job: Delete a cron job by ID
 *   - toggle_cron_job: Enable/disable a cron job
 *
 * Environment:
 *   - SESSION_DIR: Required. Path to the session directory.
 *   - SESSION_KEY: Optional. For logging.
 */

const fs = require('node:fs');
const path = require('node:path');

const SESSION_DIR = process.env.SESSION_DIR || '';
const SESSION_KEY = process.env.SESSION_KEY || '';

if (!SESSION_DIR) {
  process.stderr.write('[cron-mcp] ERROR: SESSION_DIR not set\n');
  process.exit(1);
}

const JOBS_FILE = path.join(SESSION_DIR, 'cron-jobs.json');
const SIGNAL_FILE = path.join(SESSION_DIR, '.cron-changed');

// ─── Job storage helpers ──────────────────────────────────────

function readJobs() {
  try {
    if (fs.existsSync(JOBS_FILE)) {
      return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
    }
  } catch (err) {
    process.stderr.write(`[cron-mcp] Error reading jobs: ${err.message}\n`);
  }
  return [];
}

function writeJobs(jobs) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

function signalChange() {
  fs.writeFileSync(SIGNAL_FILE, String(Date.now()));
}

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

// ─── Schedule validation ──────────────────────────────────────

function isValidSchedule(schedule) {
  // Shorthand: 30m, 2h, 1d
  if (/^\d+[smhd]$/.test(schedule)) return true;
  // Time point: 9:00, 14:30
  if (/^\d{1,2}:\d{2}$/.test(schedule)) return true;
  // English shorthand: every 2h, every 30m
  if (/^every\s+\d+[smhd]$/i.test(schedule)) return true;
  // Standard 5-field cron: */30 * * * *, 0 9 * * *
  if (/^[\d*\/,\-]+\s+[\d*\/,\-]+\s+[\d*\/,\-]+\s+[\d*\/,\-]+\s+[\d*\/,\-]+$/.test(schedule)) return true;
  return false;
}

// ─── Tool implementations ──────────────────────────────────────

function handleCreateCronJob(args) {
  const { name, schedule, prompt } = args;

  if (!name) return { content: [{ type: 'text', text: 'Error: name is required' }], isError: true };
  if (!schedule) return { content: [{ type: 'text', text: 'Error: schedule is required' }], isError: true };
  if (!prompt) return { content: [{ type: 'text', text: 'Error: prompt is required' }], isError: true };

  if (!isValidSchedule(schedule)) {
    return {
      content: [{ type: 'text', text: `Error: Invalid schedule "${schedule}". Supported formats:\n- Cron: "0 9 * * *", "*/30 * * * *"\n- Shorthand: "30m", "2h", "1d"\n- Time: "9:00", "14:30"\n- English: "every 2h", "every 30m"` }],
      isError: true,
    };
  }

  const job = {
    id: generateId(),
    name,
    schedule,
    prompt,
    enabled: true,
    createdAt: new Date().toISOString(),
  };

  const jobs = readJobs();
  jobs.push(job);
  writeJobs(jobs);
  signalChange();

  return {
    content: [{ type: 'text', text: `✅ Created cron job:\n- ID: ${job.id}\n- Name: ${job.name}\n- Schedule: ${job.schedule}\n- Prompt: ${job.prompt}\n\nThe task will be executed automatically on schedule.` }],
  };
}

function handleListCronJobs() {
  const jobs = readJobs();

  if (jobs.length === 0) {
    return { content: [{ type: 'text', text: 'No cron jobs found for this session.' }] };
  }

  const lines = jobs.map((job) => {
    const status = job.enabled ? '✅ enabled' : '⏸️ disabled';
    const lastRun = job.lastRunAt
      ? new Date(job.lastRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      : 'never';
    return `**${job.name}** (ID: ${job.id})\n  Schedule: ${job.schedule} | Status: ${status}\n  Prompt: ${job.prompt}\n  Last run: ${lastRun}${job.lastResult ? `\n  Last result: ${job.lastResult.slice(0, 100)}...` : ''}`;
  });

  return { content: [{ type: 'text', text: `Found ${jobs.length} cron job(s):\n\n${lines.join('\n\n')}` }] };
}

function handleDeleteCronJob(args) {
  const { id } = args;
  if (!id) return { content: [{ type: 'text', text: 'Error: id is required' }], isError: true };

  const jobs = readJobs();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) {
    return { content: [{ type: 'text', text: `Error: No job found with ID "${id}"` }], isError: true };
  }

  const removed = jobs.splice(idx, 1)[0];
  writeJobs(jobs);
  signalChange();

  return { content: [{ type: 'text', text: `🗑️ Deleted cron job "${removed.name}" (ID: ${removed.id})` }] };
}

function handleToggleCronJob(args) {
  const { id, enabled } = args;
  if (!id) return { content: [{ type: 'text', text: 'Error: id is required' }], isError: true };
  if (typeof enabled !== 'boolean') return { content: [{ type: 'text', text: 'Error: enabled must be a boolean' }], isError: true };

  const jobs = readJobs();
  const job = jobs.find((j) => j.id === id);
  if (!job) {
    return { content: [{ type: 'text', text: `Error: No job found with ID "${id}"` }], isError: true };
  }

  job.enabled = enabled;
  writeJobs(jobs);
  signalChange();

  const status = enabled ? '✅ enabled' : '⏸️ disabled';
  return { content: [{ type: 'text', text: `Updated job "${job.name}" → ${status}` }] };
}

// ─── MCP Protocol (JSON-RPC over stdio) ────────────────────────

const TOOLS = [
  {
    name: 'create_cron_job',
    description: '创建一个定时/定期执行的任务。任务到时间会自动执行并发送结果。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '任务名称，简短描述（如"HN每日摘要"）' },
        schedule: { type: 'string', description: '执行计划（所有时间均为北京时间，不要做时区转换）。支持: cron表达式(0 9 * * *=每天早9点)、简写(30m/2h/1d)、时间点(9:00/14:30=北京时间)、every格式(every 2h)' },
        prompt: { type: 'string', description: '任务内容，自然语言描述要执行什么（如"打开Hacker News总结前10条热门帖子"）' },
      },
      required: ['name', 'schedule', 'prompt'],
    },
  },
  {
    name: 'list_cron_jobs',
    description: '列出当前会话的所有定时任务。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'delete_cron_job',
    description: '删除一个定时任务。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的任务ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'toggle_cron_job',
    description: '启用或禁用一个定时任务。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务ID' },
        enabled: { type: 'boolean', description: 'true=启用, false=禁用' },
      },
      required: ['id', 'enabled'],
    },
  },
];

const SERVER_INFO = {
  name: 'cron',
  version: '1.0.0',
};

function handleRequest(msg) {
  const { method, params, id } = msg;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments || {};
      let result;

      switch (toolName) {
        case 'create_cron_job':
          result = handleCreateCronJob(args);
          break;
        case 'list_cron_jobs':
          result = handleListCronJobs();
          break;
        case 'delete_cron_job':
          result = handleDeleteCronJob(args);
          break;
        case 'toggle_cron_job':
          result = handleToggleCronJob(args);
          break;
        default:
          result = { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }], isError: true };
      }

      return { jsonrpc: '2.0', id, result };
    }

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    default:
      return {
        jsonrpc: '2.0', id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// ─── stdio transport ───────────────────────────────────────────

let buffer = Buffer.alloc(0);

function sendMessage(msg) {
  if (!msg) return;
  const json = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(json, 'utf-8')}\r\n\r\n`;
  process.stdout.write(header + json);
}

const HEADER_DELIM = Buffer.from('\r\n\r\n');

function processBuffer() {
  while (true) {
    const headerEnd = buffer.indexOf(HEADER_DELIM);
    if (headerEnd === -1) break;

    const headerStr = buffer.slice(0, headerEnd).toString('utf-8');
    const match = headerStr.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }

    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) break;

    const body = buffer.slice(bodyStart, bodyStart + contentLength).toString('utf-8');
    buffer = buffer.slice(bodyStart + contentLength);

    try {
      const msg = JSON.parse(body);
      const response = handleRequest(msg);
      sendMessage(response);
    } catch (err) {
      process.stderr.write(`[cron-mcp] Parse error: ${err.message}\n`);
    }
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});

process.stdin.on('end', () => {
  process.exit(0);
});

process.stderr.write(`[cron-mcp] Started for session: ${SESSION_KEY} (dir: ${SESSION_DIR})\n`);
