import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';
import type { Config } from '../config.js';
import { ProcessPool, type SendOptions, type UnsolicitedResultCallback, type ProgressCallback, type TextStreamCallback, type ToolStreamCallback, type ThinkingStreamCallback, type SubagentStreamCallback } from './process-pool.js';

export interface ImageAttachment {
  base64: string;
  mediaType: string;
}

export interface RunOptions {
  sessionKey: string;
  message: string;
  sessionDir: string;
  sessionId?: string;           // Ignored — ProcessPool manages sessionIds internally
  systemPrompt?: string;        // Ignored — system prompt set once at process spawn
  abortSignal?: AbortSignal;
  images?: ImageAttachment[];
}

export interface RunResult {
  fullText: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  peakCallInputTokens?: number;
  peakCallCacheReadTokens?: number;
  peakCallCacheCreationTokens?: number;
  model?: string;
  error?: string;
}

export class ClaudeRunner {
  readonly pool: ProcessPool;

  constructor(
    private config: Config,
    private logger: Logger,
    sessionsDir: string,
  ) {
    this.pool = new ProcessPool(config, sessionsDir, logger);
  }

  /**
   * Send a message to the persistent Claude Code process for a session.
   * The process is spawned on first call and reused for subsequent calls.
   */
  async run(opts: RunOptions): Promise<RunResult> {
    this.logger.info(
      { sessionKey: opts.sessionKey, sessionDir: opts.sessionDir, hasImages: !!opts.images?.length },
      'Sending message to Claude process',
    );

    try {
      const result = await this.pool.send({
        sessionKey: opts.sessionKey,
        sessionDir: opts.sessionDir,
        message: opts.message,
        images: opts.images,
        abortSignal: opts.abortSignal,
      });

      // MCP config changed during the run (e.g. start-chrome.sh added chrome-devtools).
      // Just clean up the signal file. New tools will be available on next user message
      // (process-pool detects mcpConfigChanged and respawns with --resume).
      const mcpSignal = path.join(opts.sessionDir, '.mcp-changed');
      if (fs.existsSync(mcpSignal)) {
        try { fs.unlinkSync(mcpSignal); } catch { /* ignore */ }
      }

      // "Rate limit" — wait and retry up to 3 times to stagger burst
      if (result.error && /rate limit/i.test(result.error)) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          const waitMs = attempt * 5000;
          this.logger.warn({ sessionKey: opts.sessionKey, attempt, waitMs }, 'Rate limit hit, waiting before retry');
          await new Promise(r => setTimeout(r, waitMs));
          try {
            const retryResult = await this.pool.send({
              sessionKey: opts.sessionKey,
              sessionDir: opts.sessionDir,
              message: opts.message,
              images: opts.images,
              abortSignal: opts.abortSignal,
            });
            if (!retryResult.error || !/rate limit/i.test(retryResult.error)) {
              return retryResult;
            }
          } catch { /* continue retrying */ }
        }
        // All retries failed, return original error
      }

      // "No conversation found" — invalid resume sessionId, reset and retry fresh.
      if (result.error && /no conversation found/i.test(result.error)) {
        this.logger.warn({ sessionKey: opts.sessionKey }, 'Invalid session ID, resetting and retrying fresh');
        this.pool.reset(opts.sessionKey);
        try {
          const retryResult = await this.pool.send({
            sessionKey: opts.sessionKey,
            sessionDir: opts.sessionDir,
            message: opts.message,
            images: opts.images,
            abortSignal: opts.abortSignal,
          });
          return retryResult;
        } catch (retryErr: any) {
          return { fullText: '', error: retryErr.message || 'Retry failed after session reset' };
        }
      }

      // "Could not process image" or "Prompt is too long" — compact context and retry.
      if (result.error && (/prompt is too long/i.test(result.error) || /could not process image/i.test(result.error))) {
        this.logger.warn({ sessionKey: opts.sessionKey }, 'Prompt too long, compacting context and retrying');
        try {
          // Send /compact to trigger Claude Code's built-in context compression.
          // The process is still alive — /compact is a slash command recognized in stream-json.
          const compactResult = await this.pool.send({
            sessionKey: opts.sessionKey,
            sessionDir: opts.sessionDir,
            message: '/compact',
          });

          // Check if compaction itself failed
          if (compactResult.error) {
            throw new Error(`Compact returned error: ${compactResult.error}`);
          }

          this.logger.info({ sessionKey: opts.sessionKey }, 'Context compacted, retrying original message');
          // Retry original message with compacted context
          const retryResult = await this.pool.send({
            sessionKey: opts.sessionKey,
            sessionDir: opts.sessionDir,
            message: opts.message,
            images: opts.images,
            abortSignal: opts.abortSignal,
          });
          return retryResult;
        } catch (compactErr: any) {
          this.logger.error({ err: compactErr, sessionKey: opts.sessionKey }, 'Compact failed, resetting session');
          // Compaction failed — fall back to full reset (loses context)
          this.pool.reset(opts.sessionKey);
          try {
            const retryResult = await this.pool.send({
              sessionKey: opts.sessionKey,
              sessionDir: opts.sessionDir,
              message: opts.message,
              images: opts.images,
              abortSignal: opts.abortSignal,
            });
            return retryResult;
          } catch (resetErr: any) {
            return { fullText: '', error: resetErr.message || 'Claude process failed after reset' };
          }
        }
      }

