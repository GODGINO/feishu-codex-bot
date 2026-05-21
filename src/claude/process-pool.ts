import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { Logger } from '../utils/logger.js';
import type { Config } from '../config.js';
import { StreamParser, type ParseResult, type LiveUsage } from './stream-parser.js';
import type { RunResult, ImageAttachment } from './runner.js';

export interface SendOptions {
  sessionKey: string;
  sessionDir: string;
  message: string;
  images?: ImageAttachment[];
  abortSignal?: AbortSignal;
}

interface PersistentProcess {
  proc: ChildProcess;
  sessionKey: string;
  sessionDir: string;
  sessionId?: string;
  state: 'starting' | 'idle' | 'busy';
  parser: StreamParser;
  readyPromise: Promise<void>;
  readyResolve?: () => void;
  currentResolve?: (result: RunResult) => void;
  currentReject?: (err: Error) => void;
  mcpConfigMtime?: number; // mtime of mcp-servers.json when process was spawned
  lastActivity: number; // timestamp of last stdout event
  intentionalAbort?: boolean; // true when killed via /stop (preserve sessionId for resume)
  model?: string; // resolved model string passed to --model (e.g. "sonnet[1m]")
}

const KILL_GRACE_MS = 5000;
const STATE_FILE = 'process-pool-state.json';

export type UnsolicitedResultCallback = (sessionKey: string, result: RunResult) => void;
export type ProgressCallback = (sessionKey: string, toolName: string, toolInput?: string) => void;
export type TextStreamCallback = (sessionKey: string, fullText: string, liveUsage?: LiveUsage & { model?: string }) => void;
export type ToolStreamCallback = (sessionKey: string, event: {
  type: 'start' | 'end';
  toolName: string;
  toolInput?: string;
  toolUseId?: string;
  isError?: boolean;
}) => void;
export type ThinkingStreamCallback = (sessionKey: string, thinking: string) => void;

/** Persistent callback for subagent lifecycle events — survives across turns. */
export type SubagentStreamCallback = (sessionKey: string, event: {
  type: 'started' | 'progress' | 'completed' | 'stopped';
  taskId: string;
  toolUseId?: string;
  description?: string;
  summary?: string;
  toolName?: string;
  taskType?: string; // 'local_agent' = real background agent, 'local_bash' = background bash
}) => void;

export class ProcessPool {
  private processes = new Map<string, PersistentProcess>();
  private savedSessionIds = new Map<string, string>(); // sessionKey -> sessionId (for crash recovery)
  private statePath: string;
  private unsolicitedCallback?: UnsolicitedResultCallback;
  private progressCallback?: ProgressCallback;
  private textStreamCallbacks = new Map<string, TextStreamCallback>();
  private toolStreamCallbacks = new Map<string, ToolStreamCallback>();
  private thinkingStreamCallbacks = new Map<string, ThinkingStreamCallback>();
  private subagentStreamCallbacks = new Map<string, SubagentStreamCallback>();

  constructor(
    private config: Config,
    private sessionsDir: string,
    private logger: Logger,
  ) {
    this.statePath = path.join(path.dirname(sessionsDir), STATE_FILE);
    this.loadState();
  }

  /**
   * Register callback for unsolicited results (e.g. background agent completion).
   * Called when a result event arrives but no send() is pending.
   */
  onUnsolicitedResult(callback: UnsolicitedResultCallback): void {
    this.unsolicitedCallback = callback;
  }

  /**
   * Register callback for progress events (tool_use detected in stream).
   */
  onProgress(callback: ProgressCallback): void {
    this.progressCallback = callback;
  }


  /**
   * Register callback for text streaming (called with accumulated full text on each assistant event).
   * Per-session: multiple sessions can have concurrent callbacks.
   */
  onTextStream(sessionKey: string, callback: TextStreamCallback | undefined): void {
    if (callback) {
      this.textStreamCallbacks.set(sessionKey, callback);
    } else {
      this.textStreamCallbacks.delete(sessionKey);
    }
  }

