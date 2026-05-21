#!/usr/bin/env node
/**
 * Claude-Mem Proxy MCP — wraps the upstream claude-mem plugin's stdio MCP
 * server (~/.claude/plugins/cache/thedotmack/claude-mem/<v>/scripts/mcp-server.cjs)
 * and enforces per-session project isolation.
 *
 * Why: claude-mem stores observations in ~/.claude-mem/claude-mem.db with a
 * `project` column = cwd basename. Sigma spawns Claude with cwd=sessions/{key},
 * so writes are auto-tagged. Reads (search/timeline/get_observations) however
 * leak across projects unless we filter. This proxy:
 *   1. Forces `project = SIGMA_SESSION_PROJECT` on search / smart_search /
 *      timeline / smart_outline.
 *   2. For get_observations: post-filters by reading the DB directly and
 *      replacing observations whose project differs with an error stub.
 *   3. Pass-through for __IMPORTANT and smart_unfold (no DB access).
 *
 * Bypass: SIGMA_MEM_OVERRIDE=true skips ALL filtering (admin / mother-agent).
 *
 * Config: spawned via mcp-servers.json with env SIGMA_SESSION_PROJECT and
 * (optionally) SIGMA_MEM_OVERRIDE.
 *
 * Lifecycle: upstream stdio child is spawned on demand and auto-restarted if
 * it dies. Stdin/stdout JSON-RPC messages are line-delimited; we buffer.
 */

import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';
import { createRequire } from 'node:module';

// ─── Config from env ─────────────────────────────────────────

const SESSION_PROJECT = process.env.SIGMA_SESSION_PROJECT || '';
const OVERRIDE = process.env.SIGMA_MEM_OVERRIDE === 'true';

if (!SESSION_PROJECT && !OVERRIDE) {
  process.stderr.write('claude-mem-proxy: SIGMA_SESSION_PROJECT not set (and SIGMA_MEM_OVERRIDE not true) — refusing to start.\n');
  process.exit(1);
}

// Resolve upstream plugin path: prefer env override, else discover latest version.
function resolveUpstreamPath(): string {
  const envPath = process.env.SIGMA_CLAUDE_MEM_UPSTREAM;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const home = process.env.HOME || os.homedir();
  const root = path.join(home, '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');
  try {
    const versions = fs.readdirSync(root)
      .filter(d => /^\d+\.\d+\.\d+$/.test(d))
      .sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
          if (pa[i] !== pb[i]) return pb[i] - pa[i];
        }
        return 0;
      });
    for (const v of versions) {
      const candidate = path.join(root, v, 'scripts', 'mcp-server.cjs');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* ignore */ }
  return '';
}

const UPSTREAM_PATH = resolveUpstreamPath();
if (!UPSTREAM_PATH) {
  process.stderr.write('claude-mem-proxy: upstream plugin not found at ~/.claude/plugins/cache/thedotmack/claude-mem/*/scripts/mcp-server.cjs\n');
  process.exit(1);
}

const DB_PATH = process.env.SIGMA_CLAUDE_MEM_DB
  || path.join(process.env.HOME || os.homedir(), '.claude-mem', 'claude-mem.db');

// ─── Upstream child management ───────────────────────────────

interface PendingRequest {
  resolve: (response: any) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

class UpstreamClient {
  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private pending = new Map<string | number, PendingRequest>();
  private nextId = 1_000_000; // leave low IDs for the inbound client

  start(): void {
    if (this.proc) return;
    this.proc = spawn('node', [UPSTREAM_PATH], {
      stdio: ['pipe', 'pipe', 'inherit'], // forward upstream stderr to our stderr
      env: { ...process.env },
    });
    this.proc.on('exit', (code) => {
      process.stderr.write(`claude-mem-proxy: upstream exited (code=${code}), will restart on next request.\n`);
      this.cleanup();
    });
    this.proc.on('error', (err) => {
      process.stderr.write(`claude-mem-proxy: upstream spawn error: ${err.message}\n`);
      this.cleanup();
    });
    this.rl = readline.createInterface({ input: this.proc.stdout! });
    this.rl.on('line', (line) => this.handleUpstreamLine(line));
  }

  private cleanup(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(new Error('Upstream claude-mem MCP died'));
    }
    this.pending.clear();
    this.rl?.close();
    this.rl = null;
    this.proc = null;
  }

  private handleUpstreamLine(line: string): void {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timeout);
      p.resolve(msg);
    }
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params?: any): void {
    if (!this.proc) this.start();
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.proc!.stdin!.write(msg + '\n');
  }

  /** Send a JSON-RPC request and await response. */
  request(method: string, params?: any, timeoutMs = 30_000): Promise<any> {
    if (!this.proc || this.proc.killed) {
      this.start();
    }
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Upstream request '${method}' timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.proc!.stdin!.write(msg + '\n');
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  shutdown(): void {
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    this.cleanup();
  }
}

