import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

export interface Config {
  feishu: {
    appId: string;
    appSecret: string;
  };
  claude: {
    path: string;
    model: string;
    systemPrompt: string;
  };
  sessionsDir: string;
  maxConcurrent: number;
  maxQueuePerSession: number;
  processTimeout: number;
  logLevel: string;
  adminPort: number;
  adminPasswords: string[];
  relaySecret: string;
  tunnelUrl: string;
}

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function findClaudePath(): string {
  try {
    return execSync('which claude', { encoding: 'utf-8' }).trim();
  } catch {
    return path.join(os.homedir(), '.local/bin/claude');
  }
}

function loadSystemPrompt(): string {
  // Priority: SYSTEM_PROMPT env var > system-prompt/ dir (new) > system-prompt.txt (legacy) > default
  const envPrompt = process.env.SYSTEM_PROMPT;
  if (envPrompt) return envPrompt;

  // New structure: system-prompt/common.md + env.{mode}.md composed at load time.
  // Mode selected via SIGMA_PROMPT_MODE env var (default 'local').
  // When env.{mode}.md is empty, output is byte-identical to common.md.trim() —
  // this is the invariant that preserves Mac-mini behavior after the split.
  const mode = process.env.SIGMA_PROMPT_MODE || 'local';
  const promptDir = path.join(process.cwd(), 'system-prompt');
  try {
    const commonPath = path.join(promptDir, 'common.md');
    if (fs.existsSync(commonPath)) {
      const common = fs.readFileSync(commonPath, 'utf-8').trim();
      const envPath = path.join(promptDir, `env.${mode}.md`);
      let envSpecific = '';
      if (fs.existsSync(envPath)) {
        envSpecific = fs.readFileSync(envPath, 'utf-8').trim();
      }
      return envSpecific ? `${common}\n\n${envSpecific}` : common;
    }
  } catch {
    // Fall through to legacy
  }

  // Legacy fallback: system-prompt.txt at project root
  const promptFile = path.join(process.cwd(), 'system-prompt.txt');
  try {
    if (fs.existsSync(promptFile)) {
      return fs.readFileSync(promptFile, 'utf-8').trim();
    }
  } catch {
    // Fall through to default
  }

  return '你是一个有用的AI助手，通过飞书与用户交流。请用中文回复。';
}

export function loadConfig(): Config {
  return {
    feishu: {
      appId: required('FEISHU_APP_ID'),
      appSecret: required('FEISHU_APP_SECRET'),
    },
    claude: {
      path: optional('CLAUDE_PATH', findClaudePath()),
      model: optional('CLAUDE_MODEL', 'sonnet'),
      systemPrompt: loadSystemPrompt(),
    },
    sessionsDir: optional('SESSIONS_DIR', path.join(process.cwd(), 'sessions')),
    maxConcurrent: parseInt(optional('MAX_CONCURRENT', '3'), 10),
    maxQueuePerSession: parseInt(optional('MAX_QUEUE_PER_SESSION', '10'), 10),
    processTimeout: parseInt(optional('PROCESS_TIMEOUT', '120000'), 10),
    logLevel: optional('LOG_LEVEL', 'info'),
    adminPort: parseInt(optional('ADMIN_PORT', '3333'), 10),
    adminPasswords: optional('ADMIN_PASSWORD', '').split(',').map(s => s.trim()).filter(Boolean),
    relaySecret: optional('RELAY_SECRET', 'sigma-relay-default-secret'),
    tunnelUrl: optional('CF_TUNNEL_URL', ''),
  };
}
