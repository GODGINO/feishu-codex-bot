import { spawn } from 'node:child_process';
import { CodexStreamParser } from './stream-parser.js';
import type { CodexEvent, CodexRunCallbacks, CodexRunResult, CodexSpawnConfig } from './types.js';

/**
 * Run a single codex exec turn. Spawns `codex exec --json` (or `codex exec
 * resume --json` if resumeThreadId is provided), streams the JSONL output
 * through the parser, and resolves with the aggregated final result.
 *
 * For the first iteration this is a one-shot runner (one process per turn).
 * Future iterations may switch to a persistent `codex app-server` for lower
 * spawn overhead and richer event support (cancellation, mid-turn steering).
 */
export async function runCodexTurn(
  prompt: string,
  config: CodexSpawnConfig,
  callbacks: CodexRunCallbacks = {},
): Promise<CodexRunResult> {
  const args = buildArgs(prompt, config);
  const codexPath = config.codexPath ?? 'codex';

  return new Promise<CodexRunResult>((resolve, reject) => {
    const child = spawn(codexPath, args, {
      cwd: config.cwd,
      env: {
        ...process.env,
        CODEX_HOME: config.codexHome,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const parser = new CodexStreamParser();
    const result: CodexRunResult = {
      fullText: '',
      threadId: config.resumeThreadId,
      model: config.model ?? 'gpt-5.5',
    };

    parser.onEvent = (ev: CodexEvent) => {
      switch (ev.type) {
        case 'thread.started':
          result.threadId = ev.threadId;
          callbacks.onThreadStarted?.(ev.threadId);
          break;
        case 'assistant.progress':
          callbacks.onProgress?.(ev.text, ev.kind);
          break;
        case 'assistant.completed':
          // Multiple agent_message items may stream within one turn; concatenate.
          result.fullText += (result.fullText ? '\n\n' : '') + ev.text;
          callbacks.onAssistantCompleted?.(ev.text);
          break;
        case 'turn.completed':
          result.usage = ev.usage;
          callbacks.onUsage?.(ev.usage);
          break;
        case 'turn.failed':
          result.error = ev.error;
          callbacks.onError?.(ev.error);
          break;
      }
    };

    child.stdout?.on('data', (chunk) => parser.feed(chunk));
    // codex prints banner text ("Reading additional input from stdin...") to
    // stderr — not actually an error, just informational. Ignore it for now.
    child.stderr?.on('data', () => {});

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      parser.flush();
      if (code !== 0 && !result.error) {
        result.error = `codex exited with code ${code}`;
      }
      resolve(result);
    });

    // Prompt is passed as the last positional arg; no stdin needed.
    child.stdin?.end();
  });
}

function buildArgs(prompt: string, config: CodexSpawnConfig): string[] {
  const args = ['exec'];
  if (config.resumeThreadId) {
    args.push('resume');
  }
  args.push('--json', '--skip-git-repo-check');
  if (config.model) {
    args.push('-c', `model="${config.model}"`);
  }
  if (config.resumeThreadId) {
    args.push(config.resumeThreadId);
  } else {
    args.push('--cd', config.cwd);
  }
  args.push(prompt);
  return args;
}