  /**
   * Register callback for tool call events (start/end).
   * Per-session: multiple sessions can have concurrent callbacks.
   */
  onToolStream(sessionKey: string, callback: ToolStreamCallback | undefined): void {
    if (callback) {
      this.toolStreamCallbacks.set(sessionKey, callback);
    } else {
      this.toolStreamCallbacks.delete(sessionKey);
    }
  }

  onThinkingStream(sessionKey: string, callback: ThinkingStreamCallback | undefined): void {
    if (callback) this.thinkingStreamCallbacks.set(sessionKey, callback);
    else this.thinkingStreamCallbacks.delete(sessionKey);
  }

  /**
   * Register persistent callback for subagent lifecycle events.
   * Unlike toolStream, this survives across turns — fires even after result.
   */
  onSubagentStream(sessionKey: string, callback: SubagentStreamCallback | undefined): void {
    if (callback) {
      this.subagentStreamCallbacks.set(sessionKey, callback);
    } else {
      this.subagentStreamCallbacks.delete(sessionKey);
    }
  }

  /**
   * Get the timestamp of the last stdout activity for a session.
   * Returns 0 if the session doesn't exist.
   */
  getLastActivity(sessionKey: string): number {
    return this.processes.get(sessionKey)?.lastActivity ?? 0;
  }

  /**
   * Translate tool name to Chinese description for progress messages.
   */
  static describeToolUse(name: string): string {
    const map: Record<string, string> = {
      WebSearch: '搜索网页',
      WebFetch: '浏览网页',
      Agent: '后台执行中',
      Read: '读取文件',
      Edit: '编辑文件',
      Write: '编辑文件',
      Bash: '执行命令',
      Grep: '搜索代码',
      Glob: '搜索代码',
    };
    return map[name] || name;
  }