      return result;
    } catch (err: any) {
      // "busy" means another message is already being processed — do NOT reset (would kill it)
      if (err.message?.includes('is busy')) {
        this.logger.warn({ sessionKey: opts.sessionKey }, 'Process busy, not retrying');
        return { fullText: '', error: err.message };
      }

      // If aborted via /stop, don't retry — just propagate the error
      if (opts.abortSignal?.aborted) {
        this.logger.info({ sessionKey: opts.sessionKey }, 'Task was aborted, not retrying');
        throw err;
      }

      this.logger.error({ err, sessionKey: opts.sessionKey }, 'Claude process error, retrying with fresh process');

      // On error (process crashed), retry once with a clean start (no --resume)
      this.pool.reset(opts.sessionKey);
      try {
        const result = await this.pool.send({
          sessionKey: opts.sessionKey,
          sessionDir: opts.sessionDir,
          message: opts.message,
          images: opts.images,
          abortSignal: opts.abortSignal,
        });
        return result;
      } catch (retryErr: any) {
        return {
          fullText: '',
          error: retryErr.message || 'Claude process failed',
        };
      }
    }
  }

  /**
   * Abort a specific session's process (/stop command).
   */
  abort(sessionKey: string): void {
    this.pool.abort(sessionKey);
  }

  /**
   * Reset a session (/new command) — kill process and clear sessionId.
   * Next message spawns fresh without --resume = clean context.
   */
  reset(sessionKey: string): void {
    this.pool.reset(sessionKey);
  }

  /**
   * Respawn a session (e.g. model change) — kill process but keep sessionId.
   * Next message spawns with --resume = same context, new config.
   */
  respawn(sessionKey: string): void {
    this.pool.respawn(sessionKey);
  }

  /**
   * Kill all processes (shutdown).
   */
  killAll(): void {
    this.pool.killAll();
  }

  /**
   * Get the saved Claude sessionId for a sessionKey (for /并行 transcript sharing).
   */
  getSavedSessionId(sessionKey: string): string | null {
    return this.pool.getSavedSessionId(sessionKey);
  }

  /**
   * Pre-register a Claude sessionId for a sessionKey before its first spawn.
   * Used by /并行 so the fork shares the parent's transcript via `--resume`.
   */
  setSavedSessionId(sessionKey: string, sessionId: string): void {
    this.pool.setSavedSessionId(sessionKey, sessionId);
  }

  /**
   * Register callback for unsolicited results (background agent completion).
   * Called when Claude emits output without a pending send() request.
   */
  onUnsolicitedResult(callback: UnsolicitedResultCallback): void {
    this.pool.onUnsolicitedResult(callback);
  }

  /**
   * Register callback for progress events (tool_use in stream).
   */
  onProgress(callback: ProgressCallback): void {
    this.pool.onProgress(callback);
  }

  /**
   * Register/unregister callback for text streaming events (per-session).
   */
  onTextStream(sessionKey: string, callback: TextStreamCallback | undefined): void {
    this.pool.onTextStream(sessionKey, callback);
  }

  /**
   * Register/unregister callback for tool call stream events (per-session).
   */
  onToolStream(sessionKey: string, callback: ToolStreamCallback | undefined): void {
    this.pool.onToolStream(sessionKey, callback);
  }

  onThinkingStream(sessionKey: string, callback: ThinkingStreamCallback | undefined): void {
    this.pool.onThinkingStream(sessionKey, callback);
  }

  /**
   * Register/unregister persistent callback for subagent lifecycle events.
   */
  onSubagentStream(sessionKey: string, callback: SubagentStreamCallback | undefined): void {
    this.pool.onSubagentStream(sessionKey, callback);
  }

  /**
   * Get the timestamp of the last stdout activity for a session.
   */
  getLastActivity(sessionKey: string): number {
    return this.pool.getLastActivity(sessionKey);
  }

  /**
   * Number of currently busy processes.
   */
  get activeCount(): number {
    return this.pool.activeCount;
  }
}
