#!/usr/bin/env node
'use strict';

/**
 * Cron Job CLI — manages cron jobs via file operations
 * Usage:
 *   node cron-cli.cjs create --name "日报" --schedule "9:00" --prompt "写日报"
 *   node cron-cli.cjs list
 *   node cron-cli.cjs delete --id abc12345
 *   node cron-cli.cjs toggle --id abc12345 --enabled true
 *
 * Environment:
 *   SESSION_DIR: Required. Path to the session directory.
 */

const fs = require('node:fs');
const path = require('node:path');

const SESSION_DIR = process.env.SESSION_DIR || '';
if (!SESSION_DIR) {
  console.error('Error: SESSION_DIR environment variable is required');
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
    console.error(`Error reading jobs: ${err.message}`);
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
  if (/^\d+[smhd]$/.test(schedule)) return true;
  if (/^\d{1,2}:\d{2}$/.test(schedule)) return true;
  if (/^every\s+\d+[smhd]$/i.test(schedule)) return true;
  if (/^[\d*\/,\-]+\s+[\d*\/,\-]+\s+[\d*\/,\-]+\s+[\d*\/,\-]+\s+[\d*\/,\-]+$/.test(schedule)) return true;
  return false;
}

// ─── CLI argument parsing ──────────────────────────────────────

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      if (val !== undefined && !val.startsWith('--')) {
        // Handle boolean values
        if (val === 'true') result[key] = true;
        else if (val === 'false') result[key] = false;
        else result[key] = val;
        i++;
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}

// ─── Commands ──────────────────────────────────────────────────

function cmdCreate(opts) {
  const { name, schedule, prompt } = opts;

  if (!name) { console.log('Error: --name is required'); process.exit(1); }
  if (!schedule) { console.log('Error: --schedule is required'); process.exit(1); }
  if (!prompt) { console.log('Error: --prompt is required'); process.exit(1); }

  if (!isValidSchedule(schedule)) {
    console.log(`Error: Invalid schedule "${schedule}". Supported formats:`);
    console.log('  - Cron: "0 9 * * *", "*/30 * * * *"');
    console.log('  - Shorthand: "30m", "2h", "1d"');
    console.log('  - Time: "9:00", "14:30"');
    console.log('  - English: "every 2h", "every 30m"');
    process.exit(1);
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

  console.log(`Created cron job:`);
  console.log(`  ID: ${job.id}`);
  console.log(`  Name: ${job.name}`);
  console.log(`  Schedule: ${job.schedule}`);
  console.log(`  Prompt: ${job.prompt}`);
  console.log(`\nThe task will be executed automatically on schedule.`);
}

function cmdList() {
  const jobs = readJobs();

  if (jobs.length === 0) {
    console.log('No cron jobs found for this session.');
    return;
  }

  console.log(`Found ${jobs.length} cron job(s):\n`);
  for (const job of jobs) {
    const status = job.enabled ? 'enabled' : 'disabled';
    const lastRun = job.lastRunAt
      ? new Date(job.lastRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      : 'never';
    console.log(`${job.name} (ID: ${job.id})`);
    console.log(`  Schedule: ${job.schedule} | Status: ${status}`);
    console.log(`  Prompt: ${job.prompt}`);
    console.log(`  Last run: ${lastRun}`);
    if (job.lastResult) {
      console.log(`  Last result: ${job.lastResult.slice(0, 100)}...`);
    }
    console.log();
  }
}

function cmdDelete(opts) {
  const { id } = opts;
  if (!id) { console.log('Error: --id is required'); process.exit(1); }

  const jobs = readJobs();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) {
    console.log(`Error: No job found with ID "${id}"`);
    process.exit(1);
  }

  const removed = jobs.splice(idx, 1)[0];
  writeJobs(jobs);
  signalChange();

  console.log(`Deleted cron job "${removed.name}" (ID: ${removed.id})`);
}

function cmdToggle(opts) {
  const { id, enabled } = opts;
  if (!id) { console.log('Error: --id is required'); process.exit(1); }
  if (typeof enabled !== 'boolean') {
    console.log('Error: --enabled must be true or false');
    process.exit(1);
  }

  const jobs = readJobs();
  const job = jobs.find((j) => j.id === id);
  if (!job) {
    console.log(`Error: No job found with ID "${id}"`);
    process.exit(1);
  }

  job.enabled = enabled;
  writeJobs(jobs);
  signalChange();

  const status = enabled ? 'enabled' : 'disabled';
  console.log(`Updated job "${job.name}" -> ${status}`);
}

// ─── Main ──────────────────────────────────────────────────────

const [,, command, ...rest] = process.argv;
const opts = parseArgs(rest);

switch (command) {
  case 'create':
    cmdCreate(opts);
    break;
  case 'list':
    cmdList();
    break;
  case 'delete':
    cmdDelete(opts);
    break;
  case 'toggle':
    cmdToggle(opts);
    break;
  default:
    console.log('Usage:');
    console.log('  node cron-cli.cjs create --name "任务名" --schedule "9:00" --prompt "执行什么"');
    console.log('  node cron-cli.cjs list');
    console.log('  node cron-cli.cjs delete --id <task_id>');
    console.log('  node cron-cli.cjs toggle --id <task_id> --enabled true');
    process.exit(1);
}