const upstream = new UpstreamClient();

// ─── Initialize upstream ─────────────────────────────────────

let upstreamInitialized = false;

async function ensureUpstreamInitialized(clientProtocolVersion = '2024-11-05'): Promise<void> {
  if (upstreamInitialized) return;
  upstream.start();
  await upstream.request('initialize', {
    protocolVersion: clientProtocolVersion,
    capabilities: {},
    clientInfo: { name: 'sigma-claude-mem-proxy', version: '1.0.0' },
  });
  upstream.notify('notifications/initialized');
  upstreamInitialized = true;
}

// ─── DB readonly access for get_observations post-filter ────

let dbAccessor: ((ids: number[]) => Map<number, string>) | null = null;

function getDbAccessor(): ((ids: number[]) => Map<number, string>) {
  if (dbAccessor) return dbAccessor;

  // Try better-sqlite3 first (synchronous, fast).
  try {
    // Use createRequire to load CJS native module from this ESM file.
    const req = createRequire(import.meta.url);
    const Database = req('better-sqlite3');
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    dbAccessor = (ids: number[]) => {
      const out = new Map<number, string>();
      if (ids.length === 0) return out;
      const placeholders = ids.map(() => '?').join(',');
      const rows = db.prepare(`SELECT id, project FROM observations WHERE id IN (${placeholders})`).all(...ids) as Array<{ id: number; project: string }>;
      for (const r of rows) out.set(r.id, r.project);
      return out;
    };
    return dbAccessor;
  } catch (err: any) {
    process.stderr.write(`claude-mem-proxy: better-sqlite3 unavailable (${err?.message || err}), falling back to sqlite3 CLI.\n`);
  }

  // Fallback: shell out to sqlite3 CLI.
  dbAccessor = (ids: number[]) => {
    const out = new Map<number, string>();
    if (ids.length === 0) return out;
    const list = ids.map((i) => String(parseInt(String(i), 10))).filter((s) => /^\d+$/.test(s));
    if (list.length === 0) return out;
    const sql = `SELECT id || '|' || project FROM observations WHERE id IN (${list.join(',')});`;
    try {
      const stdout = execFileSync('sqlite3', ['-readonly', DB_PATH, sql], { encoding: 'utf-8' });
      for (const line of stdout.split('\n')) {
        const idx = line.indexOf('|');
        if (idx < 0) continue;
        const id = parseInt(line.slice(0, idx), 10);
        if (Number.isFinite(id)) out.set(id, line.slice(idx + 1));
      }
    } catch (err: any) {
      process.stderr.write(`claude-mem-proxy: sqlite3 CLI failed: ${err?.message || err}\n`);
    }
    return out;
  };
  return dbAccessor;
}

// ─── Tool list (mirrors upstream, minus smart_explore which isn't exposed) ─

const TOOL_NAMES_FILTERED = new Set([
  'search', 'smart_search', 'timeline', 'smart_outline',
]);
const TOOL_NAMES_OBSERVATIONS = 'get_observations';
const TOOL_NAMES_PASSTHROUGH = new Set(['__IMPORTANT', 'smart_unfold']);

// ─── Inbound (Claude → us) handling ─────────────────────────

const inboundRl = readline.createInterface({ input: process.stdin });

