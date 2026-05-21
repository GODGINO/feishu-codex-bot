/**
 * Codex CLI integration — types shared between parser, runner, and config writer.
 *
 * Mirrors a subset of the JSONL events emitted by `codex exec --json`, observed
 * empirically via the P2 spike (2026-05-21). See MIGRATION_PLAN.md for the full
 * event schema documentation.
 */

export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export type CodexProgressKind =
  | 'reasoning'
  | 'todo'
  | 'search'
  | 'file_change'
  | 'command'
  | 'tool'
  | 'other';

/** Internal event emitted by the parser; consumed by the runner callbacks. */
export type CodexEvent =
  | { type: 'thread.started'; threadId: string }
  | { type: 'turn.started' }
  | { type: 'assistant.progress'; text: string; kind: CodexProgressKind }
  | { type: 'assistant.completed'; text: string }
  | { type: 'turn.completed'; usage: CodexUsage }
  | { type: 'turn.failed'; error: string };

export interface CodexRunCallbacks {
  /** First time the parser sees thread.started — capture the thread_id for resume. */
  onThreadStarted?: (threadId: string) => void;
  /** Intermediate progress (reasoning, tool calls, file changes). */
  onProgress?: (text: string, kind: CodexProgressKind) => void;
  /** Final assistant message text (the user-visible reply). */
  onAssistantCompleted?: (text: string) => void;
  /** Turn finished successfully with usage stats. */
  onUsage?: (usage: CodexUsage) => void;
  /** Turn failed — error is the codex-side message. */
  onError?: (error: string) => void;
}

export interface CodexRunResult {
  /** The complete assistant message text (concatenated from assistant.completed events). */
  fullText: string;
  /** The codex thread_id (UUID) for this session — store this to resume later. */
  threadId?: string;
  /** Final token usage. May be missing on failed turns. */
  usage?: CodexUsage;
  /** If the turn failed, this is the error message. */
  error?: string;
  /** The model that was used (e.g. "gpt-5.5"). */
  model?: string;
}

/** Per-session config that influences the spawned codex CLI command. */
export interface CodexSpawnConfig {
  /** Absolute path to a per-session CODEX_HOME directory. Contains auth.json, config.toml, AGENTS.md. */
  codexHome: string;
  /** Working directory passed via --cd. Usually the session dir. */
  cwd: string;
  /** Model slug. Defaults to "gpt-5.5" (the highest available for ChatGPT Plus). */
  model?: string;
  /** Existing thread_id to resume (skip if creating a new thread). */
  resumeThreadId?: string;
  /** Path to the codex binary. Defaults to `codex` on PATH. */
  codexPath?: string;
}
