/**
 * Parses stream-json output from `claude -p --output-format stream-json`.
 * Each line is a JSON object with a `type` field.
 */

export interface ParseResult {
  text?: string;
  thinking?: string;
  sessionId?: string;
  done?: boolean;
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  // Single-call peak (main agent's largest LLM call in this turn) — used for ctx%
  // so the percentage reflects actual window pressure, not agent-loop aggregates.
  peakCallInputTokens?: number;
  peakCallCacheReadTokens?: number;
  peakCallCacheCreationTokens?: number;
  error?: string;
  toolUse?: { name: string; input?: string; toolUseId?: string };
  toolResult?: { toolUseId: string; isError?: boolean };
  subagentStart?: { taskId: string; description: string; toolUseId?: string; taskType?: string };
  subagentProgress?: { taskId: string; toolName: string; description: string; toolUseId?: string };
  subagentEnd?: { taskId: string; status: 'completed' | 'stopped'; summary?: string; toolUseId?: string };
}

/** Live usage snapshot (read during streaming before `result` event arrives). */
export interface LiveUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  peakCallInputTokens: number;
  peakCallCacheReadTokens: number;
  peakCallCacheCreationTokens: number;
}

export class StreamParser {
  private _sessionId: string | undefined;
  private _fullText = '';
  // Per-turn peak single-call prompt size. Each `assistant` event carries that LLM
  // call's own usage; the max across them approximates "largest context any one call
  // had to carry" — which is what determines whether the next turn will fit.
  private _peakCallUsage: { input: number; cacheRead: number; cacheCreation: number; output: number } | undefined;
  // Running totals across every `assistant` event in the turn (for footer's
  // "N tokens (in:X / out:Y)" during streaming; `result` event overrides at end).
  private _cumUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  get fullText(): string {
    return this._fullText;
  }

  /** Snapshot of usage accumulated so far this turn — for live footer rendering. */
  get liveUsage(): LiveUsage {
    return {
      inputTokens: this._cumUsage.input,
      outputTokens: this._cumUsage.output,
      cacheReadTokens: this._cumUsage.cacheRead,
      cacheCreationTokens: this._cumUsage.cacheCreation,
      peakCallInputTokens: this._peakCallUsage?.input || 0,
      peakCallCacheReadTokens: this._peakCallUsage?.cacheRead || 0,
      peakCallCacheCreationTokens: this._peakCallUsage?.cacheCreation || 0,
    };
  }

  /**
   * Reset parser state for a new conversation turn (persistent process reuse).
   */
  reset(): void {
    this._fullText = '';
    this._peakCallUsage = undefined;
    this._cumUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    // Keep _sessionId — it stays the same for the lifetime of the process
  }