  /**
   * Send a message to the persistent process for a session.
   * Spawns process on first message (no MCP = fast startup).
   * Chrome MCP is lazy-loaded via start-chrome.sh when needed.
   */
  async send(opts: SendOptions): Promise<RunResult> {
    let pp = this.processes.get(opts.sessionKey);

    if (!pp) {
      const resumeId = this.savedSessionIds.get(opts.sessionKey);
      pp = this.spawn(opts.sessionKey, opts.sessionDir, resumeId);
    }

    // Check if MCP config changed (e.g. start-chrome.sh activated chrome-devtools MCP).
    // If so, respawn with --resume to pick up the new MCP servers.
    if (pp.state !== 'starting' && this.mcpConfigChanged(pp)) {
      this.logger.info({ sessionKey: opts.sessionKey }, 'MCP config changed, respawning with --resume');
      const resumeId = pp.sessionId || this.savedSessionIds.get(opts.sessionKey);
      this.killProcessHard(pp.proc);
      this.processes.delete(opts.sessionKey);
      pp = this.spawn(opts.sessionKey, opts.sessionDir, resumeId);
      // Clean up .mcp-changed signal file
      try { fs.unlinkSync(path.join(opts.sessionDir, '.mcp-changed')); } catch { /* ignore */ }
    }

    // In stream-json + --resume mode, Claude waits for the first stdin message before
    // emitting the system/init event. So we skip waiting and send immediately.
    // The init event will arrive as part of the response stream and be handled by handleParseResult.
    if (pp.state === 'starting') {
      this.logger.info({ sessionKey: opts.sessionKey }, 'Process starting — sending message immediately (no wait)');
      pp.state = 'busy';
      pp.parser.reset();
    } else if (pp.state === 'busy') {
      // Should not happen if message-bridge has runningTasks lock, but guard anyway
      throw new Error(`Process for ${opts.sessionKey} is busy`);
    } else {
      pp.state = 'busy';
      pp.parser.reset();
    }

    // Build the stream-json message
    const stdinMsg = this.buildStdinMessage(opts.message, opts.images);

    // Set up abort handler — send SIGINT to gracefully stop current turn, not kill the process.
    // This preserves the process and sessionId so --resume works on next message.
    if (opts.abortSignal) {
      const onAbort = () => {
        this.logger.info({ sessionKey: opts.sessionKey }, 'Abort signal received, sending SIGINT');
        this.abort(opts.sessionKey);
      };
      opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    return new Promise<RunResult>((resolve, reject) => {
      pp!.currentResolve = resolve;
      pp!.currentReject = reject;

      // Write message to stdin
      const ok = pp!.proc.stdin?.write(stdinMsg + '\n');
      if (ok === undefined) {
        // stdin is null — should not happen with stdio: 'pipe'
        pp!.state = 'idle';
        reject(new Error('Claude process stdin is not available'));
      }
      // ok === false means backpressure — data IS queued and will be delivered.
      // Do NOT reject here. If the process is dead, the 'close' or 'error'
      // event handlers will reject the promise via currentReject.
    });
  }

  /**
   * Abort a specific session's process (/stop command).
   * Saves sessionId for crash recovery, kills the process.
   */
  abort(sessionKey: string): void {
    const pp = this.processes.get(sessionKey);
    if (!pp) return;

    // Mark as intentional so close handler preserves sessionId for --resume
    pp.intentionalAbort = true;

    // Send SIGINT (Ctrl+C equivalent) to stop the current task without killing the process.
    // Claude Code CLI handles SIGINT by stopping the current turn and emitting a result event.
    if (pp.proc.pid && !pp.proc.killed) {
      this.logger.info({ sessionKey }, 'Sending SIGINT to stop current task');
      pp.proc.kill('SIGINT');
    }
  }

  /**
   * Respawn a session (e.g. model change).
   * Kills the process but KEEPS saved sessionId.
   * Next message will spawn with --resume = same context, new config.
   */
  respawn(sessionKey: string): void {
    const pp = this.processes.get(sessionKey);
    if (pp) {
      this.killProcessHard(pp.proc);
      if (pp.currentReject) {
        pp.currentReject(new Error('Session respawn'));
        pp.currentResolve = undefined;
        pp.currentReject = undefined;
      }
      this.processes.delete(sessionKey);
    }
    // Keep savedSessionIds intact — next spawn uses --resume
  }

  /**
   * Read the saved sessionId for a sessionKey, or null if not registered.
   * Used by /并行 to clone the parent sessionId into the fork sessionKey so
   * fork agents resume the same transcript stream.
   */
  getSavedSessionId(sessionKey: string): string | null {
    return this.savedSessionIds.get(sessionKey) || null;
  }

  /**
   * Pre-register a sessionId for a sessionKey before its first spawn. Next
   * spawn for this key will use `--resume <id>` from the start. Used by /并行
   * to make fork agents share the parent's transcript.
   */
  setSavedSessionId(sessionKey: string, sessionId: string): void {
    this.savedSessionIds.set(sessionKey, sessionId);
    this.saveState();
  }

  /**
   * Reset a session (/new command).
   * Kills the process and clears saved sessionId.
   * Next message will spawn a fresh process WITHOUT --resume = clean context.
   */
  reset(sessionKey: string): void {
    const pp = this.processes.get(sessionKey);
    if (pp) {
      this.killProcessHard(pp.proc);
      if (pp.currentReject) {
        pp.currentReject(new Error('Session reset'));
        pp.currentResolve = undefined;
        pp.currentReject = undefined;
      }
      this.processes.delete(sessionKey);
    }
    // Clear saved sessionId so next spawn does NOT use --resume
    this.savedSessionIds.delete(sessionKey);
    this.saveState();
  }

  /**
   * Kill all processes (bot shutdown).
   */
  killAll(): void {
    this.saveState();
    for (const pp of this.processes.values()) {
      this.killProcessHard(pp.proc);
    }
    this.processes.clear();
  }

  /**
   * Get the model for a session (per-session override or global default).
   */
  private static MODEL_ALIASES: Record<string, string> = {
    // Haiku
    'haiku':           'haiku',
    // Sonnet (current)
    'sonnet':          'claude-sonnet-4-6[1m]',
    'sonnet 1m':       'claude-sonnet-4-6[1m]',
    'sonnet 200k':     'claude-sonnet-4-6',
    // Opus 4.6 (previous flagship — kept for tokenizer compatibility)
    'opus 4.6':        'claude-opus-4-6[1m]',
    'opus 4.6 1m':     'claude-opus-4-6[1m]',
    'opus 4.6 200k':   'claude-opus-4-6',
    // Opus 4.7 (current flagship)
    'opus':            'claude-opus-4-7[1m]',
    'opus 1m':         'claude-opus-4-7[1m]',
    'opus 200k':       'claude-opus-4-7',
  };

  private getSessionModel(sessionKey: string, sessionDir: string): string {
    let raw = this.config.claude.model;
    try {
      const modelFile = path.join(sessionDir, 'model');
      if (fs.existsSync(modelFile)) {
        const content = fs.readFileSync(modelFile, 'utf-8').trim();
        if (content) raw = content;
      }
    } catch { /* ignore */ }
    return ProcessPool.MODEL_ALIASES[raw] || raw;
  }

  private getSessionEffort(sessionDir: string): string | null {
    try {
      const effortFile = path.join(sessionDir, 'effort');
      if (fs.existsSync(effortFile)) {
        const effort = fs.readFileSync(effortFile, 'utf-8').trim();
        if (effort && effort !== 'auto') return effort;
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Number of currently busy processes.
   */
  get activeCount(): number {
    let count = 0;
    for (const pp of this.processes.values()) {
      if (pp.state === 'busy') count++;
    }
    return count;
  }

  /**
   * Spawn a new persistent Claude Code process for a session.
   * Initial spawn has no MCP servers (fast ~5s startup).
   * Chrome MCP is added later by start-chrome.sh, triggering respawn via mcpConfigChanged().
   */
  private spawn(sessionKey: string, sessionDir: string, resumeId?: string): PersistentProcess {
    const args: string[] = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', this.getSessionModel(sessionKey, sessionDir),
      '--dangerously-skip-permissions',
    ];

    const effort = this.getSessionEffort(sessionDir);
    if (effort) {
      args.push('--effort', effort);
    }

    // Load per-session MCP config for stdio-only MCP servers.
    // NOTE: --strict-mcp-config is NOT used because it blocks settings.json MCP servers,
    // which is where Feishu Streamable HTTP MCP lives (url-type MCP is not supported in --mcp-config).
    const mcpConfigPath = path.join(sessionDir, 'mcp-servers.json');
    if (fs.existsSync(mcpConfigPath)) {
      args.push('--mcp-config', mcpConfigPath);
    }

    // Append system prompt with session isolation rules
    const isolationRule = `\n[安全隔离] 你的工作目录是 ${sessionDir}，这是你唯一允许操作的目录。
- 严禁访问父目录（../）、其他 session 目录、~/、/tmp 等任何外部路径
- 严禁在父目录或项目根目录执行 find、ls、cat、grep 等命令（会暴露其他用户的 session）
- 安装 skill 时必须安装到当前目录的 .claude/skills/ 下，不要安装到全局
- 执行 npx 命令时确保当前工作目录是 ${sessionDir}
- SSH 密钥只使用当前目录下的 ssh_key/
- ./shared/ 是跨 session 共享目录，可以在此读写文件用于跨会话知识传递（如保存报告、数据、配置等供其他 session 使用）`;
    const systemPrompt = (this.config.claude.systemPrompt || '') + isolationRule;
    args.push('--append-system-prompt', systemPrompt);

    // Resume from saved session (crash recovery)
    if (resumeId) {
      args.push('--resume', resumeId);
    }

    const model = args[args.indexOf('--model') + 1];
    this.logger.info(
      { sessionKey, sessionDir, hasResume: !!resumeId, model, effort: effort || 'auto' },
      'Spawning persistent Claude process',
    );

    // Build clean env: remove ALL Claude Code nesting detection variables
    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (key.startsWith('CLAUDE') || key === 'ANTHROPIC_INNER') {
        delete cleanEnv[key];
      }
    }

    // Load session environment variables from session.env
    const sessionEnvVars: Record<string, string> = {};
    try {
      const envContent = fs.readFileSync(path.join(sessionDir, 'session.env'), 'utf-8');
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          sessionEnvVars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
        }
      }
    } catch { /* no session.env */ }

    const realHome = process.env.HOME || '';
    const spawnEnv = {
      ...cleanEnv,
      ...sessionEnvVars,
      ENABLE_TOOL_SEARCH: 'true',
      MCP_TIMEOUT: '30000',
      // HOME: keep original (changing breaks Claude Code CLI)
      PATH: `${path.dirname(process.execPath)}:${realHome}/.local/bin:${realHome}/.bun/bin:${realHome}/homebrew/bin:${process.env.PATH}`,
      // Session isolation: prevent git from traversing above session dir
      GIT_CEILING_DIRECTORIES: path.dirname(sessionDir),
      // SESSION_DIR used by skill scripts (cron-cli.cjs, etc.)
      SESSION_DIR: sessionDir,
    };

    // Debug: log claude-related vars and spawn args
    const remainingClaudeVars = Object.keys(spawnEnv).filter(k => k.startsWith('CLAUDE') || k === 'ANTHROPIC_INNER');
    this.logger.info({ sessionKey, remainingClaudeVars, claudePath: this.config.claude.path }, 'Spawn env debug');

    // Dump spawn env and args to debug file
    const debugInfo = { args, env: spawnEnv, claudePath: this.config.claude.path, cwd: sessionDir };
    try { fs.writeFileSync(path.join(sessionDir, '.spawn-debug.json'), JSON.stringify(debugInfo, null, 2)); } catch {}

    const proc = spawn(this.config.claude.path, args, {
      cwd: sessionDir,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Catch EPIPE on stdin to prevent unhandled error crashing the entire bot process.
    // EPIPE occurs when the child process dies and we try to write to its stdin.
    proc.stdin?.on('error', (err) => {
      this.logger.warn({ err, sessionKey }, 'stdin write error (child process likely dead)');
    });

    const parser = new StreamParser();
    let readyResolve: (() => void) | undefined;
    const readyPromise = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });

    // Record mcp-servers.json mtime for change detection
    let mcpConfigMtime: number | undefined;
    try {
      const stat = fs.statSync(mcpConfigPath);
      mcpConfigMtime = stat.mtimeMs;
    } catch { /* no config file */ }

    const pp: PersistentProcess = {
      proc,
      sessionKey,
      sessionDir,
      sessionId: resumeId,
      state: 'starting',
      parser,
      readyPromise,
      readyResolve,
      mcpConfigMtime,
      lastActivity: Date.now(),
      model,
    };

    this.processes.set(sessionKey, pp);

    // Safety timeout: if no event with session_id arrives within 30s,
    // mark as ready anyway as a fallback. (Reduced from 120s since chrome MCP is now lazy-loaded.)
    const readyTimeout = setTimeout(() => {
      if (pp.state === 'starting' && pp.readyResolve) {
        this.logger.warn({ sessionKey }, 'Ready timeout — marking process as ready without system event');
        pp.state = 'idle';
        pp.readyResolve();
        pp.readyResolve = undefined;
      }
    }, 30_000);
    readyTimeout.unref();
    // Clear timeout when ready resolves normally
    readyPromise.then(() => clearTimeout(readyTimeout));

    // Parse stdout continuously
    const rl = readline.createInterface({ input: proc.stdout! });
    let lineCount = 0;
    rl.on('line', (line) => {
      lineCount++;
      pp.lastActivity = Date.now();
      // Log first 10 lines to debug startup events
      if (lineCount <= 10) {
        try {
          const parsed = JSON.parse(line);
          this.logger.info(
            { sessionKey, lineNum: lineCount, type: parsed.type, subtype: parsed.subtype, hasSessionId: !!parsed.session_id },
            'Stdout line received',
          );
        } catch {
          this.logger.info({ sessionKey, lineNum: lineCount, raw: line.slice(0, 100) }, 'Stdout non-JSON line');
        }
      }
      // Log rate_limit_event with full payload
      try {
        const raw = JSON.parse(line);
        if (raw.type === 'rate_limit_event') {
          this.logger.warn({ sessionKey, payload: JSON.stringify(raw).slice(0, 500) }, 'Rate limit event');
        }
        if (raw.type === 'system' && (raw.subtype === 'task_progress' || raw.subtype === 'task_started' || raw.subtype === 'task_notification')) {
          this.logger.info({ sessionKey, subtype: raw.subtype, payload: JSON.stringify(raw).slice(0, 500) }, 'Subagent event');
        }
      } catch {}
      const result = parser.parseLine(line);
      if (result.toolUse) {
        this.logger.info({ sessionKey, toolName: result.toolUse.name }, 'Tool use detected');
      }
      this.handleParseResult(pp, result);
    });

    // Capture stderr for logging
    let stderr = '';
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      // Keep only last 2KB
      if (stderr.length > 2048) {
        stderr = stderr.slice(-2048);
      }
    });

    // Handle process exit (crash or kill)
    proc.on('close', (code) => {
      this.logger.warn(
        { sessionKey, code, stderr: stderr.slice(0, 500) },
        'Persistent Claude process exited',
      );

      // Guard: only clean up if this process is still the active one for this session.
      const current = this.processes.get(sessionKey);
      if (current !== pp) {
        this.logger.info({ sessionKey }, 'Ignoring close event from replaced process');
        return;
      }

      // Always preserve sessionId if we have one — even on unexpected exits,
      // --resume can recover the conversation. Only discard if we never got a sessionId.
      if (pp.sessionId) {
        this.savedSessionIds.set(sessionKey, pp.sessionId);
        this.saveState();
      }

      // Reject any pending request
      if (pp.currentReject) {
        pp.currentReject(new Error(`Claude process exited with code ${code}`));
        pp.currentResolve = undefined;
        pp.currentReject = undefined;
      }

      // Also resolve ready promise if still starting
      if (pp.state === 'starting' && pp.readyResolve) {
        pp.readyResolve();
      }

      this.processes.delete(sessionKey);
    });

    proc.on('error', (err) => {
      this.logger.error({ err, sessionKey }, 'Persistent Claude process error');
      const current = this.processes.get(sessionKey);
      if (current !== pp) return;
      if (pp.currentReject) {
        pp.currentReject(err);
        pp.currentResolve = undefined;
        pp.currentReject = undefined;
      }
      this.processes.delete(sessionKey);
    });

    return pp;
  }

  /**
   * Handle a parsed stream-json event from stdout.
   */
  private handleParseResult(pp: PersistentProcess, result: ParseResult): void {
    // system/init event → process is ready
    if (result.sessionId) {
      pp.sessionId = result.sessionId;
      if (pp.state === 'starting' && pp.readyResolve) {
        pp.state = 'idle';
        pp.readyResolve();
        pp.readyResolve = undefined;
        this.logger.info(
          { sessionKey: pp.sessionKey, sessionId: result.sessionId },
          'Persistent Claude process ready',
        );

        // Save sessionId for crash recovery
        this.savedSessionIds.set(pp.sessionKey, result.sessionId);
        this.saveState();
      }
    }

    // Progress callback: notify when Claude uses a tool
    if (result.toolUse && this.progressCallback) {
      this.progressCallback(pp.sessionKey, result.toolUse.name, result.toolUse.input);
    }

    // Per-session stream callbacks
    const textCb = this.textStreamCallbacks.get(pp.sessionKey);
    const toolCb = this.toolStreamCallbacks.get(pp.sessionKey);

    // Text stream callback: notify with accumulated text
    // Only log at warn level when callbacks are missing (debugging aid), otherwise debug
    if (result.text || result.toolUse || result.toolResult) {
      const missingCb = pp.currentResolve && ((result.text && !textCb) || (result.toolUse && !toolCb));
      this.logger[missingCb ? 'warn' : 'debug']({
        sessionKey: pp.sessionKey,
        hasResolve: !!pp.currentResolve,
        hasTextCb: !!textCb,
        hasToolCb: !!toolCb,
        hasText: !!result.text,
        hasToolUse: !!result.toolUse,
        hasToolResult: !!result.toolResult,
      }, missingCb ? 'Stream callback missing' : 'Stream event check');
    }
    // Fire textCb on any assistant event (text OR tool_use) so the live footer's
    // usage numbers refresh even on tool-only turns. onText is idempotent — it just
    // stores pendingText and the streamer throttles flushes.
    if ((result.text || result.toolUse) && pp.currentResolve && textCb) {
      textCb(pp.sessionKey, pp.parser.fullText, { ...pp.parser.liveUsage, model: pp.model });
    }

    // Thinking stream: fires once per assistant message that contains a thinking block
    if (result.thinking && pp.currentResolve) {
      const thinkingCb = this.thinkingStreamCallbacks.get(pp.sessionKey);
      if (thinkingCb) thinkingCb(pp.sessionKey, result.thinking);
    }

    // Tool stream callbacks: start and end events
    if (result.toolUse && pp.currentResolve && toolCb) {
      toolCb(pp.sessionKey, {
        type: 'start',
        toolName: result.toolUse.name,
        toolInput: result.toolUse.input,
        toolUseId: result.toolUse.toolUseId,
      });
    }
    if (result.toolResult && pp.currentResolve && toolCb) {
      toolCb(pp.sessionKey, {
        type: 'end',
        toolName: '',
        toolUseId: result.toolResult.toolUseId,
        isError: result.toolResult.isError,
      });
    }

    // Subagent end: mark Agent tool as complete (during active turn)
    if (result.subagentEnd && pp.currentResolve && toolCb) {
      toolCb(pp.sessionKey, {
        type: 'end',
        toolName: 'Agent',
        toolUseId: result.subagentEnd.toolUseId,
        isError: result.subagentEnd.status === 'stopped',
      });
    }

    // Persistent subagent callbacks — fire regardless of currentResolve
    const subagentCb = this.subagentStreamCallbacks.get(pp.sessionKey);
    if (subagentCb) {
      if (result.subagentStart) {
        subagentCb(pp.sessionKey, {
          type: 'started',
          taskId: result.subagentStart.taskId,
          toolUseId: result.subagentStart.toolUseId,
          description: result.subagentStart.description,
          taskType: result.subagentStart.taskType,
        });
      }
      if (result.subagentProgress) {
        subagentCb(pp.sessionKey, {
          type: 'progress',
          taskId: result.subagentProgress.taskId,
          toolUseId: result.subagentProgress.toolUseId,
          toolName: result.subagentProgress.toolName,
          description: result.subagentProgress.description,
        });
      }
      if (result.subagentEnd) {
        subagentCb(pp.sessionKey, {
          type: result.subagentEnd.status === 'completed' ? 'completed' : 'stopped',
          taskId: result.subagentEnd.taskId,
          toolUseId: result.subagentEnd.toolUseId,
          summary: result.subagentEnd.summary,
        });
      }
    }

    // Detect unsolicited text (output arriving when no send() is pending).
    // This happens when a background agent completes and Claude emits a follow-up.
    // Reset parser to avoid mixing with previous turn's text.
    if (result.text && pp.state === 'idle' && !pp.currentResolve) {
      this.logger.info({ sessionKey: pp.sessionKey, textLen: result.text.length }, 'Unsolicited text detected, resetting parser');
      pp.parser.reset();
      pp.parser['_fullText'] = result.text;
      pp.state = 'busy'; // Mark busy for the unsolicited turn
    }

    // result event → turn complete
    if (result.done) {
      const runResult: RunResult = {
        fullText: pp.parser.fullText,
        sessionId: pp.sessionId,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheCreationTokens: result.cacheCreationTokens,
        peakCallInputTokens: result.peakCallInputTokens,
        peakCallCacheReadTokens: result.peakCallCacheReadTokens,
        peakCallCacheCreationTokens: result.peakCallCacheCreationTokens,
        model: pp.model,
        error: result.error,
      };

      // Prompt caching diagnostic: log usage breakdown so we can tell whether
      // the v2.1.69+ --print/--resume cache regression (github #34629) is biting us.
      const totalPrompt = (result.inputTokens || 0) + (result.cacheReadTokens || 0) + (result.cacheCreationTokens || 0);
      const hitPct = totalPrompt > 0 ? Math.round((result.cacheReadTokens || 0) * 100 / totalPrompt) : 0;
      const peakPrompt = (result.peakCallInputTokens || 0) + (result.peakCallCacheReadTokens || 0) + (result.peakCallCacheCreationTokens || 0);
      this.logger.info({
        sessionKey: pp.sessionKey,
        input: result.inputTokens || 0,
        cacheRead: result.cacheReadTokens || 0,
        cacheCreation: result.cacheCreationTokens || 0,
        output: result.outputTokens || 0,
        totalPrompt,
        peakCallPrompt: peakPrompt,
        cacheHitPct: hitPct,
        costUsd: result.costUsd,
      }, 'Turn usage');

      // Update saved sessionId — but NOT if this turn had an error
      // (error_during_execution with a corrupted --resume session must not be re-saved)
      if (pp.sessionId && !result.error) {
        this.savedSessionIds.set(pp.sessionKey, pp.sessionId);
        this.saveState();
      }

      pp.state = 'idle';

      if (pp.currentResolve) {
        pp.currentResolve(runResult);
        pp.currentResolve = undefined;
        pp.currentReject = undefined;
      } else if (runResult.fullText && this.unsolicitedCallback) {
        // No pending send() — this is unsolicited output (e.g. background agent completion)
        this.logger.info(
          { sessionKey: pp.sessionKey, textLen: runResult.fullText.length },
          'Unsolicited result received (background agent?)',
        );
        this.unsolicitedCallback(pp.sessionKey, runResult);
      }
    }
  }

  /**
   * Build a stream-json stdin message.
   */
  private buildStdinMessage(message: string, images?: ImageAttachment[]): string {
    let content: any;

    if (images && images.length > 0) {
      // Multimodal: array of content blocks
      const blocks: any[] = [];
      if (message) {
        blocks.push({ type: 'text', text: message });
      }
      for (const img of images) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mediaType,
            data: img.base64,
          },
        });
      }
      content = blocks;
    } else {
      // Text only: simple string
      content = message;
    }

    return JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content,
      },
      parent_tool_use_id: null,
    });
  }

  /**
   * Kill a process gracefully (SIGTERM, then SIGKILL after grace period).
   */
  private killProcess(pp: PersistentProcess): void {
    // Save sessionId before killing
    if (pp.sessionId) {
      this.savedSessionIds.set(pp.sessionKey, pp.sessionId);
      this.saveState();
    }

    this.killProcessHard(pp.proc);
  }

  private killProcessHard(proc: ChildProcess): void {
    if (proc.killed) return;
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGKILL');
      }
    }, KILL_GRACE_MS);
  }

  /**
   * Check if the MCP config file has been modified since the process was spawned.
   * This happens when start-chrome.sh activates chrome-devtools MCP.
   */
  private mcpConfigChanged(pp: PersistentProcess): boolean {
    // Also check for explicit signal file from start-chrome.sh
    const signalFile = path.join(pp.sessionDir, '.mcp-changed');
    if (fs.existsSync(signalFile)) return true;

    const mcpConfigPath = path.join(pp.sessionDir, 'mcp-servers.json');
    try {
      const stat = fs.statSync(mcpConfigPath);
      if (pp.mcpConfigMtime === undefined) {
        // Config file was created after spawn — record mtime, don't trigger respawn.
        // This happens on first message when mcp-servers.json is written after process start.
        pp.mcpConfigMtime = stat.mtimeMs;
        return false;
      }
      return stat.mtimeMs !== pp.mcpConfigMtime;
    } catch {
      return false;
    }
  }

  /**
   * Persist sessionId mapping to disk for crash recovery.
   */
  private saveState(): void {
    try {
      const data: Record<string, string> = {};
      for (const [key, id] of this.savedSessionIds) {
        data[key] = id;
      }
      fs.writeFileSync(this.statePath, JSON.stringify(data, null, 2));
    } catch (err) {
      this.logger.warn({ err }, 'Failed to save process pool state');
    }
  }

  /**
   * Load sessionId mapping from disk (for bot restart recovery).
   */
  private loadState(): void {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = fs.readFileSync(this.statePath, 'utf-8');
        const data = JSON.parse(raw) as Record<string, string>;
        for (const [key, id] of Object.entries(data)) {
          this.savedSessionIds.set(key, id);
        }
        this.logger.info({ count: this.savedSessionIds.size }, 'Loaded process pool state');
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to load process pool state');
    }
  }
}