function send(msg: any): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id: number | string, result: any): void {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id: number | string, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleToolsCall(id: number | string, params: any): Promise<void> {
  const name: string = params?.name;
  const args: any = params?.arguments || {};

  // Override: pass everything through unchanged.
  if (OVERRIDE) {
    try {
      const resp = await upstream.request('tools/call', params, 60_000);
      if (resp.error) sendError(id, resp.error.code ?? -32000, resp.error.message ?? 'upstream error');
      else sendResult(id, resp.result);
    } catch (err: any) {
      sendError(id, -32000, err?.message || String(err));
    }
    return;
  }

  // Filtered tools: inject project parameter.
  if (TOOL_NAMES_FILTERED.has(name)) {
    const merged = { ...args, project: SESSION_PROJECT };
    try {
      const resp = await upstream.request('tools/call', { name, arguments: merged }, 60_000);
      if (resp.error) sendError(id, resp.error.code ?? -32000, resp.error.message ?? 'upstream error');
      else sendResult(id, resp.result);
    } catch (err: any) {
      sendError(id, -32000, err?.message || String(err));
    }
    return;
  }

  // Pass-through tools (no DB / no project).
  if (TOOL_NAMES_PASSTHROUGH.has(name)) {
    try {
      const resp = await upstream.request('tools/call', { name, arguments: args }, 60_000);
      if (resp.error) sendError(id, resp.error.code ?? -32000, resp.error.message ?? 'upstream error');
      else sendResult(id, resp.result);
    } catch (err: any) {
      sendError(id, -32000, err?.message || String(err));
    }
    return;
  }

  // get_observations: post-filter by checking project for each ID.
  if (name === TOOL_NAMES_OBSERVATIONS) {
    const requestedIds: number[] = Array.isArray(args.ids)
      ? args.ids.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n))
      : [];
    let allowedIds: number[] = requestedIds;
    let blockedIds: number[] = [];
    try {
      const projectMap = getDbAccessor()(requestedIds);
      allowedIds = [];
      blockedIds = [];
      for (const oid of requestedIds) {
        const proj = projectMap.get(oid);
        if (proj === undefined) {
          // Unknown ID — let upstream tell client (likely "not found")
          allowedIds.push(oid);
        } else if (proj === SESSION_PROJECT) {
          allowedIds.push(oid);
        } else {
          blockedIds.push(oid);
        }
      }
    } catch (err: any) {
      // If DB lookup fails, fail closed: refuse.
      sendError(id, -32000, `claude-mem-proxy: DB lookup failed (${err?.message || err}); refusing to pass IDs through.`);
      return;
    }

    try {
      const upstreamArgs = { ...args, ids: allowedIds, project: SESSION_PROJECT };
      const resp = await upstream.request('tools/call', { name, arguments: upstreamArgs }, 60_000);
      if (resp.error) {
        sendError(id, resp.error.code ?? -32000, resp.error.message ?? 'upstream error');
        return;
      }
      // Append a notice about blocked IDs (if any).
      let result = resp.result;
      if (blockedIds.length > 0) {
        const note = `\n\n[sigma-claude-mem-proxy] Blocked ${blockedIds.length} observation(s) from other projects: [${blockedIds.join(', ')}]. Each is "not_accessible_from_this_session".`;
        if (result && Array.isArray(result.content)) {
          result = {
            ...result,
            content: [...result.content, { type: 'text', text: note }],
          };
        }
      }
      sendResult(id, result);
    } catch (err: any) {
      sendError(id, -32000, err?.message || String(err));
    }
    return;
  }

  // Unknown tool — forward as-is.
  try {
    const resp = await upstream.request('tools/call', params, 60_000);
    if (resp.error) sendError(id, resp.error.code ?? -32000, resp.error.message ?? 'upstream error');
    else sendResult(id, resp.result);
  } catch (err: any) {
    sendError(id, -32000, err?.message || String(err));
  }
}

async function handleRequest(req: any): Promise<void> {
  const { id, method, params } = req;

  try {
    switch (method) {
      case 'initialize': {
        // Forward client's protocol version to upstream so we negotiate
        // compatibly.
        const protocolVersion = params?.protocolVersion || '2024-11-05';
        await ensureUpstreamInitialized(protocolVersion);
        sendResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'sigma-claude-mem-proxy', version: '1.0.0' },
        });
        return;
      }
      case 'tools/list': {
        await ensureUpstreamInitialized();
        const resp = await upstream.request('tools/list');
        if (resp.error) {
          sendError(id, resp.error.code ?? -32000, resp.error.message ?? 'upstream error');
          return;
        }
        sendResult(id, resp.result);
        return;
      }
      case 'tools/call': {
        await ensureUpstreamInitialized();
        await handleToolsCall(id, params);
        return;
      }
      case 'ping': {
        sendResult(id, {});
        return;
      }
      default: {
        // Forward anything else upstream verbatim.
        try {
          await ensureUpstreamInitialized();
          const resp = await upstream.request(method, params);
          if (resp.error) sendError(id, resp.error.code ?? -32000, resp.error.message ?? 'upstream error');
          else sendResult(id, resp.result);
        } catch (err: any) {
          sendError(id, -32601, `Method not found or upstream error: ${method}`);
        }
        return;
      }
    }
  } catch (err: any) {
    sendError(id, -32000, err?.message || String(err));
  }
}

// When stdin closes (parent went away), shut down cleanly.
inboundRl.on('close', () => {
  upstream.shutdown();
  // Give upstream a moment to clean up, then exit.
  setTimeout(() => process.exit(0), 100).unref();
});

inboundRl.on('line', (line) => {
  let req: any;
  try { req = JSON.parse(line); } catch { return; }

  // Notifications (no id) — forward to upstream if init is done, else drop.
  if (req.id === undefined) {
    if (req.method === 'notifications/initialized') {
      // We already sent our own to upstream during init handshake; ignore.
      return;
    }
    if (upstreamInitialized) {
      try { upstream.notify(req.method, req.params); } catch { /* ignore */ }
    }
    return;
  }

  void handleRequest(req);
});

// ─── Graceful shutdown ───────────────────────────────────────

function shutdown(): void {
  upstream.shutdown();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('exit', () => {
  upstream.shutdown();
});