  parseLine(line: string): ParseResult {
    if (!line.trim()) return {};

    try {
      const msg = JSON.parse(line);

      // System message: extract session_id and detect subagent progress
      if (msg.type === 'system') {
        const result: ParseResult = {};
        if (msg.session_id && !this._sessionId) {
          this._sessionId = msg.session_id;
          result.sessionId = msg.session_id;
        }
        // task_started = subagent launched
        // Don't set result.toolUse here — the assistant message's tool_use block
        // already triggers addToolCall. Setting it here would duplicate the Agent entry.
        if (msg.subtype === 'task_started') {
          result.subagentStart = {
            taskId: msg.task_id,
            description: msg.description || '',
            toolUseId: msg.tool_use_id,
            taskType: msg.task_type || '',
          };
        }
        // task_progress = subagent tool call step
        if (msg.subtype === 'task_progress' && msg.last_tool_name) {
          result.subagentProgress = {
            taskId: msg.task_id,
            toolName: msg.last_tool_name,
            description: msg.description || '',
            toolUseId: msg.tool_use_id,
          };
        }
        // task_notification = subagent completed/stopped
        if (msg.subtype === 'task_notification' && msg.status) {
          result.subagentEnd = {
            taskId: msg.task_id,
            status: msg.status,
            summary: msg.summary,
            toolUseId: msg.tool_use_id,
          };
        }
        return result;
      }

      // Assistant message: contains text content and/or tool_use blocks
      if (msg.type === 'assistant') {
        const text = this.extractText(msg.message?.content);
        const thinking = this.extractThinking(msg.message?.content);
        const toolUse = this.extractToolUse(msg.message?.content);
        const toolResult = this.extractToolResult(msg.message?.content);
        const result: ParseResult = {};
        if (text) { this._fullText += text; result.text = text; }
        if (thinking) result.thinking = thinking;
        if (toolUse) result.toolUse = toolUse;
        if (toolResult) result.toolResult = toolResult;
        // Capture per-call usage — each `assistant` event carries the usage of one
        // specific LLM call in the turn's tool loop.
        const u = msg.message?.usage;
        if (u) {
          const callPrompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          const peakPrompt = this._peakCallUsage
            ? this._peakCallUsage.input + this._peakCallUsage.cacheRead + this._peakCallUsage.cacheCreation
            : 0;
          if (callPrompt >= peakPrompt) {
            this._peakCallUsage = {
              input: u.input_tokens || 0,
              cacheRead: u.cache_read_input_tokens || 0,
              cacheCreation: u.cache_creation_input_tokens || 0,
              output: u.output_tokens || 0,
            };
          }
          this._cumUsage.input += u.input_tokens || 0;
          this._cumUsage.output += u.output_tokens || 0;
          this._cumUsage.cacheRead += u.cache_read_input_tokens || 0;
          this._cumUsage.cacheCreation += u.cache_creation_input_tokens || 0;
        }
        return result;
      }

      // User message: contains tool_result blocks (after tool execution completes)
      if (msg.type === 'user') {
        const toolResult = this.extractToolResult(msg.message?.content);
        if (toolResult) {
          return { toolResult };
        }
        return {};
      }

      // Result message: final output
      if (msg.type === 'result') {
        const result: ParseResult = { done: true };
        if (msg.session_id && !this._sessionId) {
          this._sessionId = msg.session_id;
          result.sessionId = msg.session_id;
        }
        if (msg.result) {
          result.text = msg.result;
          // Only use result text if nothing was accumulated during streaming.
          // In multi-turn (agentic) responses, _fullText has the complete output
          // while msg.result may only contain the last turn's summary.
          if (!this._fullText) {
            this._fullText = msg.result;
          }
        }
        if (msg.total_cost_usd != null) result.costUsd = msg.total_cost_usd;
        if (msg.duration_ms != null) result.durationMs = msg.duration_ms;
        if (msg.usage) {
          result.inputTokens = msg.usage.input_tokens || 0;
          result.outputTokens = msg.usage.output_tokens || 0;
          result.cacheReadTokens = msg.usage.cache_read_input_tokens || 0;
          result.cacheCreationTokens = msg.usage.cache_creation_input_tokens || 0;
        }
        // Override the cache/prompt numbers with the peak SINGLE-CALL usage so that
        // ctx% reflects how full the window was for the largest LLM call (the main
        // agent's final call), not the turn-wide sum (which over-counts agent loops).
        if (this._peakCallUsage) {
          result.peakCallInputTokens = this._peakCallUsage.input;
          result.peakCallCacheReadTokens = this._peakCallUsage.cacheRead;
          result.peakCallCacheCreationTokens = this._peakCallUsage.cacheCreation;
        }
        if (msg.is_error) {
          const errorsArray = Array.isArray(msg.errors) ? msg.errors.join('; ') : '';
          result.error = msg.result || errorsArray || 'Unknown error';
        }
        return result;
      }

      return {};
    } catch {
      // Non-JSON line, ignore
      return {};
    }
  }

  private extractToolUse(content: unknown): { name: string; input?: string; toolUseId?: string } | undefined {
    if (!Array.isArray(content)) return undefined;
    for (const block of content) {
      if (block.type === 'tool_use' && block.name) {
        let input: string | undefined;
        if (typeof block.input === 'string') {
          input = block.input;
        } else if (block.input && typeof block.input === 'object') {
          const inputObj = block.input as Record<string, unknown>;
          // Agent tool: use description field (prompt is too long and all look the same)
          if (block.name === 'Agent' && typeof inputObj.description === 'string') {
            input = inputObj.description.slice(0, 200);
          } else {
            const vals = Object.values(inputObj);
            input = vals.filter(v => typeof v === 'string').join(' ').slice(0, 200);
          }
        }
        return { name: block.name, input, toolUseId: block.id };
      }
    }
    return undefined;
  }

  private extractToolResult(content: unknown): { toolUseId: string; isError?: boolean } | undefined {
    if (!Array.isArray(content)) return undefined;
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        return { toolUseId: block.tool_use_id, isError: block.is_error };
      }
    }
    return undefined;
  }

  /** Extract extended thinking block text from assistant content. */
  private extractThinking(content: unknown): string {
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    for (const block of content) {
      if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        parts.push(block.thinking);
      }
    }
    return parts.join('\n\n');
  }

  private extractText(content: unknown): string {
    if (!content) return '';

    // content can be a string or array of content blocks
    if (typeof content === 'string') return content;

    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          parts.push(block.text);
        }
      }
      return parts.join('');
    }

    return '';
  }
}
