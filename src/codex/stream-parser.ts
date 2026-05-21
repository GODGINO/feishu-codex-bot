import type { CodexEvent, CodexProgressKind } from './types.js';

/**
 * Streaming parser for `codex exec --json` output. Accumulates partial lines,
 * parses each complete line as JSON, and emits CodexEvent objects.
 *
 * Adapted from Chat-Codex's `src/codex/exec-codex-adapter.ts::parseExecJsonLine`
 * but simplified — Sigma only needs the event types it actually consumes
 * downstream (no approval requests, no plan steps, no goal updates).
 */
export class CodexStreamParser {
  private buffer = '';
  onEvent: ((ev: CodexEvent) => void) | null = null;

  feed(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.parseLine(line);
    }
  }

  flush(): void {
    const tail = this.buffer.trim();
    this.buffer = '';
    if (tail) this.parseLine(tail);
  }

  private parseLine(line: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // codex sometimes prints non-JSON banner lines; ignore
    }
    const event = this.toEvent(parsed);
    if (event && this.onEvent) this.onEvent(event);
  }

  private toEvent(parsed: any): CodexEvent | undefined {
    const t = parsed?.type;

    if (t === 'thread.started' && parsed.thread_id) {
      return { type: 'thread.started', threadId: parsed.thread_id };
    }
    if (t === 'turn.started') {
      return { type: 'turn.started' };
    }
    if (t === 'turn.completed' && parsed.usage) {
      const u = parsed.usage;
      return {
        type: 'turn.completed',
        usage: {
          inputTokens: u.input_tokens ?? 0,
          cachedInputTokens: u.cached_input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          reasoningOutputTokens: u.reasoning_output_tokens ?? 0,
        },
      };
    }
    if (t === 'turn.failed') {
      return { type: 'turn.failed', error: parsed.error?.message ?? 'codex turn failed' };
    }
    if (t === 'error') {
      return { type: 'turn.failed', error: parsed.message ?? 'codex exec error' };
    }
    if ((t === 'codex_thinking' || t === 'reasoning') && (parsed.text || parsed.summary || parsed.summary_text)) {
      return {
        type: 'assistant.progress',
        text: parsed.text ?? parsed.summary ?? parsed.summary_text ?? '',
        kind: 'reasoning',
      };
    }
    if (t === 'item.completed' || t === 'item.started' || t === 'item.updated') {
      const item = parsed.item;
      if (!item) return undefined;
      const itemType = item.type ?? item.item_type;
      if (t === 'item.completed' && (itemType === 'agent_message' || itemType === 'assistant_message') && item.text) {
        return { type: 'assistant.completed', text: item.text };
      }
      const progress = progressFromItem(t, item);
      if (progress) {
        return { type: 'assistant.progress', text: progress.text, kind: progress.kind };
      }
    }
    return undefined;
  }
}

function progressFromItem(eventType: string, item: any): { text: string; kind: CodexProgressKind } | undefined {
  const itemType = item.type ?? item.item_type;

  if ((itemType === 'reasoning' || itemType === 'thinking') && eventType === 'item.completed') {
    const text = item.text ?? item.summary_text ?? textFromSummary(item.summary);
    return text ? { text, kind: 'reasoning' } : undefined;
  }
  if (itemType === 'command_execution' && eventType === 'item.started' && item.command) {
    return { text: `执行命令: ${item.command}`, kind: 'command' };
  }
  if (itemType === 'command_execution' && eventType === 'item.completed' && item.command) {
    const status = item.status === 'failed' || item.exit_code ? '失败' : '完成';
    return { text: `命令${status}: ${item.command}`, kind: 'command' };
  }
  if (itemType === 'file_change' && eventType === 'item.completed' && item.changes?.length) {
    const paths = item.changes.map((c: any) => c.path).filter(Boolean).slice(0, 5).join(', ');
    return paths ? { text: `文件变更: ${paths}`, kind: 'file_change' } : undefined;
  }
  if (itemType === 'mcp_tool_call' && eventType === 'item.started') {
    return { text: `调用工具: ${[item.server, item.tool].filter(Boolean).join('/')}`, kind: 'tool' };
  }
  if (itemType === 'web_search' && eventType === 'item.started' && item.query) {
    return { text: `搜索: ${item.query}`, kind: 'search' };
  }
  if ((itemType === 'todo_list' || itemType === 'plan_update') && item.items?.length) {
    const active = item.items.find((todo: any) => !todo.completed)?.text ?? item.items.at(-1)?.text;
    return active ? { text: `计划: ${active}`, kind: 'todo' } : undefined;
  }
  return undefined;
}

function textFromSummary(summary: any): string | undefined {
  if (!Array.isArray(summary)) return undefined;
  const text = summary
    .map((entry: any) => (typeof entry === 'string' ? entry : entry?.text))
    .filter(Boolean)
    .join('\n')
    .trim();
  return text || undefined;
}
